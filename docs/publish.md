# Publish

`publish` 将 Markdown 渲染为微信公众号图文 HTML，并发布到草稿箱。

本页命令是客户侧全局 CLI，入口为 Bun-first。先按 [Agent 安装指南](../install/hive-mp-publish.md) 安装，并确认 `bun --version` 可运行；如果命令启动时报 `/usr/bin/env: bun: No such file or directory` 或 `bun: No such file or directory`，安装 Bun 或把 Bun 的 `bin` 目录加入 `PATH`。

## 本地凭据

推荐先把公众号凭据保存在客户本机：

```bash
hive-mp-publish credential --set
```

如果同时保存了 Gateway API key，日常发布不需要再传 `--server` 和 `--api-key`。默认 Gateway URL 是 `https://mp.resopod.cn`。

也可以在发布命令中直接传 `--app-secret`，但不建议写进 shell history 或脚本日志。

## 通过 Gateway 发布

已保存 Gateway 配置时：

```bash
hive-mp-publish publish -f article.md --app-id your-local-alias-or-appid
```

临时覆盖 Gateway 时：

```bash
hive-mp-publish publish -f article.md \
  --app-id your-local-alias-or-appid \
  --server https://mp-gateway.example.com \
  --api-key hmp_live_xxx
```

客户端会：

1. 在本地读取 Markdown 和本地图片。
2. 渲染微信公众号 HTML。
3. 将本地图片上传到 Gateway 临时目录。
4. 将 `appid/appSecret` 随单次 HTTPS `/publish` 请求发送到 Gateway。
5. Gateway 调微信接口创建草稿。

远程 Gateway 必须使用 HTTPS。只有 localhost 联调或显式 `--allow-insecure-http` 才允许 HTTP。

## 本地直连发布

未保存 Gateway 配置时，默认保留上游本地直连能力：

```bash
hive-mp-publish publish -f article.md --app-id your-local-alias-or-appid
```

如果已经保存 Gateway 配置，但本次要从客户机器直连微信，显式加 `--local`：

```bash
hive-mp-publish publish -f article.md --app-id your-local-alias-or-appid --local
```

这种模式要求客户机器 IP 自己在微信公众号 IP 白名单中。

## Frontmatter

```md
---
title: 文章标题
cover: ./cover.jpg
author: 作者
source_url: https://example.com/original
need_open_comment: 1
only_fans_can_comment: 0
---

正文。

![](./image.png)
```

`title` 必填。`cover` 可用本地路径或 HTTPS 图片；如果正文第一张图可作为封面，也可以省略。

## 图片消息

设置 `type: image` 后，正文图片会作为图片消息素材：

```md
---
title: 图片消息标题
type: image
---

![](./1.jpeg)
![](./2.jpeg)
```

## 常用参数

| 参数 | 说明 |
| --- | --- |
| `-f, --file <path>` | Markdown 文件路径 |
| `--app-id <id-or-alias>` | 公众号 AppID 或本地凭据别名 |
| `--app-secret <secret>` | 公众号 AppSecret，不推荐长期写入脚本 |
| `--server <url>` | 临时覆盖 Gateway HTTPS URL |
| `--api-key <key>` | 临时覆盖 Gateway API key |
| `--local` | 绕过已保存的 Gateway 配置，从本机直连微信 |
| `--env-file <file>` | 加载 `.env` 凭据 |
| `--theme <theme-id>` | 排版主题 |
| `--custom-theme <path>` | 自定义 CSS |

Gateway 配置读取优先级：

```text
命令行参数 > 环境变量 > credential.json > 默认 Gateway URL
```
