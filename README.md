# Deno-Free-All

一个部署在 **Deno Deploy** 上的轻量级 OpenAI 兼容 API 网关。支持配置多个上游渠道、模型前缀、模型过滤、无状态加权分流及故障切换，并提供内置 Web 管理面板。

> 本项目不会提供任何上游模型或 API Key。使用者需要自行准备合法的 OpenAI 兼容上游服务及密钥。

## 功能特性

- OpenAI 兼容的 `/v1/*` 请求代理
- 多上游渠道管理
- 每个渠道独立配置 Base URL、API Key 和权重
- 无状态加权随机分流，适合 Deno Deploy 多实例和冷启动环境
- 上游故障时自动尝试其他可用渠道
- 模型前缀与原始模型名自动转换
- 支持全部透传、关键词过滤和手动选择模型
- 聚合所有启用渠道的 `/v1/models`
- 独立的网关访问密钥
- Web 管理面板与管理员会话
- Deno KV 配置持久化
- 旧版 `CONFIG` 配置迁移到 `CONFIG_V2`
- 匿名路由诊断响应头

## 工作方式

```text
OpenAI 客户端 / SillyTavern / 其他兼容客户端
                       │
                       │ 网关访问密钥
                       ▼
                Deno-Free-All
                       │
             模型匹配 + 权重选择
                 ┌─────┴─────┐
                 ▼           ▼
              渠道 A       渠道 B
              API Key A    API Key B
```

### 两类 Key 的区别

请注意，项目中有两类不同用途的密钥：

| 类型 | 配置位置 | 用途 |
| --- | --- | --- |
| 网关访问密钥 | 管理面板 → 访问密钥 | 客户端调用本项目时用于鉴权 |
| 上游 API Key | 管理面板 → 渠道管理 | 本项目转发请求时用于访问上游 |

“访问密钥”页面中的多个 Key 只是允许多个客户端访问网关，**不会作为上游 Key 池轮转**。

如果同一个提供商有多个上游 API Key，请为每个 Key 创建一个渠道，并保持它们的 Base URL、模型前缀和模型配置一致。

## 路由策略

### 无状态加权分流

项目使用无状态加权随机选择，不依赖进程内计数器，也不会为每次请求写入 Deno KV，因此适合 Deno Deploy 的无状态、多实例运行方式。

例如：

| 渠道 | 权重 | 长期流量比例 |
| --- | ---: | ---: |
| 渠道 A | 10 | 约 50% |
| 渠道 B | 10 | 约 50% |

权重表示长期概率，并不保证每两次请求严格交替。

### 故障切换

当选中的上游出现网络异常，或返回以下状态码时，网关会尝试其他符合该模型的渠道：

```text
401、403、408、425、429、5xx
```

每个候选渠道最多尝试一次，并设置最多 5 次尝试的安全上限。正常请求只会调用一个上游；只有前一个渠道失败时才会产生后续尝试。

> 对于已经返回 HTTP 200、随后在 SSE 流中发生的错误，网关无法安全地切换到其他渠道。

## 部署到 Deno Deploy

### 1. 上传到 GitHub

仓库至少需要包含：

```text
.
├── main.ts
├── admin.html
└── README.md
```

### 2. 创建 Deno Deploy 项目

