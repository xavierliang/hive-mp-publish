# 第一次真实试点 Walkthrough

本文用于把 `hive-mp-publish` 跑通到第一个真实公众号草稿箱。

> 本 walkthrough 保持 Node-first。若你已经安装 Bun 并希望使用它，源码构建后的等价命令是把 `node ./dist/cli.js` 替换为 `bun ./dist/cli.js`；详见 README 的 “Running with Bun”。不要为 Bun 复制一套逐条命令。

## 整体链路和边界

试点链路：

```text
客户机器 CLI --HTTPS + x-api-key--> 固定 IP Gateway --微信公众号 API--> 公众号草稿箱
```

边界：

- Gateway 不保存客户 `appSecret`。
- 客户 `appid/appSecret` 存在客户本机，发布时随单次 HTTPS `/publish` 请求传给 Gateway。
- Gateway SQLite 只保存 API key hash、状态、限流配置和调用计数。
- Gateway access_token 是进程内按 `appid` 缓存，TTL 最长 7000 秒，重启后失效。
- 当前是单实例 MVP，不包含 web 前台、账号系统、计费、多实例/HA。

## 服务器准备

准备一台云主机：

- 有固定公网 IP。
- 有域名，例如 `mp-gateway.example.com`，A 记录指向该固定公网 IP。
- 安装 Node.js。建议生产使用 Node 24；Node 22 可运行，但 `node:sqlite` 会打印 experimental warning。
- 安装 `pnpm`。
- 防火墙开放 `443/tcp`。如果 Caddy 证书签发使用 HTTP-01，也开放 `80/tcp`。
- 不要对公网开放 `3000/tcp`。
- 服务器出站需要能访问微信公众号 API。

部署代码并构建：

```bash
cd /opt/hive-mp-publish
pnpm install
pnpm build
```

准备数据库目录：

```bash
sudo mkdir -p /var/lib/hive-mp-publish
sudo chown -R hive-mp:hive-mp /var/lib/hive-mp-publish
```

数据库路径可用参数传入，也可用环境变量：

```bash
export HIVE_MP_GATEWAY_DB=/var/lib/hive-mp-publish/gateway.sqlite
```

## 固定 IP 和微信白名单

在微信公众号后台添加 Gateway 机器固定公网 IP：

1. 登录微信公众号后台。
2. 进入 `设置与开发`。
3. 打开 `基本配置`。
4. 在 `IP 白名单` 中添加 Gateway 固定公网 IP，例如 `203.0.113.10`。
5. 保存配置。

只添加 Gateway 固定 IP，不添加客户办公室或客户机器的动态 IP。

## API key 管理

在 Gateway 机器上为客户签发 API key：

```bash
node dist/cli.js key issue \
  --name acme \
  --monthly-limit 1000 \
  --rate-limit-per-minute 60 \
  --db /var/lib/hive-mp-publish/gateway.sqlite
```

也可以输出 JSON：

```bash
node dist/cli.js key issue --name acme --json
```

返回的 `API Key: hmp_live_xxx` 只显示一次；SQLite 里只保存 hash。

交给客户的信息：

- Gateway URL：`https://mp-gateway.example.com`
- API key：`hmp_live_xxx`
- Gateway 固定公网 IP：用于微信白名单

查看 key 和当月用量：

```bash
node dist/cli.js key list --db /var/lib/hive-mp-publish/gateway.sqlite
node dist/cli.js key list --db /var/lib/hive-mp-publish/gateway.sqlite --json
```

撤销 key：

```bash
node dist/cli.js key revoke --id 1 --db /var/lib/hive-mp-publish/gateway.sqlite
```

或用完整 key 撤销：

```bash
node dist/cli.js key revoke --key hmp_live_xxx --db /var/lib/hive-mp-publish/gateway.sqlite
```

撤销后下一次请求立即返回 401。

## 启动 Gateway

直接启动：

```bash
node dist/cli.js serve \
  --port 3000 \
  --db /var/lib/hive-mp-publish/gateway.sqlite
```

systemd 示例：

```ini
[Unit]
Description=Hive MP Publish Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/hive-mp-publish
Environment=HIVE_MP_GATEWAY_DB=/var/lib/hive-mp-publish/gateway.sqlite
ExecStart=/usr/bin/node /opt/hive-mp-publish/dist/cli.js serve --port 3000
Restart=always
RestartSec=3
User=hive-mp
Group=hive-mp

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hive-mp-publish
sudo systemctl status hive-mp-publish
```

## Caddy 和 HTTPS

Caddyfile：

```caddyfile
mp-gateway.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

部署原则：

- 客户端必须访问 HTTPS Gateway URL。
- `3000` 只给本机反代访问，不直接暴露公网。
- Caddy 自动签发和续期证书。

## Health 和 Verify 检查

健康检查无需 API key：

```bash
curl https://mp-gateway.example.com/health
```

期望响应：

```json
{
  "status": "ok",
  "service": "hive-mp-publish-gateway",
  "version": "0.1.2"
}
```

鉴权检查需要 `x-api-key`：

```bash
curl https://mp-gateway.example.com/verify \
  -H 'x-api-key: hmp_live_xxx'
