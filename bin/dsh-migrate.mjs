#!/usr/bin/env node
// dsh-migrate — 把 DSH 配置打包成自描述 bundle，换机器还原。
// 单文件、零依赖、Linux / macOS / Windows 通用（只要求 Node ≥ 20 和系统自带 tar）。
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "0.1.0";
const FORMAT = "dsh-migrate/2";
const HOME = os.homedir();
let dshHomeOverride = null;
const DSH_HOME = () => dshHomeOverride || process.env.DSH_HOME || path.join(HOME, ".dsh");
const PROFILE = () => process.env.DSH_PROFILE || "web";

const EXCLUDES = new Set(["node_modules", "__pycache__", ".git"]);
const PROFILE_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];
const STATE_ITEMS = ["skins", "skin-center-active.json", "pet.json", "dsh-market", "storages/workspace.json"];
const SKILL_ROOTS = () => [
  ["dsh", path.join(DSH_HOME(), "skills"), "$DSH_HOME/skills"],
  ["agents", path.join(process.env.DSH_AGENTS_HOME || path.join(HOME, ".agents"), "skills"), "~/.agents/skills"],
  ["codex", path.join(process.env.DSH_CODEX_HOME || path.join(HOME, ".codex"), "skills"), "~/.codex/skills"],
  ["claude", path.join(process.env.DSH_CLAUDE_HOME || path.join(HOME, ".claude"), "skills"), "~/.claude/skills"],
];

// ---------------------------------------------------------------- utils
class CliError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}
const die = (msg, code = 2) => { throw new CliError(msg, code); };
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows EPERM */ } };
const say = (label, value = "") => console.log(`  ${label.padEnd(44)} ${value}`);
const posix = (p) => p.split(path.sep).join("/");

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

function walk(root, { filesOnly = true } = {}) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
      else if (!filesOnly && entry.isSymbolicLink()) out.push(full);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out.sort();
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDES.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isSymbolicLink()) {
      // 包内不携带符号链接：导入端会拒绝，避免"白名单"被链接绕过
      console.warn(`  skip symlink: ${from}`);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      try { fs.chmodSync(to, fs.statSync(from).mode & 0o777); } catch { /* windows */ }
    }
  }
}

const tar = (args, opts = {}) => execFileSync("tar", args, { encoding: "utf8", ...opts });
const tarList = (file) => tar(["-tzf", file]).split(/\r?\n/).filter(Boolean);
const tarExtract = (file, dest) => tar(["-xzf", file, "-C", dest]);

function assertSafeArchive(file) {
  for (const raw of tarList(file)) {
    const normalized = raw.replace(/\\/g, "/"); // Windows 归档可能用反斜杠
    if (normalized.startsWith("/") || normalized.startsWith("//") ||
        /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
      die(`refusing to extract: unsafe path in archive\n  ${raw}`, 2);
    }
  }
  // 链接成员（l=符号链接，h=硬链接）目标可指向包外，直接拒绝
  const verbose = tar(["-tvzf", file]).split(/\r?\n/).filter(Boolean);
  const link = verbose.find((line) => /^[lh]/.test(line));
  if (link) die(`refusing to extract: archive contains a link\n  ${link}`, 2);
}

