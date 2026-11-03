# dsh-migrate

DSH 配置打包成一个自描述 bundle，换机器还原。Linux / macOS / Windows 通用。

```bash
# 旧机器
node bin/dsh-migrate.mjs export -o ~/dsh-config.tar.gz

# 新机器（PowerShell 用户：把 $DSH_HOME 换成 $env:DSH_HOME）
tar -xzf dsh-config.tar.gz
node dsh-migrate/dsh-migrate.mjs import . --apply
DSH_HOME=~/.dsh dsh plugin --profile web install
```

要求：Node ≥ 20（DSH 自带）+ 系统 `tar`（Win10 1803+ 自带）。

解包后：`RESTORE.md` + 3 份 JSON 清单 + `dsh-migrate/` + `payload/`。

- 内容随包，清单只为可读
- 逐文件 sha256（损坏检测，不是签名；清单与内容同时被改无法发现）
- 清单是白名单：payload 里多出文件也退出 3
- 默认 dry-run、默认不带凭据（`.npmrc` 也算凭据）
- 不打包 `node_modules`，到新机器重装

```bash
node bin/dsh-migrate.mjs verify --bundle <dir>    # 体检
node --test                                       # 测试
```

非 `web` profile 设 `DSH_PROFILE`；工作区是绝对路径，换机器需重设。

MIT
