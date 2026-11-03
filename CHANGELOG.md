# Changelog

## 0.1.0 — 2026-11-03

首个版本。

- `bin/dsh-migrate.mjs`：单文件 CLI，`export` / `import` / `verify`，零依赖，Node ≥ 20
- Linux / macOS / Windows 通用：只依赖系统 `tar`（Win10 1803+ 自带），sha256 用 Node crypto
- 包自描述：`RESTORE.md` + `plugins.json` + `skills.global.json` + `skills.project.json`
- 逐文件 sha256；清单作为白名单，payload 出现未列出文件即退出 3
- 解包前校验成员路径，拒绝绝对路径与 `..`
- 默认 dry-run；默认不带凭据（`.credentials.yaml`、`.npmrc` 仅在 `--with-secrets` 时打包）
- 写入前备份被覆盖文件；不打包 `node_modules`
- `node --test` 15 个用例；CI 覆盖 ubuntu / macos / windows × Node 20 / 22

### 独立复审修复（Request changes → 已处理）

- 拒绝归档中的符号/硬链接成员；payload 出现任何符号链接即退出 3；导出端不再携带链接
- 归档路径校验按反斜杠与 UNC 归一化，防 Windows 路径绕过
- `die()` 改为抛异常，保证暂存目录（可能含凭据副本）在退出前被清理
- DSH 未安装时 `meta.env` 写 `dsh_version=unknown`，`verify` 不再误判
- 缺少 `MANIFEST.sha256`、清单行格式错误、清单项是目录：明确报错并退出 3
- 无插件依赖的 profile 不再要求 `node_modules`
- `RESTORE.md` 按实际内容描述是否含凭据
- `--with-secrets` 时把 bundle 权限收紧到 0600 并告警
- 导出默认拒绝覆盖已有 bundle，需要 `--force`
- 校验 `meta.format`，未知格式退出 2
- 备份目录加随机后缀，避免同秒并发合写
- README 修正：sha256 是损坏检测不是签名；补 PowerShell 写法

### 已知限制

- 需要系统 `tar`
- 皮肤只搬已安装的，不去市场拉取
- 工作区是绝对路径，换机器需重设
