# hive-mp-publish

公众号发布工具：把本地 Markdown 渲染后发布到微信公众号草稿箱。

本仓库基于 `caol64/wenyan-cli` fork 改造（Apache-2.0，详见 [NOTICE](NOTICE)），当前目标是方案 B 的受控试点 MVP：固定 IP Gateway + 客户本地保存公众号 secret + 每次 HTTPS 请求携带凭据。

## 当前范围

- `publish`：单篇 Markdown 发布到公众号草稿箱，支持正文图、封面图、frontmatter。
- `serve`：固定 IP Gateway，不持久化客户 `appSecret`，按 `appid` 做内存级 access_token 缓存。
- `key`：SQLite API key issue / revoke / list，保存 key hash、调用计数和基础限流。
- `credential`：客户本机保存公众号 `appid/appSecret` 和默认 Gateway API key，server 不读取这份配置。

不包含 web 前台、账号系统、计费、多实例 HA。

## 快速开始

运行环境：

- 客户本机全局 CLI 需要 Bun；先确认 `bun --version` 可运行。
- Gateway/server 模式使用 Node.js，生产推荐 Node.js 24。

从 Release tarball 安装客户 CLI：

```bash
bun --version
bun add -g "https://github.com/xavierliang/hive-mp-publish/releases/download/v0.1.2/hive-mp-publish-0.1.2.tgz"
hive-mp-publish doctor
```

全局 `hive-mp-publish` 命令是 Bun-first。若运行时报 `/usr/bin/env: bun: No such file or directory`、`env: bun` 或 `bun: No such file or directory`，先安装 Bun，并确认 Bun 的 `bin` 目录在 `PATH` 中。

让 Agent 安装时，可以直接把这份指南发给它：

```text
https://raw.githubusercontent.com/xavierliang/hive-mp-publish/main/install/hive-mp-publish.md
```

也可以从源码安装依赖并构建。客户侧 CLI 检查使用 Bun 直接运行构建产物：

```bash
pnpm install
pnpm build
bun ./dist/cli.js doctor
```

当前支持的是用 Bun 运行 `dist/cli.js` 或 Release tarball 中的全局 CLI，不承诺 `bun build --compile` 或单文件可执行产物。Bun 下显式 `--proxy` 不支持；如果设置了 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`，CLI 会提示并依赖 Bun 原生 `fetch` 处理这些环境变量。需要 undici 级代理拦截时请使用 Node 入口。

## Gateway 运维

在 Gateway 机器上签发一个客户 API key：

```bash
node ./dist/cli.js key issue --name acme
```

启动 Gateway：

```bash
node ./dist/cli.js serve --port 3000
```

生产环境应放在 Caddy/Nginx 后面，由反向代理提供 HTTPS，并把这台 Gateway 的固定公网 IP 加到微信公众号后台 IP 白名单。

显式 `node ./dist/cli.js ...` 是 Gateway/server 的源码运行和部署路径；Docker 镜像也保持 Node 24 入口，不受全局 CLI 改为 Bun-first 的影响。

## 客户发布

客户机器配置本地公众号凭据：

```bash
hive-mp-publish credential --set
```

这一步可同时保存 Gateway API key；Gateway URL 默认使用 `https://mp.resopod.cn`。

客户发布文章：

```bash
hive-mp-publish publish -f article.md --app-id your-appid-or-local-alias
```

如需临时覆盖 Gateway，可在发布时显式传 `--server` 和 `--api-key`。

本地联调可使用 `http://localhost:3000`。非 localhost 的 HTTP URL 会被 client 拒绝，只有受控测试可加 `--allow-insecure-http`。

## Markdown frontmatter

```md
---
title: 文章标题
cover: ./cover.jpg
author: 作者
source_url: https://example.com/original
---

正文内容。

![](./image.png)
```

## 安全边界

- Gateway 只接受带 `x-api-key` 的请求，API key 在 SQLite 中只保存 SHA-256 hash。
- `appSecret` 只随单次 `/publish` 请求进入内存，不写入 SQLite、日志或配置文件。
- Gateway 的 `access_token` 缓存在内存中，TTL 最长 7000 秒，进程重启后失效。
- 错误响应和 server log 会对 API key、token、secret 字段做脱敏。
- 客户端默认要求远程 Gateway 使用 HTTPS。

## 更多文档

- [Gateway Server](docs/server.md)
- [部署与 HTTPS](docs/deployment.md)
- [客户接入流程](docs/customer-onboarding.md)
- [Agent 安装指南](install/hive-mp-publish.md)

## 验证

```bash
pnpm typecheck
pnpm test
pnpm exec eslint .
pnpm build
npm pack --dry-run
```

当前真实微信公众号发布链路需要有效认证公众号、`appid/appSecret` 和已配置 Gateway IP 白名单后才能验证。
