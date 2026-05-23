# Docker

Docker 用于运行 Gateway。数据卷 `/data` 保存 SQLite API key 数据库和调用计数。

镜像内部继续使用 Node 24 启动 Gateway；Docker 路径不需要安装 Bun。

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

用 Caddy/Nginx 将 HTTPS 域名反代到 `127.0.0.1:3000`，不要把 3000 端口直接暴露到公网。