function readMeta(root) {
  const file = path.join(root, "dsh-migrate", "meta.env");
  if (!fs.existsSync(file)) die("not a dsh-migrate bundle (no dsh-migrate/meta.env)", 2);
  return Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

function skillDest(tag) {
  switch (tag) {
    case "agents": return path.join(HOME, ".agents", "skills");
    case "codex": return path.join(HOME, ".codex", "skills");
    case "claude": return path.join(HOME, ".claude", "skills");
    case "dsh": return path.join(DSH_HOME(), "skills");
    default: return null;
  }
}

// ---------------------------------------------------------------- export
function exportBundle(opts) {
  const src = opts.dshHome;
  dshHomeOverride = src;
  if (!fs.existsSync(src)) die(`DSH_HOME not found: ${src}`, 1);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-migrate-"));
  try {
    const payload = path.join(stage, "payload");
    const dshHomeOut = path.join(payload, "dsh-home");
    fs.mkdirSync(dshHomeOut, { recursive: true });
    fs.mkdirSync(path.join(payload, "home"), { recursive: true });
    fs.mkdirSync(path.join(stage, "dsh-migrate"), { recursive: true });

    // 1. profile 配置
    const profilesDir = path.join(src, "profiles");
    const profiles = fs.existsSync(profilesDir)
      ? fs.readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : [];
    for (const name of profiles) {
      const dest = path.join(dshHomeOut, "profiles", name);
      fs.mkdirSync(dest, { recursive: true });
      for (const file of PROFILE_FILES) {
        const from = path.join(profilesDir, name, file);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, file));
      }
      const market = path.join(profilesDir, name, ".dsh-market", "state.json");
      if (fs.existsSync(market)) {
        fs.mkdirSync(path.join(dest, ".dsh-market"), { recursive: true });
        fs.copyFileSync(market, path.join(dest, ".dsh-market", "state.json"));
      }
      if (opts.withSecrets) {
        const npmrc = path.join(profilesDir, name, ".npmrc");
        if (fs.existsSync(npmrc)) fs.copyFileSync(npmrc, path.join(dest, ".npmrc"));
      }
      say(`profiles/${name}`, `${walk(dest).length} files`);
    }

    // 2. 外观与状态
    for (const item of STATE_ITEMS) {
      const from = path.join(src, item);
      if (!fs.existsSync(from)) continue;
      const to = path.join(dshHomeOut, item);
      if (fs.statSync(from).isDirectory()) copyTree(from, to);
      else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
      say(item, "copied");
    }

    // 3. skills
    for (const [tag, dir] of SKILL_ROOTS()) {
      if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) continue;
      const dest = path.join(payload, "home", tag);
      copyTree(dir, dest);
      say(`skills/${tag}`, `${walk(dest).length} files`);
    }

    // 4. 凭据 / 会话（默认不带）
    if (opts.withSecrets) {
      const cred = path.join(src, ".credentials.yaml");
      if (fs.existsSync(cred)) {
        fs.copyFileSync(cred, path.join(dshHomeOut, ".credentials.yaml"));
        say(".credentials.yaml", "included (keep private)");
      }
    }
    if (opts.withSessions) {
      const sessions = path.join(src, "sessions");
      if (fs.existsSync(sessions)) {
        copyTree(sessions, path.join(dshHomeOut, "sessions"));
        say("sessions", "included");
      }
    }

    // 5. meta.env
    fs.writeFileSync(path.join(stage, "dsh-migrate", "meta.env"), [
      `format=${FORMAT}`,
      `tool_version=${VERSION}`,
      `profile=${PROFILE()}`,
      `created=${new Date().toISOString()}`,
      `host=${os.hostname()}`,
      `dsh_version=${dshVersion() ?? "unknown"}`,
      `node_version=${process.version}`,
      `source_dsh_home=${src}`,
      `with_secrets=${opts.withSecrets ? 1 : 0}`,
      `with_sessions=${opts.withSessions ? 1 : 0}`,
      "",
    ].join("\n"));

    // 6. 三份人读清单 + RESTORE.md
    describe(stage, path.basename(opts.out));

    // 7. 还原器副本（先落盘，纳入校验和）
    fs.copyFileSync(process.argv[1], path.join(stage, "dsh-migrate", "dsh-migrate.mjs"));

    // 8. 校验和（payload + 包根说明文件 + meta.env + 还原器）
    const manifestSources = ["payload", "RESTORE.md", "plugins.json", "skills.global.json", "skills.project.json",
      "dsh-migrate/meta.env", "dsh-migrate/dsh-migrate.mjs"]
      .filter((m) => fs.existsSync(path.join(stage, m)));
    const manifest = [];
    for (const member of manifestSources) {
      const abs = path.join(stage, member);
      const files = fs.statSync(abs).isDirectory() ? walk(abs) : [abs];
      for (const file of files) manifest.push(`${sha256(file)}  ${posix(path.relative(stage, file))}`);
    }
    manifest.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
    fs.writeFileSync(path.join(stage, "dsh-migrate", "MANIFEST.sha256"), manifest.join("\n") + "\n");

    // 9. 打包
    if (fs.existsSync(opts.out) && !opts.force) {
      die(`refusing to overwrite existing bundle: ${opts.out}\n  pass --force to replace it`, 2);
    }
    const tarMembers = ["dsh-migrate", "payload", "RESTORE.md", "plugins.json", "skills.global.json", "skills.project.json"]
      .filter((m) => fs.existsSync(path.join(stage, m)));
    tar(["-czf", opts.out, "-C", stage, ...tarMembers]);
    if (opts.withSecrets) {
      try { fs.chmodSync(opts.out, 0o600); } catch { /* windows: no-op */ }
      console.warn("  warning: bundle contains credentials; keep it private (mode 0600 where supported)");
    }
    const size = (fs.statSync(opts.out).size / 1024 / 1024).toFixed(1);
    console.log(`\nbundle: ${opts.out} (${size} MB, ${manifest.length} files)`);
    console.log(`sha256: ${sha256(opts.out)}`);

    if (opts.push) {
      try { execFileSync("scp", [opts.out, opts.push], { stdio: "inherit" }); }
      catch { die("scp failed; transfer the bundle manually", 1); }
    }
    console.log(`\nrestore on the new machine:\n  node dsh-migrate/dsh-migrate.mjs import <bundle> --apply`);
  } finally {
    cleanup(stage);
  }
}