```

无 key 应返回 `401 Missing API key`；错 key 应返回 `401 Invalid API key`。

## 客户端凭据配置

推荐客户在本机交互式保存公众号凭据：

```bash
node dist/cli.js credential --set
```

按提示输入：

- `AppID`
- `AppSecret`
- 可选别名 alias
- 可选 Gateway API key，默认 Gateway URL 为 `https://mp.resopod.cn`

之后发布时 `--app-id` 可以传真实 appid 或本地 alias。

如需单独更新 Gateway API key 或切换 Gateway：

```bash
node dist/cli.js credential --set-gateway \
  --server https://mp-gateway.example.com \
  --api-key hmp_live_xxx
```

也可以使用 `.env`：

```env
WECHAT_APP_ID=wx123
WECHAT_APP_SECRET=your-secret
```

发布时加：

```bash
--env-file .env
```

CLI 也支持临时传 `--app-secret`，但不建议长期写入 shell history 或脚本日志。

## 准备第一篇 Markdown

示例 frontmatter：

```md
---
title: 文章标题
cover: ./cover.jpg
author: 作者
source_url: https://example.com/original
need_open_comment: 1
only_fans_can_comment: 0
---

正文内容。

![](./image.png)
```

注意：

- `title` 必填。
- `cover` 可用本地路径或 HTTPS 图片；如果正文第一张图可作为封面，也可以省略。
- 本地图片由客户端先上传到 Gateway 临时目录，再由 Gateway 上传到微信素材。

## 首次发布命令

客户已执行 `credential --set` 时：

```bash
node dist/cli.js publish -f article.md --app-id your-local-alias-or-appid
```

使用 `.env` 时：

```bash
node dist/cli.js publish -f article.md \
  --env-file .env
```

临时显式传 secret 时：

```bash
node dist/cli.js publish -f article.md \
  --app-id wx123 \
  --app-secret your-secret
```

成功后 CLI 返回：

```text
发布成功，Media ID: xxx
```

然后到微信公众号后台草稿箱确认标题、封面图、正文图片和排版。

## 本地联调

localhost 可使用 HTTP：

```bash
node dist/cli.js serve --port 3000 --db /tmp/gateway.sqlite
node dist/cli.js publish -f article.md \
  --app-id your-local-alias-or-appid \
  --server http://localhost:3000 \
  --api-key hmp_live_xxx
```

非 localhost 的 HTTP Gateway 会被客户端拒绝。只有受控测试才使用：

```bash
--allow-insecure-http
```

真实试点不要使用 HTTP。

## Docker 可选路径

构建镜像：

```bash
docker build -t hive-mp-publish .
```

签发 API key：

```bash
docker run --rm \
  -v hive-mp-publish-data:/data \
  hive-mp-publish \
  key issue --name acme
```

启动 Gateway：

```bash
docker run -d --name hive-mp-publish \
  -p 127.0.0.1:3000:3000 \
  -v hive-mp-publish-data:/data \
  hive-mp-publish \
  serve --port 3000
```

仍然需要 Caddy/Nginx 把 HTTPS 域名反代到 `127.0.0.1:3000`。

## 常见问题

- `401 Missing API key`：客户端没有保存 Gateway API key，也没有传 `--api-key`；curl 调试时则是没传 `x-api-key`。
- `401 Invalid API key`：API key 错误、复制缺失，或 Gateway 启动时使用的不是同一个 SQLite `--db`。
- `401 Revoked API key`：API key 已撤销，需要重新签发。
- `429 Rate limit exceeded`：超过每分钟限流，默认 60 rpm；签发 key 时可设置 `--rate-limit-per-minute`。
- `Monthly API key limit exceeded`：超过签发 key 时设置的 `--monthly-limit`。
- `缺少必要参数：appSecret`：客户端本机没有 credential/env，也没有传 `--app-secret`。
- `Remote Gateway URL must use HTTPS`：生产 URL 必须是 `https://...`；localhost 联调才允许 HTTP。
- 微信返回 `invalid ip` 或 IP 白名单错误：确认微信公众号后台添加的是 Gateway 固定公网 IP，不是客户本机 IP。
- 图片路径错误：确认 Markdown 中本地图片路径相对文章目录可解析，或使用 HTTPS 图片。
- 端口被占用：`serve --port 3000` 失败时，停止已有进程或换端口，并同步调整 Caddy `reverse_proxy`。
- Node 打印 `SQLite is an experimental feature`：当前实现使用 Node 内置 `node:sqlite`；Node 22 会有 warning，生产建议使用 Node 24 或后续切换稳定 SQLite 依赖。
- 发布成功但草稿箱看不到：确认使用的是正确公众号 `appid`，并检查微信权限、IP 白名单和公众号后台草稿箱。
