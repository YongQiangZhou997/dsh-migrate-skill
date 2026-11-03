# dsh-migrate

一个 **DeepSeek Harness（DSH）skill**：把整台机器的 DSH 配置打包成一个自描述 bundle，换机器后让 DSH 自己还原。

## 装成 skill

```bash
git clone https://github.com/YongQiangZhou997/dsh-migrate.git ~/.agents/skills/dsh-migrate
```

或在 DSH 技能面板里导入仓库 / zip。装完直接说：

- “帮我把这台机器的 DSH 配置打包，准备搬到我笔记本”
- “按这个包把新机器配好”
- “检查一下我的 DSH 配置完整吗”

## 它做什么

| 动作 | 内容 |
|---|---|
| 打包 | profile 配置、patch 覆盖层、四个 skills 根、皮肤、工作区登记 |
| 还原 | 逐文件校验 → 备份被覆盖文件 → 写入 → 提示重装插件 |
| 体检 | 版本、插件、patch 漂移、skills、皮肤、工作区路径 |

包内自带 `RESTORE.md` 和三份清单（`plugins.json`、`skills.global.json`、`skills.project.json`），不装 skill 也能照着做。

## 也可以直接用

```bash
node bin/dsh-migrate.mjs export -o ~/dsh-config.tar.gz
node bin/dsh-migrate.mjs import <bundle> --apply
node bin/dsh-migrate.mjs verify --bundle <dir>
```

要求 Node ≥ 20 + 系统 `tar`；Linux / macOS / Windows 通用。

## 边界

- 不打包 `node_modules`，到新机器重装
- 默认不带凭据（`.credentials.yaml`、`.npmrc`）
- sha256 是损坏检测，不是签名
- 皮肤只搬已安装的；工作区绝对路径需重设

MIT
