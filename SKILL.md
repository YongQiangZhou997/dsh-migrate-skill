---
name: dsh-migrate-skill
description: 把 DeepSeek Harness（DSH）的配置（插件、patch 覆盖层、skills、皮肤）打包成自描述 bundle 并在另一台机器还原，或备份/体检。当用户说"迁移 DSH""换电脑""备份配置""复刻环境""把服务器配置搬到本机"时使用。
---

# DeepSeek Harness（DSH）配置迁移

判断本机角色：

```bash
ls "${DSH_HOME:-$HOME/.dsh}/profiles" 2>/dev/null && echo "有配置"
```

| 本机 | 命令 |
|---|---|
| 有配置，要搬走 | `node bin/dsh-migrate.mjs export -o ~/dsh-config.tar.gz` |
| 空机器，要还原 | `node dsh-migrate/dsh-migrate.mjs import <bundle> --apply` |
| 只备份 / 体检 | `node bin/dsh-migrate.mjs verify --bundle <dir>` |

## 导出

```bash
node bin/dsh-migrate.mjs export -o ~/dsh-config.tar.gz
node bin/dsh-migrate.mjs export -o /tmp/b.tgz --push user@host:~/   # 可选 scp
```

产物自描述：解包后先读 `RESTORE.md` 与三份 JSON，不要展开 `payload/`。默认不带凭据与会话；`--with-secrets` / `--with-sessions` 才带（`.npmrc` 也算凭据，只在 `--with-secrets` 时打包）。

## 导入

```bash
node bin/dsh-migrate.mjs import <bundle>            # dry-run
node bin/dsh-migrate.mjs import <bundle> --apply
node bin/dsh-migrate.mjs import --from <url> --apply
```

校验 sha256（失败退出 3）→ 拒绝清单外文件 → 备份被覆盖文件 → 写入。

之后必须重装依赖（`node_modules` 平台相关，不随包走）：

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}" dsh plugin --profile web install
```

## 硬规则

1. 不拷 `node_modules`
2. 不伪造凭据，只问用户
3. 覆盖前先备份
4. 不改 `cordis.yml`，改 `cordis.patch.yml`
5. `storages/workspace.json` 是旧机器绝对路径，必须问用户
6. 校验失败就停

## 失败处理

| 现象 | 处理 |
|---|---|
| sha256 不匹配 / 有清单外文件 | 停，让用户重新传或重新打包 |
| `tar` 报错 | 确认系统 tar 可用（Win10 1803+ 自带） |
| peer 版本不兼容 | 问用户 `--allow-version`，或对齐 `meta.env` 的版本 |
| 端口占用 | `dsh web --port 3081` |
| 某 skill 缺失 | 报名称让用户补拷，不要自造 |
