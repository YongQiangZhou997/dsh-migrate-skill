# dsh-migrate-skill

一个 **DeepSeek Harness（DSH）skill**：把整台机器的 DSH 配置打包成一个自描述 bundle，换机器后让 DSH 自己还原。

手工换机器会踩的坑：漏拷 skills、把 `node_modules` 一起搬过去（平台相关直接崩）、把 `.npmrc` 里的 token 打进包、工作区路径失效。这个 skill 把这些收成一句话。

## 安装

```bash
git clone https://github.com/YongQiangZhou997/dsh-migrate-skill.git \
  ~/.agents/skills/dsh-migrate-skill
```

或在 DSH 技能面板里导入仓库 / zip。

## 使用

对 agent 说：

- “帮我把这台机器的 DSH 配置打包，准备搬到我笔记本” → 产出 `dsh-config.tar.gz`
- “按这个包把新机器配好” → 先 dry-run 预览，确认后写入，再提示重装插件
- “检查一下我的 DSH 配置完整吗” → 六项体检

手动执行也可以：

```bash
node bin/dsh-migrate.mjs export -o ~/dsh-config.tar.gz
node bin/dsh-migrate.mjs import <bundle> --apply
node bin/dsh-migrate.mjs verify --bundle <dir>
```

要求 Node ≥ 20 + 系统 `tar`；Linux / macOS / Windows 通用。

## 包里有什么

`RESTORE.md` + 三份清单（`plugins.json`、`skills.global.json`、`skills.project.json`）+ `payload/`。

不装 skill 也能照 `RESTORE.md` 还原。

## 边界

- 不打包 `node_modules`，到新机器重装
- 默认不带凭据（`.credentials.yaml`、`.npmrc`）
- sha256 是损坏检测，不是签名
- 皮肤只搬已安装的；工作区绝对路径需重设

MIT
