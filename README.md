# hive-mp-publish

公众号发布工具：把本地 Markdown 渲染后发布到微信公众号草稿箱。

本仓库基于 `caol64/wenyan-cli` fork 改造（Apache-2.0，详见 [NOTICE](NOTICE)），当前目标是方案 B 的受控试点 MVP：固定 IP Gateway + 客户本地保存公众号 secret + 每次 HTTPS 请求携带凭据。

## 当前范围

- `publish`：单篇 Markdown 发布到公众号草稿箱，支持正文图、封面图、frontmatter。
- `serve`：固定 IP Gateway，不持久化客户 `appSecret`，按 `appid` 做内存级 access_token 缓存。
- `key`：SQLite API key issue / revoke / list，保存 key hash、调用计数和基础限流。
- `credential`：客户本机保存公众号 `appid/appSecret`，server 不读取这份配置。

不包含 web 前台、账号系统、计费、多实例 HA。

## 快速开始

安装依赖并构建：

```bash
pnpm install
pnpm build
```

在 Gateway 机器上签发一个客户 API key：

```bash
node dist/cli.js key issue --name acme
```

启动 Gateway：

```bash
node dist/cli.js serve --port 3000
```

生产环境应放在 Caddy/Nginx 后面，由反向代理提供 HTTPS，并把这台 Gateway 的固定公网 IP 加到微信公众号后台 IP 白名单。

客户机器配置本地公众号凭据：

```bash
node dist/cli.js credential --set
```

客户发布文章：

```bash
node dist/cli.js publish -f article.md \
  --app-id your-appid-or-local-alias \
  --server https://mp-gateway.example.com \
  --api-key hmp_live_xxx
```

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

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

当前真实微信公众号发布链路需要有效认证公众号、`appid/appSecret` 和已配置 Gateway IP 白名单后才能验证。
