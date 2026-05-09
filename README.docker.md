# hive-mp-publish Docker

Build locally:

```bash
docker build -t hive-mp-publish .
```

Run the Gateway:

```bash
docker run -d --name hive-mp-publish \
  -p 127.0.0.1:3000:3000 \
  -v hive-mp-publish-data:/data \
  hive-mp-publish \
  serve --port 3000
```

Issue a key inside the same data volume:

```bash
docker run --rm \
  -v hive-mp-publish-data:/data \
  hive-mp-publish \
  key issue --name acme
```

Expose it through HTTPS with Caddy/Nginx. Do not publish port `3000` directly to the internet.
