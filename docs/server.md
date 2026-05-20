# Gateway Server

Gateway Server 部署在一台固定公网 IP 的机器上，负责把客户本地渲染好的图文素材转发到微信公众号 API。客户的 `appSecret` 每次请求携带，server 不持久化。

## 启动前签发 API key

```bash
node dist/cli.js key issue --name acme
```

可选参数：

```bash
node dist/cli.js key issue \
  --name acme \
  --monthly-limit 1000 \
  --rate-limit-per-minute 60 \
  --db /var/lib/hive-mp-publish/gateway.sqlite
```

`API Key` 只会显示一次；SQLite 里保存的是 hash。

## 启动服务

```bash
node dist/cli.js serve \
  --port 3000 \
  --db /var/lib/hive-mp-publish/gateway.sqlite
```

默认数据库路径也可用环境变量设置：

```bash
export HIVE_MP_GATEWAY_DB=/var/lib/hive-mp-publish/gateway.sqlite
```

## 接口

### `GET /health`

无需鉴权，用于反向代理和监控探活。

```json
{
  "status": "ok",
  "service": "hive-mp-publish-gateway",
  "version": "0.1.1"
}
```

### `GET /verify`

需要 `x-api-key`，用于客户端发布前确认鉴权。

### `POST /upload`

需要 `x-api-key`，上传 Markdown 渲染后的 JSON、图片或 CSS。上传文件只保存在临时目录，默认 10 分钟清理。

### `POST /publish`

需要 `x-api-key`，请求体必须包含：

```json
{
  "fileId": "uploaded-json-file-id",
  "appId": "wx123",
  "appSecret": "customer-secret"
}
```

Gateway 会按 `appId` 使用内存 access_token cache，随后调用微信 `draft/add` 创建草稿。

## API key 管理

```bash
# 查看 key 和当月调用计数
node dist/cli.js key list

# 撤销 key
node dist/cli.js key revoke --id 1

# 或用完整 key 撤销
node dist/cli.js key revoke --key hmp_live_xxx
```

撤销后下一次请求立即返回 401。

## 日志与错误

Gateway 不记录请求体。错误进入响应或日志前会脱敏 API key、secret、token 字段。排障时使用 key `id/name/prefix` 关联客户，不要要求客户提交完整 API key 或公众号 secret。
