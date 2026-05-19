# 国内服务器 Docker 部署

本方案用于不能稳定访问 GitHub 的国内服务器。常规路径是服务器不拉代码、不安装宿主机 npm 依赖，只接收本地构建好的 Docker 镜像 tar 包；如果本机 Docker 没启动，也可以上传源码包后在服务器的 Docker build 环境里构建。

## 服务器约定

- SSH alias: `ResoPodXavierCN`
- 远端目录: `/home/xavier/hive-mp-publish`
- 宿主机监听: `127.0.0.1:3007`
- 容器名称: `hive-mp-publish-gateway`
- 数据目录: `/home/xavier/hive-mp-publish/data`

`3007` 只给本机 Nginx 反代使用，不对公网开放。公网入口继续由 Nginx 的 `80/443` 处理。

## 本地构建发布包

如果本机 Docker 已启动，推荐直接本地构建镜像 tar 包：

```bash
scripts/cn-build-release.sh 20260518-1
```

脚本会依次执行：

```bash
pnpm typecheck
pnpm test
pnpm build
docker build
docker save
```

输出文件在 `releases/hive-mp-publish-20260518-1.tar.gz`。

如果本机 Docker 没启动，或者希望完全在国内服务器上 build，可以用：

```bash
scripts/cn-build-on-server.sh 20260518-1
```

这个脚本会在本地先跑 `typecheck/test/build`，然后上传源码包到服务器，在服务器 Docker 里构建镜像。默认 npm registry 使用：

```text
https://registry.npmmirror.com
```

可通过环境变量覆盖：

```bash
NPM_CONFIG_REGISTRY=https://registry.npmjs.org scripts/cn-build-on-server.sh 20260518-1
```

## 上传到服务器

```bash
scripts/cn-upload-release.sh releases/hive-mp-publish-20260518-1.tar.gz
```

脚本会创建远端目录，并上传：

- 镜像 tar 包到 `/home/xavier/hive-mp-publish/releases/`
- 远端部署脚本到 `/home/xavier/hive-mp-publish/bin/`
- Nginx 模板到 `/home/xavier/hive-mp-publish/nginx/`

## 在服务器部署容器

```bash
ssh ResoPodXavierCN /home/xavier/hive-mp-publish/bin/hive-mp-publish-deploy.sh \
  /home/xavier/hive-mp-publish/releases/hive-mp-publish-20260518-1.tar.gz
```

如果是 `cn-build-on-server.sh` 在服务器上直接构建出来的镜像，则部署命令是：

```bash
ssh ResoPodXavierCN /home/xavier/hive-mp-publish/bin/hive-mp-publish-deploy.sh \
  hive-mp-publish:20260518-1
```

部署脚本只管理名为 `hive-mp-publish-gateway` 的容器。它会：

- 拒绝占用非本服务的 `3007` 端口；
- `docker load` 新镜像；
- 如果已有同名容器，停止并重命名为 `hive-mp-publish-gateway-previous-*`；
- 启动新容器；
- 检查 `http://127.0.0.1:3007/health`；
- 失败时尝试回滚到上一个容器。

## 签发客户 API key

```bash
ssh ResoPodXavierCN docker run --rm \
  -v /home/xavier/hive-mp-publish/data:/data \
  hive-mp-publish:20260518-1 \
  key issue --name customer-a
```

返回的完整 API key 只显示一次；SQLite 里只保存 hash。

## Nginx

模板在服务器：

```bash
/home/xavier/hive-mp-publish/nginx/nginx-hive-mp-publish.conf.template
```

需要先确定域名，例如 `mp.resopod.cn` 或其他专用域名，并申请证书。然后把模板里的 `mp-gateway.example.com` 替换为真实域名，再放到 `/etc/nginx/sites-available/` 并启用。

不要直接把 Docker 宿主机端口 `3007` 暴露公网。Nginx 应该代理到：

```text
http://127.0.0.1:3007
```

当前 ResoPod CN 服务器已经启用：

- 域名: `https://mp.resopod.cn`
- Nginx site: `/etc/nginx/sites-available/mp-resopod-cn`
- TLS cert: `/etc/letsencrypt/live/mp.resopod.cn/`
- 反代目标: `http://127.0.0.1:3007`

## 验证

本机容器健康检查：

```bash
ssh ResoPodXavierCN curl -fsS http://127.0.0.1:3007/health
```

公网 HTTPS 生效后：

```bash
curl -fsS https://your-gateway-domain/health
```

客户发布时使用 HTTPS Gateway URL：

```bash
hive-mp-publish publish -f article.md \
  --app-id customer-local-alias-or-wx-appid \
  --server https://your-gateway-domain \
  --api-key hmp_live_xxx
```

## 回滚

部署成功后，旧容器会保留为：

```text
hive-mp-publish-gateway-previous-YYYYMMDDHHMMSS
```

如需手动回滚，先停当前容器，再把 previous 容器改回原名并启动。只操作 `hive-mp-publish-gateway` 相关容器，不影响服务器上已有的 Bugsink、relay 等服务。