function describe(stage, bundleName) {
  const payload = path.join(stage, "payload");
  const home = path.join(payload, "dsh-home");
  const profilesDir = path.join(home, "profiles");
  const profiles = fs.existsSync(profilesDir) ? fs.readdirSync(profilesDir).sort() : [];
  const preferred = PROFILE();
  const profile = profiles.includes(preferred) ? preferred : (profiles[0] || "web");
  const pkgPath = path.join(profilesDir, profile, "package.json");
  let pkg = { dependencies: {} };
  if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); }
    catch { console.warn("  warn: package.json is not valid JSON, continuing with no plugins"); }
  }
  const meta = readMeta(stage);

  const plugins = {
    schema: 1, profile, dsh: meta.dsh_version, node: meta.node_version,
    note: "版本以 profile/package.json + pnpm-lock.yaml 为准；本文件是人读清单。",
    plugins: Object.entries(pkg.dependencies || {}).map(([name, version]) => ({ name, version, source: "npm" })),
    install: `dsh plugin --profile ${profile} install`,
  };
  fs.writeFileSync(path.join(stage, "plugins.json"), JSON.stringify(plugins, null, 2) + "\n");

  const skills = [];
  for (const [tag, , target] of SKILL_ROOTS()) {
    const dir = path.join(payload, "home", tag);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => !n.startsWith(".")).sort()) {
      if (!fs.statSync(path.join(dir, name)).isDirectory()) continue;
      const item = { name, root: tag, target };
      const src = path.join(dir, name, ".source");
      if (fs.existsSync(src)) {
        const text = fs.readFileSync(src, "utf8");
        const get = (key) => (text.match(new RegExp(`^${key}:\\s*(.+)$`, "m")) || [])[1]?.trim() ?? null;
        item.source = get("source");
        item.ref = get("commit");
        item.path = get("path") ? path.posix.dirname(get("path")) : null;
      } else {
        item.source = null;
        item.note = "内容已随包携带；如需可复现，请补一个 git 出处";
      }
      skills.push(item);
    }
  }
  fs.writeFileSync(path.join(stage, "skills.global.json"), JSON.stringify({
    schema: 1,
    note: "全局 skills 随机器走。source 为 null 不代表丢失——内容在 payload/home 下，会一起还原。",
    counts: { total: skills.length, sourced: skills.filter((s) => s.source).length },
    skills,
  }, null, 2) + "\n");

  fs.writeFileSync(path.join(stage, "skills.project.json"), JSON.stringify({
    schema: 1,
    note: "项目级 skills 属于项目仓库（<project>/.dsh/skills、<project>/.agents/skills），不随机器迁移。",
    skills: [],
  }, null, 2) + "\n");

  const skins = fs.existsSync(path.join(home, "skins")) ? fs.readdirSync(path.join(home, "skins")).length : 0;
  fs.writeFileSync(path.join(stage, "RESTORE.md"), `# 还原（RESTORE）

插件 ${plugins.plugins.length} 个 · 全局 skill ${skills.length} 个 · 皮肤 ${skins} 个。

\`\`\`bash
tar -xzf ${bundleName}
node dsh-migrate/dsh-migrate.mjs import .            # dry-run
node dsh-migrate/dsh-migrate.mjs import . --apply
DSH_HOME="\${DSH_HOME:-$HOME/.dsh}" dsh plugin --profile ${profile} install
\`\`\`

三份清单：\`plugins.json\`、\`skills.global.json\`、\`skills.project.json\`。
包里不含 node_modules${meta.with_secrets === "1" ? "；**含凭据**（.credentials.yaml / .npmrc），请妥善保管" : "、会话、缓存、凭据"}。
`);
}

