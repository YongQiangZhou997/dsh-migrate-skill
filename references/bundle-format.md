# bundle 格式

## 解包后

```
RESTORE.md              还原步骤（不装工具也能照做）
plugins.json            插件 + DSH / Node 版本
skills.global.json      全局 skills；有 git 出处的带 source/ref/path
skills.project.json     项目级 skills（属于项目仓库，通常为空）
dsh-migrate/
  meta.env              打包元信息（format / tool_version / profile / dsh_version）
  MANIFEST.sha256       逐文件校验和
  dsh-migrate.mjs       还原器副本（Node 单文件）
payload/
  dsh-home/             profile 配置、皮肤、工作区登记
  home/{dsh,agents,codex,claude}/   skills
```

## meta.env

```
format=dsh-migrate/2
tool_version=0.1.0
profile=web
created=...
host=...
dsh_version=0.2.1-rc.2
node_version=v22.23.2
source_dsh_home=...
with_secrets=0
with_sessions=0
```

`tool_version` 与当前不同时只提示，不阻断：旧包永远能被新工具还原。

## MANIFEST.sha256

`<sha256>  <相对解包根的路径>`。覆盖 `payload/`、包根说明文件、`dsh-migrate/meta.env`，以及随包携带的还原器 `dsh-migrate/dsh-migrate.mjs`（防止安装器本身被换）。

两层校验：

1. 逐文件 hash 不匹配 → 退出 3；
2. 清单是**白名单**：`payload/` 里出现未列出的文件 → 退出 3，不写入任何东西。

不是签名。要来源可信，请用 HTTPS 或 git，不要把 bundle 从不可信来源下载。

## 带什么

| | 内容 |
|---|---|
| ✅ | `profiles/*/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,cordis.yml,cordis.patch.yml}` |
| ✅ | `skins/`、`pet.json`、`skin-center-active.json`、`dsh-market/`、`storages/workspace.json` |
| ✅ | 四个 skills 根 |
| ⚠️ | `.credentials.yaml`、`.npmrc`、`sessions/`：仅显式参数时带上 |
| ❌ | `node_modules`、`cache/`、`attachments/`、账单数据、DSH 程序本体 |

## 平台

| 平台 | 说明 |
|---|---|
| Linux | 基线 |
| macOS | 用系统 tar、Node 自带 crypto，无需 shasum |
| Windows | 用系统 `tar`（Win10 1803+ 自带）；`chmod 600` 在 NTFS 上无实际作用，已 try/catch |

符号链接会按链接复制，不参与校验和。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（dry-run 也是 0） |
| 1 | 运行时错误 |
| 2 | 参数错误 / 不是有效 bundle / 归档含不安全路径 |
| 3 | 校验失败或存在清单外文件：**不要继续** |
