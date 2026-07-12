# Deno-Free-All / FreeInOne API

部署在 **Deno Deploy** 上的轻量级多协议 AI API 网关，提供 OpenAI 兼容代理、Gemini 原生 `v1beta` 透传、多渠道/多 Key 无状态分流、故障切换和内置 Web 管理面板。

> 本项目不提供任何上游模型或 API Key。请自行准备合法的上游服务与密钥，并遵守相应服务条款。

## 功能

- OpenAI 兼容 `/v1/*` 代理
- Gemini 原生 `/v1beta/*` 请求、响应和 SSE 流透传
- 显式区分 OpenAI / Gemini 渠道，避免跨协议误路由
- 一个母渠道配置多个上游 Key
- 每个 Key 作为独立运行时子渠道，共享 Base URL、模型、前缀和权重
- 无状态加权随机分流，不为每个代理请求写入 Deno KV
- 网络异常及 `401、403、408、425、429、5xx` 自动切换其他 Key/渠道
- 模型前缀、关键词过滤和手动模型选择
- OpenAI 与 Gemini 各自的聚合模型列表
- 独立网关访问密钥、管理员会话和 Deno KV 配置持久化
- 匿名路由诊断响应头
- 旧单 Key 渠道自动兼容升级

## 架构

```text
OpenAI 客户端 ── /v1/* ───────┐
                               │ 网关访问密钥
Gemini 客户端 ─ /v1beta/* ────┤
                               ▼
                         FreeInOne API
                               │
                   协议隔离 + 模型匹配
                               │
                    无状态加权选择子 Key
                    ┌──────────┴──────────┐
                    ▼                     ▼
               母渠道 A / Key 1      母渠道 A / Key 2
```

## 两类密钥

| 类型 | 配置位置 | 用途 |
| --- | --- | --- |
| 网关访问密钥 | 管理面板 → 访问密钥 | 客户端访问本项目时鉴权 |
| 上游 API Key | 管理面板 → 渠道管理 | 本项目访问 OpenAI/Gemini 上游 |

“访问密钥”不会作为上游 Key 轮转。需要轮转多个上游 Key 时，在同一个母渠道的 **API Keys** 文本框中一次粘贴多个 Key。

## 母渠道与多 Key

API Keys 支持：

```text
key-one
key-two
key-three
```

也支持逗号、分号或 JSON 数组：

```json
["key-one", "key-two", "key-three"]
```

保存后：

- 面板只显示一个母渠道；
- 展开“子渠道”可查看匿名 Key 序号和末 4 位；
- 每个 Key 可单独启停、测速和删除；
- 每个启用 Key 继承母渠道完整权重；
- 增加 Key 会增加该母渠道的总候选权重和可用容量。

例如两个 Key 均继承权重 10，长期流量大约为 50:50，但不会严格交替。

## 协议支持

### OpenAI

支持并透传 `/v1/*`，其中 `/v1/models` 返回所有启用 OpenAI 母渠道的聚合模型列表。

客户端配置：

```text
Base URL: https://你的域名/v1
API Key:  管理面板生成的网关访问密钥
```

适用于 OpenAI SDK、SillyTavern 及其他 OpenAI 兼容客户端。

### Gemini 原生

支持 Gemini 原生 `/v1beta/*`，不进行 OpenAI `messages/choices` 与 Gemini `contents/candidates` 之间的格式转换。

Gemini 客户端可通过以下任意方式提交网关访问密钥：

```http
x-goog-api-key: 网关访问密钥
```

```text
?key=网关访问密钥
```

```http
Authorization: Bearer 网关访问密钥
```

网关验证后会删除客户端凭证，并仅向上游注入所选子渠道的 `x-goog-api-key`。

示例：

```bash
curl "https://你的域名/v1beta/models/gm/gemini-2.5-pro:generateContent" \
  -H "x-goog-api-key: 你的网关访问密钥" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role":"user","parts":[{"text":"Hello"}]}]
  }'
```

流式接口保持 Gemini 原生格式：

