# 客户接入流程

面向试点客户的最小接入步骤。

## 1. 获取 Gateway 地址和 API key

运营侧给客户提供：

- Gateway URL，例如 `https://mp-gateway.example.com`
- API key，例如 `hmp_live_xxx`
- Gateway 固定公网 IP，例如 `203.0.113.10`

## 2. 在微信后台配置 IP 白名单

客户登录微信公众号后台：

1. 进入 `设置与开发`。
2. 打开 `基本配置`。
3. 在 `IP 白名单` 中添加 Gateway 固定公网 IP。
4. 保存配置。

只需要添加 Gateway 的固定 IP，不需要添加客户自己的办公网络 IP。

## 3. 在客户机器配置本地公众号凭据

```bash
node dist/cli.js credential --set
```

这一步会把 `appid/appSecret` 存在客户本机配置目录，并可同时保存 Gateway API key。Gateway URL 默认是 `https://mp.resopod.cn`，客户通常不需要输入。

如需之后单独更新 Gateway API key 或切换 Gateway：

```bash
node dist/cli.js credential --set-gateway --api-key hmp_live_xxx
node dist/cli.js credential --set-gateway --server https://other-gateway.example.com --api-key hmp_live_xxx
```

Gateway 不保存公众号 secret。

也可以用 `.env`：

```env
WECHAT_APP_ID=wx123
WECHAT_APP_SECRET=your-secret
```

发布时加 `--env-file .env`。

## 4. 发布文章

```bash
node dist/cli.js publish -f article.md \
  --app-id your-local-alias-or-appid
```

发布成功后返回 `Media ID`，客户可以在微信公众号后台草稿箱看到图文草稿。

## 5. 常见错误

- `401 Missing API key`：没有传 `--api-key`，也没有保存 Gateway API key。
- `401 Invalid API key`：API key 错误或已撤销。
- `429 Rate limit exceeded`：超过每分钟限流。
- `缺少必要参数：appSecret`：本机没有配置公众号 secret，也没有传 `--app-secret`。
- 微信返回 IP 白名单错误：确认第 2 步添加的是 Gateway 固定公网 IP。
