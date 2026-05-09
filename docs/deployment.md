# 部署与 HTTPS

生产部署形态：

```text
Client CLI --HTTPS + x-api-key--> Caddy/Nginx --localhost--> Gateway --WeChat API--> 微信公众号
```

微信公众号后台只需要把 Gateway 机器的固定公网 IP 加入 IP 白名单。

## systemd 示例

`/etc/systemd/system/hive-mp-publish.service`：

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

## Caddy 示例

`/etc/caddy/Caddyfile`：

```caddyfile
mp-gateway.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

Caddy 会自动签发和续期 HTTPS 证书。

## 防火墙

- 对公网开放 `443/tcp`。
- 不要对公网开放 `3000/tcp`。
- 服务器出站需要能访问微信公众号 API。

## 健康检查

```bash
curl https://mp-gateway.example.com/health
```

返回 `status: ok` 即 Gateway 进程和反向代理可达。