1. 登录 [Deno Deploy](https://dash.deno.com/)。
2. 创建新项目并关联 GitHub 仓库。
3. 将生产分支设置为你的 GitHub 默认分支。
4. 将入口文件设置为 `main.ts`。
5. 完成部署。

应用通过 `Deno.openKv()` 使用 Deno KV 保存配置。请确保部署环境支持并已启用 KV。

### 3. 初始化管理面板

部署完成后访问：

```text
https://你的域名/admin
```

首次打开时：

1. 设置管理员密码，至少 6 位。
2. 添加一个或多个上游渠道。
3. 拉取上游模型列表，并根据需要设置过滤模式。
4. 在“访问密钥”页面生成客户端调用网关所需的密钥。

## 本地运行

需要安装 [Deno](https://deno.com/)。

```bash
deno run --allow-net --allow-read --unstable-kv main.ts
```

默认访问地址：

```text
http://localhost:8000/admin
```

不同 Deno 版本对 KV 的命令行参数可能不同。如果当前版本已经稳定支持 KV，可以移除 `--unstable-kv`。

## 客户端配置

以 OpenAI 兼容客户端为例：

```text
API Base URL: https://你的域名/v1
API Key:      管理面板中生成的网关访问密钥
```

SillyTavern 等客户端应选择 OpenAI 兼容接口，并填写相同的 Base URL 和网关访问密钥。

### 请求示例

```bash
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer 你的网关访问密钥" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "prefix/model-name",
    "messages": [
      {"role": "user", "content": "Hello"}
    ],
    "stream": false
  }'
```

### 获取模型列表

```bash
curl https://你的域名/v1/models \
  -H "Authorization: Bearer 你的网关访问密钥"
```

## 模型前缀

假设渠道配置如下：

```text
模型前缀：hy
上游模型：deepseek-v4-flash
```

客户端请求：

```json
{
  "model": "hy/deepseek-v4-flash"
}
```

转发到该渠道时，网关会自动还原为：

```json
{
  "model": "deepseek-v4-flash"
}
```

模型前缀可用于区分不同提供商中名称相同的模型。

## 路由诊断响应头

代理响应包含两个可选诊断信息：

```text
X-Freeone-Channel: channel-3
X-Freeone-Attempt: 1
```

- `X-Freeone-Channel`：实际返回响应的匿名渠道序号。
- `X-Freeone-Attempt`：本次请求的上游尝试次数。

响应头不会包含渠道名称、Base URL 或 API Key。标准 HTTP 客户端会忽略不认识的自定义响应头，因此不会影响 OpenAI 客户端或 SillyTavern 对 JSON、SSE 流的解析。

PowerShell 查看方式：

```powershell
$response = Invoke-WebRequest `
  -Uri "https://你的域名/v1/chat/completions" `
  -Method POST `
  -Headers @{ Authorization = "Bearer 你的网关访问密钥" } `
  -ContentType "application/json" `
  -Body '{"model":"prefix/model-name","messages":[{"role":"user","content":"hi"}],"stream":false}'

$response.Headers["X-Freeone-Channel"]
$response.Headers["X-Freeone-Attempt"]
```

## 管理接口与代理接口

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/admin` | GET | Web 管理面板 |
| `/api/config` | GET / POST | 管理配置、登录、测速和模型拉取 |
| `/v1/models` | GET | 返回已启用渠道的聚合模型列表 |
| `/v1/*` | ALL | OpenAI 兼容请求代理 |

## 安全说明

- 上游 API Key 需要用于请求签名，因此会以可恢复形式保存在 Deno KV 中；请保护好 Deno Deploy 项目和管理面板权限。
- 管理员密码使用 PBKDF2-SHA-256 和随机盐保存，不保存明文密码。
- 管理员会话令牌在 KV 中以 SHA-256 摘要保存，默认有效期为 7 天。
- 请使用强管理员密码，并定期轮换网关访问密钥和上游 API Key。
- 不要把真实 API Key、管理员令牌或导出的生产配置提交到 GitHub。
- 项目默认允许跨域访问，但 `/v1/*` 仍要求有效的网关访问密钥。
- 如果公开分享网关访问密钥，任何持有者都可以消耗已启用渠道的上游额度。

## 配置迁移

如果检测到旧版 Deno KV 键 `CONFIG`，管理面板会提供迁移入口，将旧渠道与访问密钥迁移到 `CONFIG_V2`。迁移需要验证旧版管理密码，并设置新的管理员密码。

## 常见问题

### 配置多个“访问密钥”为什么没有轮转上游 Key？

访问密钥只用于客户端鉴权。要分流多个上游 Key，需要为每个上游 Key 创建独立渠道。

### 两个等权渠道为什么不是严格一人一次？

Deno Deploy 是无状态、多实例环境。项目使用无状态加权随机分流，等权渠道会在足够多的请求下接近 50:50，但短时间内可能连续命中同一渠道。

### 会不会每个请求同时请求所有渠道？

不会。正常情况下只请求一个渠道；只有网络异常或可重试状态码出现时，才会尝试下一个渠道。

### 自定义响应头会影响第三方客户端吗？

不会。未知响应头会被标准客户端忽略，响应 JSON 和 SSE 数据格式没有改变。

## 项目文件

```text
main.ts     # Deno/Hono 后端、鉴权、路由和代理逻辑
admin.html  # 内置管理面板
```

## 免责声明

本项目仅作为 API 网关与开发学习工具。使用者应遵守上游服务条款、当地法律法规及相关数据安全要求，并自行承担因密钥泄露、额度消耗、上游故障或不当使用造成的风险。
