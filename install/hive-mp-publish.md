# hive-mp-publish — Agent 安装指南

## 给用户复制给 Agent 的一句话

> 帮我安装 hive-mp-publish，并按这个指南验证： https://raw.githubusercontent.com/xavierliang/hive-mp-publish/main/install/hive-mp-publish.md

## Agent 执行边界

- 不要使用 `sudo`，除非用户明确授权。
- 不要把微信公众号 appSecret、Gateway API key 或 access_token 写入日志。
- 客户本机全局 CLI 需要 Bun；安装前先确认 `bun --version` 可运行。
- Gateway/server 模式使用 Node.js，生产推荐 Node.js 24。
- 远程 Gateway URL 必须使用 HTTPS。HTTP 只用于 localhost 联调。

全局 `hive-mp-publish` 命令是 Bun-first，用于客户侧 `doctor`、`credential`、`publish`。Gateway 运维的 `key` 和 `serve` 不使用全局命令；源码部署时用显式 `node ./dist/cli.js ...`，或使用 Docker。

## 安装 CLI

从 GitHub Release tarball 安装固定版本：

```bash
bun --version
bun add -g "https://github.com/xavierliang/hive-mp-publish/releases/download/v0.1.2/hive-mp-publish-0.1.2.tgz"
hive-mp-publish doctor
```

如果 `hive-mp-publish` 启动时报 `/usr/bin/env: bun: No such file or directory`、`env: bun` 或 `bun: No such file or directory`，说明当前 shell 找不到 Bun。安装 Bun，或把 Bun 的 `bin` 目录加入 `PATH` 后再运行。

如果 Release tarball 暂时不可用，不要使用 GitHub 源码仓库作为全局安装源。源码包安装不会可靠地产生已构建的 `dist/`。源码 fallback 应改为 clone、安装依赖、构建，然后用显式本地路径运行：

```bash
git clone https://github.com/xavierliang/hive-mp-publish.git
cd hive-mp-publish
git checkout v0.1.2
pnpm install
pnpm build
bun ./dist/cli.js doctor
```

源码 fallback 只用于本地路径运行，不注册全局 GitHub package。客户侧 CLI 检查用 `bun ./dist/cli.js ...`；Gateway 运维检查用 `node ./dist/cli.js ...`。

## 首次配置

在客户机器上保存微信公众号 AppID/AppSecret：

```bash
hive-mp-publish credential --set
hive-mp-publish doctor
```

配置时可以给 AppID 设置一个别名，后续发布时用 `--app-id <alias>`。如果已拿到 Gateway API key，也可以在同一流程中保存；默认 Gateway URL 为 `https://mp.resopod.cn`。

## 发布文章

通过固定 IP Gateway 发布到微信公众号草稿箱：

```bash
hive-mp-publish publish -f article.md --app-id "<local-alias-or-appid>"
```

如需切换 Gateway 或轮换 API key，运行 `hive-mp-publish credential --set-gateway --server <url> --api-key <key>`。

Markdown 需要包含 frontmatter：

```md
---
title: 文章标题
cover: ./cover.jpg
author: 作者
source_url: https://example.com/original
---

正文内容。
```

## Gateway 运维命令

在 Gateway 机器源码构建后，用 Node 显式运行运维命令签发 API key：

```bash
node ./dist/cli.js key issue --name "<customer-name>"
```

启动 Gateway：

```bash
node ./dist/cli.js serve --port 3000
```

生产环境应放在 Caddy/Nginx 后面，由反向代理提供 HTTPS，并把 Gateway 固定公网 IP 加到微信公众号后台 IP 白名单。

## 可选：安装配套 skill pack

默认安装配套 skill pack。这个包包含三个运行时 skill：`publish-to-wechat`、`generate-wechat-theme` 和 `apply-wechat-custom-theme`。它应该解压到 Agent 的 skills 根目录，而不是某一个单独 skill 目录。

Codex 默认目录如下；如果用户使用 Claude Code、Cursor 或其他 Agent，请先确认该工具的 skills 根目录，再替换 `SKILLS_DIR`。

```bash
SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$SKILLS_DIR"
curl -L "https://github.com/xavierliang/hive-mp-publish/releases/download/v0.1.2/hive-mp-publish-skills.tar.gz" | tar -xz -C "$SKILLS_DIR"
```

安装后目标目录应包含：

```text
publish-to-wechat/SKILL.md
generate-wechat-theme/SKILL.md
apply-wechat-custom-theme/SKILL.md
```

如果需要兼容旧版单 skill tarball，也可以分别把单个 tarball 解压到对应 skill 目录：

```bash
mkdir -p "$SKILLS_DIR/publish-to-wechat"
curl -L "https://github.com/xavierliang/hive-mp-publish/releases/download/v0.1.2/publish-to-wechat.tar.gz" | tar -xz -C "$SKILLS_DIR/publish-to-wechat"
mkdir -p "$SKILLS_DIR/generate-wechat-theme"
curl -L "https://github.com/xavierliang/hive-mp-publish/releases/download/v0.1.2/generate-wechat-theme.tar.gz" | tar -xz -C "$SKILLS_DIR/generate-wechat-theme"
mkdir -p "$SKILLS_DIR/apply-wechat-custom-theme"
curl -L "https://github.com/xavierliang/hive-mp-publish/releases/download/v0.1.2/apply-wechat-custom-theme.tar.gz" | tar -xz -C "$SKILLS_DIR/apply-wechat-custom-theme"
```

## 常见失败

- `hive-mp-publish` 不在 PATH：让用户重开 shell，或重新运行全局安装命令。
- `/usr/bin/env: bun: No such file or directory` 或 `bun: No such file or directory`：安装 Bun，或把 Bun 的 `bin` 目录加入 `PATH`。
- Gateway 运维命令提示 Node 版本过低：服务器安装 Node.js 24。
- `doctor` 提示凭据未配置：运行 `hive-mp-publish credential --set`。
- 微信返回 IP 白名单错误：确认添加的是 Gateway 固定公网 IP，不是客户本机 IP。
- `401 Missing API key` 或 `401 Invalid API key`：运行 `hive-mp-publish credential --show-gateway` 检查本机是否保存 Gateway API key；如需轮换，运行 `hive-mp-publish credential --set-gateway --api-key <key>`。
- `缺少必要参数：appSecret`：客户本机未配置凭据，或 `--app-id`/别名不匹配。
