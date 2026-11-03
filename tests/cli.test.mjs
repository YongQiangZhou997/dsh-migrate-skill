import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "dsh-migrate.mjs");

function runAsync(args, env) {
  // 异步版本：HTTP 测试里不能用 spawnSync，会阻塞事件循环导致请求无人响应
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } },
      (error, stdout, stderr) =>
        resolve({ status: error ? (error.code ?? 1) : 0, out: `${stdout}${stderr}` }));
  });
}

function run(args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const cleanupDirs = [];
process.on("exit", () => {
  for (const dir of cleanupDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshm-"));
  cleanupDirs.push(root);
  const dshHome = path.join(root, "dsh");
  const home = path.join(root, "home");
  const profile = path.join(dshHome, "profiles", "web");

  fs.mkdirSync(path.join(profile, "node_modules", "junk"), { recursive: true });
  fs.mkdirSync(path.join(dshHome, "skills", "demo"), { recursive: true });
  fs.mkdirSync(path.join(dshHome, "skins", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(dshHome, "storages"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agents", "skills", "foo"), { recursive: true });

  fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify({
    name: "dsh-profile-web", private: true,
    dependencies: { "dsh-context": "^1.0.0" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  }));
  fs.writeFileSync(path.join(profile, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  fs.writeFileSync(path.join(profile, "cordis.yml"), "[]\n");
  fs.writeFileSync(path.join(profile, "cordis.patch.yml"), "- id: ui-theme\n  config:\n    preference: light\n");
  fs.writeFileSync(path.join(profile, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
  fs.writeFileSync(path.join(profile, "node_modules", "junk", "i.js"), "x\n");
  fs.writeFileSync(path.join(dshHome, "skins", "alpha", "skin.json"), '{"name":"alpha"}');
  fs.writeFileSync(path.join(dshHome, "skin-center-active.json"), '{"active":"alpha"}');
  fs.writeFileSync(path.join(dshHome, "storages", "workspace.json"),
    '{"tables":{"workspaces":{"x":{"path":"/old/machine"}}}}');
  fs.writeFileSync(path.join(dshHome, "skills", "demo", "SKILL.md"), "# demo\n");
  fs.writeFileSync(path.join(dshHome, "skills", "demo", ".source"),
    "source: https://github.com/acme/skills\ncommit: abc123\npath: skills/foo/SKILL.md\n");
  fs.writeFileSync(path.join(home, ".agents", "skills", "foo", "SKILL.md"), "# foo\n");

  return { root, dshHome, home, env: { HOME: home, USERPROFILE: home, DSH_HOME: dshHome } };
}

function exportBundle(fx, out) {
  const result = run(["export", "-o", out], fx.env);
  assert.equal(result.status, 0, result.out);
  return result;
}

function extract(bundle, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const result = spawnSync("tar", ["-xzf", bundle, "-C", dest], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return dest;
}

test("export produces a self-describing bundle and excludes junk", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);

  const listing = spawnSync("tar", ["-tzf", out], { encoding: "utf8" }).stdout.split(/\r?\n/);
  for (const entry of ["RESTORE.md", "plugins.json", "skills.global.json", "skills.project.json"]) {
    assert.ok(listing.includes(entry), `missing ${entry}`);
  }
  const joined = listing.join("\n");
  assert.ok(!joined.includes("node_modules"), "node_modules leaked");
  assert.ok(!joined.includes(".npmrc"), ".npmrc leaked");
  assert.ok(!joined.includes("__pycache__"), "__pycache__ leaked");

  const dest = extract(out, path.join(fx.root, "x"));
  const plugins = JSON.parse(fs.readFileSync(path.join(dest, "plugins.json"), "utf8"));
  assert.equal(plugins.plugins[0].name, "dsh-context");
  const skills = JSON.parse(fs.readFileSync(path.join(dest, "skills.global.json"), "utf8"));
  assert.equal(skills.counts.sourced, 1);
  assert.equal(skills.skills.find((s) => s.name === "demo").source, "https://github.com/acme/skills");
});

test("dry-run reports the plan and writes nothing", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  const dst = path.join(fx.root, "dst");

  const result = run(["import", dest, "--dsh-home", dst], fx.env);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /dry-run/);
  assert.ok(!fs.existsSync(path.join(dst, "profiles", "web", "package.json")));
});

test("apply restores profile, skills and skins", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  const dst = path.join(fx.root, "dst");

  const result = run(["import", dest, "--apply", "--dsh-home", dst], fx.env);
  assert.equal(result.status, 0, result.out);
  assert.ok(fs.existsSync(path.join(dst, "profiles", "web", "package.json")));
  assert.ok(fs.existsSync(path.join(dst, "profiles", "web", "cordis.patch.yml")));
  assert.ok(fs.existsSync(path.join(dst, "skins", "alpha", "skin.json")));
  assert.ok(fs.existsSync(path.join(dst, "skills", "demo", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(fx.home, ".agents", "skills", "foo", "SKILL.md")));
});

test("tampered bundle is rejected with exit 3 and writes nothing", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  fs.appendFileSync(path.join(dest, "payload", "dsh-home", "profiles", "web", "cordis.patch.yml"), "tampered\n");
  const dst = path.join(fx.root, "dst");

  const result = run(["import", dest, "--apply", "--dsh-home", dst], fx.env);
  assert.equal(result.status, 3, result.out);
  assert.ok(!fs.existsSync(path.join(dst, "profiles")));
});

test("tampering with the bundled installer is detected", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  fs.appendFileSync(path.join(dest, "dsh-migrate", "dsh-migrate.mjs"), "\n// injected\n");

  const result = run(["import", dest, "--dsh-home", path.join(fx.root, "dst")], fx.env);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /MISMATCH/);
});

test("unlisted files in payload are rejected", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  fs.writeFileSync(path.join(dest, "payload", "dsh-home", "injected.txt"), "x\n");

  const result = run(["import", dest, "--apply", "--dsh-home", path.join(fx.root, "dst")], fx.env);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /not listed in MANIFEST/);
});

test("archive members escaping the staging dir are rejected", (t) => {
  const fx = fixture();
  const evil = path.join(fx.root, "evil.tgz");
  const payload = path.join(fx.root, "payload");
  fs.mkdirSync(path.join(payload, "dsh-migrate"), { recursive: true });
  fs.mkdirSync(path.join(payload, "payload"), { recursive: true });
  // 用 tar -P + 相对路径构造一个含 ../ 的成员
  fs.writeFileSync(path.join(fx.root, "escape.txt"), "x\n");
  const created = spawnSync("tar", ["-czf", evil, "-C", fx.root, "--transform", "s|escape.txt|../escape.txt|", "escape.txt"], { encoding: "utf8" });
  if (created.status !== 0) { t.skip("tar lacks --transform on this platform"); return; }

  const result = run(["import", evil], fx.env);
  assert.equal(result.status, 2, result.out);
});

test("second import backs up overwritten files", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  const dst = path.join(fx.root, "dst");

  assert.equal(run(["import", dest, "--apply", "--dsh-home", dst], fx.env).status, 0);
  assert.equal(run(["import", dest, "--apply", "--dsh-home", dst], fx.env).status, 0);
  const backups = fs.readdirSync(dst).filter((n) => n.startsWith(".migrate-backup-"));
  assert.ok(backups.length >= 1, "expected at least one backup directory");
  assert.ok(
    backups.some((b) => fs.existsSync(path.join(dst, b, "dsh-home", "profiles", "web", "package.json"))),
    "some backup should contain the overwritten profile file",
  );
});

test("import --from downloads and verifies over HTTP", async () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const bytes = fs.readFileSync(out);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = await runAsync(["import", "--from", `http://127.0.0.1:${port}/b.tgz`, "--dsh-home", path.join(fx.root, "dst")], fx.env);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /ok: \d+ files/);
  } finally {
    server.close();
  }
});