// ---------------------------------------------------------------- import
async function importBundle(opts) {
  dshHomeOverride = opts.dshHome;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-migrate-"));
  try {
    let root;
    if (opts.from) {
      const res = await fetch(opts.from);
      if (!res.ok) die(`download failed: HTTP ${res.status}`, 2);
      const file = path.join(stage, "download.tar.gz");
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      assertSafeArchive(file);
      tarExtract(file, stage);
      root = stage;
    } else if (fs.existsSync(opts.target) && fs.statSync(opts.target).isDirectory()) {
      root = path.resolve(opts.target);
    } else if (fs.existsSync(opts.target)) {
      assertSafeArchive(opts.target);
      tarExtract(opts.target, stage);
      root = stage;
    } else {
      die(`bundle not found: ${opts.target}`, 2);
    }

    const meta = readMeta(root);
    if (meta.format && meta.format !== FORMAT) die(`unsupported bundle format: ${meta.format} (expected ${FORMAT})`, 2);
    console.log("== bundle ==");
    for (const [key, value] of Object.entries(meta)) console.log(`  ${key}=${value}`);
    if (meta.tool_version && meta.tool_version !== VERSION) {
      console.log(`  note: made with dsh-migrate ${meta.tool_version}, running ${VERSION} (backward compatible)`);
    }

    console.log("\n== verify integrity ==");
    const manifestPath = path.join(root, "dsh-migrate", "MANIFEST.sha256");
    if (!fs.existsSync(manifestPath)) die("bundle is missing dsh-migrate/MANIFEST.sha256", 3);
    const lines = fs.readFileSync(manifestPath, "utf8").split("\n").filter(Boolean);
    let bad = 0;
    for (const line of lines) {
      if (line.length < 68 || !/^[0-9a-f]{64}  /.test(line)) {
        console.log(`  MALFORMED ${line.slice(0, 80)}`);
        bad++;
        continue;
      }
      const expected = line.slice(0, 64);
      const rel = line.slice(66);
      const file = path.join(root, rel);
      let actual = "missing";
      try { if (fs.lstatSync(file).isFile()) actual = sha256(file); } catch { /* missing */ }
      if (actual !== expected) { console.log(`  MISMATCH ${rel}`); bad++; }
    }
    if (bad) die(`  ${bad}/${lines.length} files failed: bundle is corrupt or was modified. Stop.`, 3);
    console.log(`  ok: ${lines.length} files`);

    const payloadRoot = path.join(root, "payload");
    if (!fs.existsSync(payloadRoot)) die("bundle has no payload/ directory", 2);
    const links = walk(payloadRoot, { filesOnly: false }).filter((f) => {
      try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; }
    });
    if (links.length) {
      die(`bundle contains symlinks, which this tool never writes:\n  ${posix(path.relative(root, links[0]))}`, 3);
    }
    const listed = new Set(lines.filter((l) => l.slice(66).startsWith("payload/")).map((l) => l.slice(66)));
    const extras = walk(payloadRoot).map((f) => posix(path.relative(root, f))).filter((f) => !listed.has(f));
    if (extras.length) {
      console.error("  files not listed in MANIFEST:");
      extras.slice(0, 10).forEach((f) => console.error(`    ${f}`));
      die("  refusing to write unverified files. Stop.", 3);
    }

    const profile = meta.profile || PROFILE();
    const dshHomeDst = opts.dshHome;
    const payloadHome = path.join(root, "payload", "dsh-home");
    if (!fs.existsSync(payloadHome)) die("bundle has no payload/dsh-home directory", 2);
    const plan = [];
    for (const rel of walk(payloadHome).map((f) => posix(path.relative(payloadHome, f)))) {
      plan.push(path.join(dshHomeDst, rel));
    }
    for (const [tag] of SKILL_ROOTS()) {
      const dir = path.join(root, "payload", "home", tag);
      if (!fs.existsSync(dir)) continue;
      for (const rel of walk(dir).map((f) => posix(path.relative(dir, f)))) plan.push(path.join(skillDest(tag), rel));
    }
    console.log("\n== plan ==");
    plan.forEach((p) => console.log(`  ${p}`));

    if (!opts.apply) { console.log("\n(dry-run) re-run with --apply to write."); return; }

    const backup = path.join(dshHomeDst,
      `.migrate-backup-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`);
    let backed = 0;
    const backups = [];
    for (const rel of walk(payloadHome).map((f) => posix(path.relative(payloadHome, f)))) {
      const file = path.join(dshHomeDst, rel);
      if (!fs.existsSync(file)) continue;
      const to = path.join(backup, "dsh-home", rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(file, to);
      backups.push(rel); backed++;
    }
    for (const [tag] of SKILL_ROOTS()) {
      const dir = path.join(root, "payload", "home", tag);
      if (!fs.existsSync(dir)) continue;
      for (const rel of walk(dir).map((f) => posix(path.relative(dir, f)))) {
        const file = path.join(skillDest(tag), rel);
        if (!fs.existsSync(file)) continue;
        const to = path.join(backup, `home-${tag}`, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(file, to);
        backed++;
      }
    }
    if (backed) console.log(`\n== backup ==\n  ${backup} (${backed} files)`);

    console.log("\n== write ==");
    copyTree(payloadHome, dshHomeDst);
    for (const [tag] of SKILL_ROOTS()) {
      const dir = path.join(root, "payload", "home", tag);
      if (!fs.existsSync(dir)) continue;
      const dest = skillDest(tag);
      copyTree(dir, dest);
      console.log(`  ok: ${dest}`);
    }

    const cred = path.join(dshHomeDst, ".credentials.yaml");
    if (fs.existsSync(cred)) { try { fs.chmodSync(cred, 0o600); } catch { /* windows */ } }

    const ws = path.join(dshHomeDst, "storages", "workspace.json");
    if (fs.existsSync(ws)) {
      try {
        const data = JSON.parse(fs.readFileSync(ws, "utf8"));
        const stale = Object.values(data.tables?.workspaces || {}).map((w) => w?.path).filter((p) => p && !fs.existsSync(p));
        if (stale.length) {
          console.log("\n== workspace paths need attention ==");
          stale.forEach((p) => console.log(`  ${p}`));
        }
      } catch { /* ignore malformed */ }
    }

    console.log(`\n== next ==\n  DSH_HOME="${dshHomeDst}" dsh plugin --profile ${profile} install\n  DSH_HOME="${dshHomeDst}" dsh web`);
  } finally {
    cleanup(stage);
  }
}

// ---------------------------------------------------------------- verify
function verifyBundle(opts) {
  const dshHome = opts.dshHome;
  dshHomeOverride = dshHome;
  let profile = PROFILE();
  let wantDsh = null;
  if (opts.bundle) {
    const meta = readMeta(path.resolve(opts.bundle));
    if (meta.profile) profile = meta.profile;
    wantDsh = meta.dsh_version;
  }

  let fails = 0;
  const ok = (m) => console.log(`  [ok]   ${m}`);
  const bad = (m) => { console.log(`  [FAIL] ${m}`); fails++; };
  const warn = (m) => console.log(`  [warn] ${m}`);

  console.log("1. dsh version");
  const current = dshVersion();
  if (!current) warn("dsh not installed");
  else if (!wantDsh || wantDsh === "unknown" || wantDsh === "null") warn(`cannot compare (local=${current}, bundle=${wantDsh || "?"})`);
  else if (current === wantDsh) ok(`dsh ${current} (matches bundle)`);
  else bad(`dsh ${current} != bundle ${wantDsh}`);

  console.log("2. profile and plugins");
  const pkgPath = path.join(dshHome, "profiles", profile, "package.json");
  if (fs.existsSync(pkgPath)) {
    let deps = null;
    try { deps = Object.keys(JSON.parse(fs.readFileSync(pkgPath, "utf8")).dependencies || {}).length; }
    catch { bad("package.json is not valid JSON"); }
    if (deps !== null) {
      ok(`package.json (${deps} dependencies)`);
      if (deps === 0) {
        warn("no plugin dependencies declared; skipping node_modules check");
      } else {
        fs.existsSync(path.join(dshHome, "profiles", profile, "node_modules"))
          ? ok("node_modules present")
          : bad(`node_modules missing: run dsh plugin --profile ${profile} install`);
      }
    }
  } else bad(`missing profiles/${profile}/package.json`);

  console.log("3. patch layer");
  const patch = path.join(dshHome, "profiles", profile, "cordis.patch.yml");
  if (fs.existsSync(patch)) {
    const entries = (fs.readFileSync(patch, "utf8").match(/^- id:/gm) || []).length;
    ok(`cordis.patch.yml (${entries} entries)`);
    if (opts.bundle) {
      const bundled = path.join(opts.bundle, "payload", "dsh-home", "profiles", profile, "cordis.patch.yml");
      if (fs.existsSync(bundled)) {
        sha256(patch) === sha256(bundled) ? ok("matches bundle") : bad("differs from bundle (local drift)");
      }
    }
  } else bad("missing cordis.patch.yml");

  console.log("4. skills");
  for (const [tag, dir] of SKILL_ROOTS()) {
    if (!fs.existsSync(dir)) { warn(`${tag}: missing (${dir})`); continue; }
    const count = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).length;
    ok(`${tag}: ${count} skills`);
  }

  console.log("5. skins");
  const skins = path.join(dshHome, "skins");
  if (fs.existsSync(skins)) {
    const count = fs.readdirSync(skins, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    let active = "-";
    try { active = JSON.parse(fs.readFileSync(path.join(dshHome, "skin-center-active.json"), "utf8")).active; } catch { /* none */ }
    ok(`${count} skins, active=${active}`);
  } else warn("no skins directory");

  console.log("6. workspaces");
  const ws = path.join(dshHome, "storages", "workspace.json");
  if (fs.existsSync(ws)) {
    try {
      const data = JSON.parse(fs.readFileSync(ws, "utf8"));
      const paths = Object.values(data.tables?.workspaces || {}).map((w) => w?.path).filter(Boolean);
      const stale = paths.filter((p) => !fs.existsSync(p));
      stale.length ? stale.forEach((p) => warn(`missing path: ${p}`)) : ok("all registered paths exist");
    } catch { warn("workspace.json is not valid JSON"); }
  } else warn("no storages/workspace.json");

  console.log(fails ? `\nFAIL: ${fails} item(s)` : "\nPASS (warnings need human review)");
  process.exitCode = fails ? 1 : 0;
}

// ---------------------------------------------------------------- cli
function dshVersion() {
  try {
    return execFileSync("dsh", ["-V"], {
      encoding: "utf8",
      shell: process.platform === "win32", // Windows 上 dsh 是 dsh.cmd
    }).trim();
  } catch { return null; }
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "-o": case "--output": opts.out = next(); break;
      case "--push": opts.push = next(); break;
      case "--dsh-home": opts.dshHome = next(); break;
      case "--from": opts.from = next(); break;
      case "--apply": opts.apply = true; break;
      case "--force": opts.force = true; break;
      case "--with-secrets": opts.withSecrets = true; break;
      case "--with-sessions": opts.withSessions = true; break;
      case "--bundle": opts.bundle = next(); break;
      case "-h": case "--help": opts.help = true; break;
      case "-v": case "--version": opts.version = true; break;
      default: opts._.push(arg);
    }
  }
  return opts;
}

