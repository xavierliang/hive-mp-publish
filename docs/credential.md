## credential：凭据管理

管理客户端本地凭据，包括微信公众号开发者凭据（AppID 和 AppSecret）以及默认 Gateway URL/API key。

本页命令是客户侧全局 CLI，入口为 Bun-first。先按 [Agent 安装指南](../install/hive-mp-publish.md) 安装，并确认 `bun --version` 可运行；如果命令启动时报 `/usr/bin/env: bun: No such file or directory` 或 `bun: No such file or directory`，安装 Bun 或把 Bun 的 `bin` 目录加入 `PATH`。

**查看凭据存储位置：**

```bash
hive-mp-publish credential -l
```

**交互式配置凭据：**

执行该命令后，程序将引导你安全地输入微信公众号凭据，并可选保存 Gateway API key。Gateway URL 默认使用 `https://mp.resopod.cn`。

```bash
hive-mp-publish credential -s
```

**关于“别名 (Alias)”：**
在配置过程中，你可以为复杂的 AppID（如 `wx1234567890abcdef`）设置一个简单的别名（如 `my-mp` 或 `dev`）。
* **作用**：在后续执行发布命令时，你可以直接使用别名代替 AppID，极大地提高输入效率。
* **可选性**：别名是可选的。如果跳过，后续命令需直接输入 AppID。

### Gateway 配置

查看当前 Gateway 配置：

```bash
hive-mp-publish credential --show-gateway
```

首次或轮换 API key：

```bash
hive-mp-publish credential --set-gateway --api-key hmp_live_xxx
```

切换到其他 Gateway：

```bash
hive-mp-publish credential --set-gateway \
  --server https://other-gateway.example.com \
  --api-key hmp_live_xxx
```

清除本机保存的 Gateway 配置：

```bash
hive-mp-publish credential --clear-gateway
```

保存后，发布命令可省略 `--server` 和 `--api-key`：

```bash
hive-mp-publish publish -f article.md --app-id my-mp
```

如果本次要绕过已保存的 Gateway，从当前机器直连微信，发布时加 `--local`。

### 参数说明

| 参数 | 简写 | 说明 | 必填 |
| :--- | :--- | :--- | :--- |
| `--location` | `-l` | 获取本地配置凭据的实际存储路径 (`credential.json`) | 否 |
| `--set` | `-s` | 触发交互式设置流程，保存或更新微信公众号凭据 (AppID & AppSecret) | 否 |
| `--set-gateway` | - | 保存或更新默认 Gateway URL/API key | 否 |
| `--show-gateway` | - | 显示已保存的 Gateway URL 和脱敏 API key | 否 |
| `--clear-gateway` | - | 删除本机保存的 Gateway 配置 | 否 |
| `--server <url>` | - | 配合 `--set-gateway` 覆盖默认 Gateway URL | 否 |
| `--api-key <key>` | - | 配合 `--set-gateway` 保存 Gateway API key | 否 |