test("bundle containing symlinks is rejected", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  const target = path.join(dest, "payload", "dsh-home", "escape-link");
  try { fs.symlinkSync("/etc/passwd", target); } catch { return; } // Windows 无权限时跳过

  const result = run(["import", dest, "--apply", "--dsh-home", path.join(fx.root, "dst")], fx.env);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /symlink/);
});

test("missing MANIFEST is reported as a corrupt bundle", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  fs.rmSync(path.join(dest, "dsh-migrate", "MANIFEST.sha256"));

  const result = run(["import", dest, "--dsh-home", path.join(fx.root, "dst")], fx.env);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /MANIFEST/);
});

test("export refuses to overwrite without --force", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const second = run(["export", "-o", out], fx.env);
  assert.equal(second.status, 2, second.out);
  assert.match(second.out, /refusing to overwrite/);
  const forced = run(["export", "-o", out, "--force"], fx.env);
  assert.equal(forced.status, 0, forced.out);
});

test("unsupported bundle format is rejected", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  const metaPath = path.join(dest, "dsh-migrate", "meta.env");
  fs.writeFileSync(metaPath, fs.readFileSync(metaPath, "utf8").replace("format=dsh-migrate/2", "format=dsh-migrate/99"));

  const result = run(["import", dest, "--dsh-home", path.join(fx.root, "dst")], fx.env);
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /unsupported bundle format/);
});

test("profile without dependencies does not require node_modules", () => {
  const fx = fixture();
  const pkgPath = path.join(fx.dshHome, "profiles", "web", "package.json");
  fs.writeFileSync(pkgPath, JSON.stringify({ name: "dsh-profile-web", dependencies: {} }));
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  const dst = path.join(fx.root, "dst");
  assert.equal(run(["import", dest, "--apply", "--dsh-home", dst], fx.env).status, 0);

  const result = run(["verify", "--bundle", dest, "--dsh-home", dst], fx.env);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /no plugin dependencies/);
});

test("verify passes once plugin dependencies exist", () => {
  const fx = fixture();
  const out = path.join(fx.root, "b.tgz");
  exportBundle(fx, out);
  const dest = extract(out, path.join(fx.root, "x"));
  const dst = path.join(fx.root, "dst");

  assert.equal(run(["import", dest, "--apply", "--dsh-home", dst], fx.env).status, 0);
  fs.mkdirSync(path.join(dst, "profiles", "web", "node_modules"), { recursive: true });

  const result = run(["verify", "--bundle", dest, "--dsh-home", dst], fx.env);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /\[ok\]\s+cordis\.patch\.yml/);
});