```text
/v1beta/models/{model}:streamGenerateContent?alt=sse
```

> **有状态资源提示：** Files、Caches 等 `/v1beta/*` 资源同样可以透传，但多 Key 无状态分流无法保存资源与 Key 的亲和关系。只有这些 Key 属于同一 Google 项目且资源互相可见时，跨请求访问才可靠。

## 模型前缀

假设 Gemini 母渠道设置：

```text
前缀：gm
原始模型：gemini-2.5-pro
```

客户端调用：

```text
/v1beta/models/gm/gemini-2.5-pro:generateContent
```

上游实际收到：

```text
/v1beta/models/gemini-2.5-pro:generateContent
```

OpenAI 请求体中的 `model` 字段使用相同的前缀移除逻辑。

## 故障切换

出现网络异常或以下状态码时，会剔除当前子 Key 并尝试其他候选：

```text
401、403、408、425、429、5xx
```

- 每个运行时子渠道最多尝试一次；
- 单个客户端请求最多尝试 5 个候选；
- 正常响应只会产生一次上游请求；
- HTTP 200 返回后发生的 SSE 中途错误无法再切换渠道。

## 部署到 Deno Deploy

1. Fork 或克隆本仓库。
2. 登录 [Deno Deploy](https://dash.deno.com/)。
3. 创建项目并关联 GitHub 仓库。
4. 将入口文件设置为 `main.ts`。
5. 确保项目可以使用 Deno KV，然后部署。
6. 访问 `https://你的域名/admin` 完成首次初始化。

仓库主要文件：

```text
main.ts          # Hono 后端、鉴权、路由和代理
admin.html       # 内置管理面板
tests/smoke.mjs  # 配置兼容、Key 解析和路由静态回归测试
```

## 本地运行

需要安装 Deno：

```bash
deno run --allow-net --allow-read --unstable-kv main.ts
```

默认管理地址：

```text
http://localhost:8000/admin
```

如果当前 Deno 版本已稳定支持 KV，可移除 `--unstable-kv`。

## 路由诊断

响应包含匿名诊断头：

```text
X-Freeone-Channel: channel-2-key-3
X-Freeone-Attempt: 1
```

它不会暴露渠道名称、Base URL 或 API Key。标准客户端会忽略未知响应头，不影响 JSON 或 SSE 兼容性。

## 配置兼容

- 当前配置结构版本为 `schemaVersion: 3`。
- 旧渠道的单个 `apiKey` 会在读取时转换成单元素 `apiKeys[]`。
- 旧渠道默认视为 OpenAI 协议。
- 不会自动合并 Base URL 相同的旧渠道。
- 下一次从管理面板保存配置时会持久化新结构。
- 旧版 KV 键 `CONFIG` 仍可通过管理面板迁移到 `CONFIG_V2`。

## 测试

Node.js 25+ 可运行源码级回归测试：

```bash
node tests/smoke.mjs
node --experimental-strip-types --check main.ts
```

管理面板脚本语法检查：

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('admin.html','utf8');for(const [i,m] of [...h.matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/g)].entries()){new Function(m[1]);console.log('script',i+1,'ok')}"
```

## 安全说明

- 上游 API Key 必须用于转发，因此以可恢复形式保存在 Deno KV；请保护管理面板和 Deno Deploy 项目权限。
- 管理员密码使用 PBKDF2-SHA-256 和随机盐保存。
- 管理会话令牌在 KV 中以 SHA-256 摘要保存，默认有效期 7 天。
- 不要把真实 API Key、管理员令牌或生产配置提交到 GitHub。
- 查询参数 `?key=` 可能出现在客户端或边缘访问日志中；能配置请求头时优先使用 `x-goog-api-key` 或 Bearer。
- 公开分享网关访问密钥会允许持有者消耗所有已启用上游渠道的额度。

## 免责声明

本项目仅作为 API 网关与开发学习工具。使用者应遵守上游服务条款、当地法律法规及数据安全要求，并自行承担密钥泄露、额度消耗、上游故障或不当使用造成的风险。