const USAGE = `dsh-migrate ${VERSION} — DSH 配置迁移

  export -o <bundle.tar.gz> [--force] [--push user@host:~/] [--with-secrets] [--with-sessions]
  import <bundle.tar.gz|dir> [--apply] [--from <url>] [--dsh-home PATH]
  verify  [--bundle <dir>] [--dsh-home PATH]

环境变量：DSH_HOME（默认 ~/.dsh）、DSH_PROFILE（默认 web）`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "-v" || cmd === "--version") { console.log(VERSION); return; }
  if (cmd === "-h" || cmd === "--help") { console.log(USAGE); return; }
  const opts = parseArgs(argv.slice(1));
  opts.dshHome = opts.dshHome || DSH_HOME();
  if (opts.help) { console.log(USAGE); return; }
  if (opts.version) { console.log(VERSION); return; }

  if (cmd === "export") {
    opts.out = path.resolve(opts.out || "dsh-config.tar.gz");
    exportBundle(opts);
  } else if (cmd === "import") {
    opts.target = opts._[0];
    if (!opts.target && !opts.from) die(USAGE);
    await importBundle(opts);
  } else if (cmd === "verify") {
    verifyBundle(opts);
  } else {
    console.log(USAGE);
    process.exitCode = cmd ? 2 : 0;
  }
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exitCode = error.code;
  } else {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
});
