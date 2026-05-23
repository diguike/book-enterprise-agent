---
title: "附录 A — AgentFlow API 参考"
feishu_url: "https://www.feishu.cn/wiki/IlqKwL5ywiJsE0kFwkMc7bpQnec"
last_synced: "2026-05-11T17:29:51.121Z"
---

## 通用约定

本附录把全书构建的 AgentFlow 平台所有对外 HTTP 接口整理成可查阅的参考文档。所有接口遵循以下统一约定，后文不再重复说明。

### Base URL 与版本

```
生产：https://api.agentflow.example.com
预发：https://api-staging.agentflow.example.com
```

所有接口都以 `/api/v1` 为前缀，路径中显式包含版本号。Breaking change 会通过引入 `/api/v2` 实现，老版本保留至少 12 个月的过渡期。

### 认证

所有接口（除健康检查 `/healthz` 外）都要求在请求头携带 Bearer Token：

```
Authorization: Bearer <jwt-token>
```

JWT 由租户在控制台创建 API Key 后换取，载荷中包含 `tenant_id`、`scope`、`exp` 三个关键字段。Token 过期时间默认 24 小时，可由租户管理员调整为 1 小时到 30 天之间。租户的 API Key 只能调用业务 API（前四组），管理员 API（第 5 组）必须使用平台运营颁发的 root token。

### 请求与响应格式

请求体统一使用 JSON（`Content-Type: application/json`），文件上传场景使用 `multipart/form-data`。响应体始终是 JSON，编码 UTF-8。

成功响应的 HTTP 状态码遵循语义：

| 状态码 | 含义 |
|--------|------|
| `200 OK` | 同步操作成功 |
| `201 Created` | 资源创建成功，响应体包含新资源 |
| `202 Accepted` | 异步任务已接收，响应体包含 `task_id` |
| `204 No Content` | 操作成功无返回体（如 DELETE） |

### 错误响应

所有错误响应使用统一结构：

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded: 60 req/min",
    "details": {
      "retry_after_seconds": 12,
      "limit": 60,
      "current": 61
    },
    "request_id": "req_01HXYZ..."
  }
}
```

字段说明：

- `code`：机器可读的错误码（大写下划线格式）
- `message`：人类可读的描述，不要在客户端做字符串匹配
- `details`：可选的结构化补充信息，不同错误码字段不同
- `request_id`：本次请求的追踪 ID，工单求助时附上这个值能快速定位

完整错误码列表：

| HTTP | code | 含义 |
|------|------|------|
| 400 | `INVALID_REQUEST` | 请求体格式错误或字段校验失败 |
| 400 | `INVALID_SESSION_STATE` | 会话状态不允许该操作（如已结束的会话不能继续发消息） |
| 401 | `UNAUTHORIZED` | Token 缺失或无效 |
| 401 | `TOKEN_EXPIRED` | Token 已过期 |
| 403 | `FORBIDDEN` | 权限不足（scope 不包含该资源） |
| 403 | `TENANT_SUSPENDED` | 租户被冻结 |
| 404 | `NOT_FOUND` | 资源不存在 |
| 409 | `CONFLICT` | 资源冲突（如重复创建同名 skill） |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体或上传文件超过限制 |
| 422 | `SKILL_EXECUTION_FAILED` | Skill 执行返回错误 |
| 422 | `LLM_PROVIDER_ERROR` | 上游 LLM 返回错误（包装后透传） |
| 429 | `RATE_LIMIT_EXCEEDED` | 触发租户级限流 |
| 429 | `QUOTA_EXCEEDED` | 本月 Token 配额耗尽 |
| 500 | `INTERNAL_ERROR` | 平台内部错误，附 request_id 求助 |
| 503 | `SERVICE_UNAVAILABLE` | 上游服务不可用（如 LLM provider 全部宕机） |

### 分页

列表类接口统一使用 cursor 分页，不使用 offset。请求参数：

- `limit`：每页条数，默认 20，最大 100
- `cursor`：上一页响应中返回的 `next_cursor` 值，首次请求不传

响应结构：

```json
{
  "items": [ ... ],
  "next_cursor": "eyJpZCI6...",
  "has_more": true
}
```

`next_cursor` 为 `null` 或 `has_more` 为 `false` 表示已经到达末页。Cursor 是不透明字符串，客户端不要尝试解析。

### 速率限制

每个租户都有独立的速率限制桶，按 API 分组单独计算。响应头会带回当前限流状态：

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 1715414400
```

具体的限制值在各 API 章节内列出。触发限流会返回 `429`，响应头 `Retry-After` 给出建议等待秒数。

---

## 一、会话 API

### `POST /api/v1/chat`

向 agent 发送一条消息，返回 SSE 流式响应。这是 AgentFlow 最核心的接口，第 3 章详细讲过它的实现。

请求示例：

```http
POST /api/v1/chat HTTP/1.1
Host: api.agentflow.example.com
Authorization: Bearer eyJhbGc...
Content-Type: application/json
Accept: text/event-stream

{
  "session_id": "sess_01HXYZ123",
  "message": "帮我查一下上海明天的天气",
  "user_id": "user_42",
  "metadata": {
    "channel": "web-widget",
    "locale": "zh-CN"
  },
  "stream": true
}
```

请求字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_id` | string | 否 | 会话 ID，留空则自动创建新会话并在响应首个事件中返回 |
| `message` | string | 是 | 用户消息文本，最大 32 KB |
| `user_id` | string | 是 | 租户内的终端用户唯一 ID，用于隔离不同用户的会话历史 |
| `metadata` | object | 否 | 自定义元数据，会写入日志和审计追踪，单个值不超过 1 KB |
| `stream` | boolean | 否 | 默认 `true`。设为 `false` 则等待完整响应一次性返回 JSON |

响应（SSE 流）：

```
event: session_started
data: {"session_id":"sess_01HXYZ123","created_at":"2025-05-11T08:00:00Z"}

event: token
data: {"delta":"上海"}

event: token
data: {"delta":"明天"}

event: tool_call
data: {"skill_id":"query-weather","input":{"city":"上海","date":"2025-05-12"},"call_id":"call_001"}

event: tool_result
data: {"call_id":"call_001","output":{"temperature_c":22,"condition":"多云"}}

event: token
data: {"delta":"是多云，气温 22 度。"}

event: done
data: {"finish_reason":"stop","usage":{"prompt_tokens":1245,"completion_tokens":87,"total_tokens":1332}}
```

事件类型：

| event | 说明 |
|-------|------|
| `session_started` | 会话创建（仅新会话首次返回） |
| `token` | 文本增量，前端按 `delta` 拼接 |
| `tool_call` | Agent 决定调用 skill |
| `tool_result` | Skill 执行完成 |
| `tool_error` | Skill 执行失败，agent 会自行决定是否重试 |
| `error` | 终止性错误，流会立即关闭 |
| `done` | 本轮对话结束，附带 token 用量 |

非流式响应（`stream: false`）：

```json
{
  "session_id": "sess_01HXYZ123",
  "message_id": "msg_01HXYZ456",
  "content": "上海明天是多云，气温 22 度。",
  "tool_calls": [
    { "skill_id": "query-weather", "input": {...}, "output": {...} }
  ],
  "usage": {
    "prompt_tokens": 1245,
    "completion_tokens": 87,
    "total_tokens": 1332
  },
  "finish_reason": "stop"
}
```

错误情况：

- `429 RATE_LIMIT_EXCEEDED`：当前租户超出 chat 接口的 QPS 上限
- `429 QUOTA_EXCEEDED`：本月 token 用量已经耗尽
- `422 LLM_PROVIDER_ERROR`：所有上游 LLM 都不可用（gateway 已经做过重试）

速率限制：

- 默认 60 req/min per tenant，可在控制台升级
- 单租户并发流式连接数默认 100，超出新请求会被 `429` 拒绝

### `GET /api/v1/sessions/{sessionId}`

查询历史会话。第 7 章实现的 session store 把消息保存在 PostgreSQL + Redis 双层结构里，这个接口读的是合并视图。

请求示例：

```http
GET /api/v1/sessions/sess_01HXYZ123?limit=50 HTTP/1.1
Authorization: Bearer eyJhbGc...
```

查询参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `limit` | int | 返回的消息条数，默认 20，最大 200 |
| `cursor` | string | 翻页游标，按时间倒序 |
| `include_tool_calls` | bool | 是否包含 tool_call 细节，默认 `false`，开启后体积变大 |

响应：

```json
{
  "session_id": "sess_01HXYZ123",
  "user_id": "user_42",
  "status": "active",
  "created_at": "2025-05-11T08:00:00Z",
  "last_active_at": "2025-05-11T08:05:23Z",
  "messages": [
    {
      "message_id": "msg_001",
      "role": "user",
      "content": "帮我查一下上海明天的天气",
      "created_at": "2025-05-11T08:00:00Z"
    },
    {
      "message_id": "msg_002",
      "role": "assistant",
      "content": "上海明天是多云，气温 22 度。",
      "tool_calls": [],
      "created_at": "2025-05-11T08:00:03Z"
    }
  ],
  "metadata": {
    "channel": "web-widget"
  },
  "next_cursor": null,
  "has_more": false
}
```

`status` 取值：`active`、`ended`、`expired`（默认 30 分钟无活动自动过期，TTL 滑动续期，租户可调）。归档后的会话只读，但仍能通过本接口查询。

错误情况：

- `404 NOT_FOUND`：会话不存在或属于其他租户

速率限制：300 req/min per tenant。

### `POST /api/v1/sessions/{sessionId}/end`

主动结束会话。结束后该会话进入只读状态，无法继续发送消息。结束会触发可观测性管道写入对话总结、用户标签、满意度评分等聚合数据（见第 11 章）。

请求示例：

```http
POST /api/v1/sessions/sess_01HXYZ123/end HTTP/1.1
Authorization: Bearer eyJhbGc...
Content-Type: application/json

{
  "reason": "user_closed",
  "feedback": {
    "rating": 5,
    "comment": "解决了我的问题"
  }
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `reason` | enum | 否 | `user_closed` / `timeout` / `transferred` / `system`，默认 `user_closed` |
| `feedback.rating` | int | 否 | 1-5 评分 |
| `feedback.comment` | string | 否 | 文本反馈，最大 2 KB |

响应：

```json
{
  "session_id": "sess_01HXYZ123",
  "status": "ended",
  "ended_at": "2025-05-11T08:10:00Z",
  "summary_task_id": "task_summary_xxx"
}
```

`summary_task_id` 是后台异步生成对话总结的任务 ID，可用 `GET /api/v1/tasks/{taskId}` 轮询（任务接口为内部使用，控制台调用）。

错误情况：

- `400 INVALID_SESSION_STATE`：会话已经处于 `ended` 状态

速率限制：60 req/min per tenant。

---

## 二、Skill 管理 API

第 5 章实现了四种自定义 skill 形态：Webhook、Code（在 isolated-vm 沙箱内执行的 JS 片段）、Sub-Agent（把另一个 Agent 当作 skill 调用）、MCP（连接外部 MCP server）。加上平台内置的 `builtin` 类型，数据库 `skills.type` 字段共 5 个枚举值（`builtin` / `webhook` / `code` / `subagent` / `mcp`），本节接口管理所有形态。

### `GET /api/v1/skills`

列出当前租户可见的所有 skill，包括平台内置和租户自定义两部分。

请求示例：

```http
GET /api/v1/skills?type=custom&limit=50 HTTP/1.1
Authorization: Bearer eyJhbGc...
```

查询参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | enum | `builtin` / `custom` / `all`，默认 `all` |
| `category` | string | 按分类筛选，详见附录 B |
| `enabled` | bool | 是否只看启用的 |
| `limit` / `cursor` | - | 通用分页参数 |

响应：

```json
{
  "items": [
    {
      "skill_id": "search-web",
      "name": "Web Search",
      "type": "builtin",
      "category": "search",
      "description": "通过 Brave 搜索引擎搜索互联网上的实时信息...",
      "enabled": true,
      "created_at": "2025-01-01T00:00:00Z"
    },
    {
      "skill_id": "skl_custom_xxx",
      "name": "查询订单状态",
      "type": "custom",
      "implementation": "webhook",
      "description": "根据订单号查询订单的当前状态",
      "enabled": true,
      "created_at": "2025-05-01T12:00:00Z",
      "updated_at": "2025-05-08T09:30:00Z"
    }
  ],
  "next_cursor": null,
  "has_more": false
}
```

### `POST /api/v1/skills`

创建自定义 skill。三种实现方式的请求体不同。

Webhook 类型：

```json
{
  "name": "查询订单状态",
  "description": "根据订单号查询订单的当前状态，输入订单号返回订单详情。仅适用于本商城订单。",
  "implementation": "webhook",
  "webhook": {
    "url": "https://api.tenant.com/agent/order-query",
    "method": "POST",
    "headers": {
      "X-API-Key": "{{secret.order_api_key}}"
    },
    "timeout_ms": 5000
  },
  "input_schema": {
    "type": "object",
    "properties": {
      "order_id": { "type": "string", "description": "订单号" }
    },
    "required": ["order_id"]
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "status": { "type": "string" },
      "total_amount": { "type": "number" }
    }
  }
}
```

`{{secret.xxx}}` 占位符引用租户在控制台保存的密钥，gateway 在调用时替换，不会写入日志。

Code 类型：

```json
{
  "name": "计算订单运费",
  "description": "...",
  "implementation": "code",
  "code": {
    "language": "javascript",
    "source": "module.exports = async function(input, ctx) {\n  const { weight, distance } = input;\n  return { fee: weight * 0.5 + distance * 0.1 };\n};",
    "timeout_ms": 3000,
    "memory_mb": 128
  },
  "input_schema": { ... },
  "output_schema": { ... }
}
```

Sub-Agent 类型（把另一个 Agent 作为 skill 调用，见 5.2 节）：

```json
{
  "name": "月度销售报告生成",
  "description": "调用销售分析子 Agent 完成跨天的报表生成任务",
  "implementation": "subagent",
  "subagent": {
    "agent_endpoint": "https://internal.agentflow.example.com/agents/sales-analyst",
    "auth_token_secret": "{{secret.subagent_token}}",
    "timeout_ms": 60000
  },
  "input_schema": { "type": "object", "properties": { "month": { "type": "string" } } },
  "output_schema": { "type": "object" }
}
```

MCP 类型（接入租户自托管的 MCP Server，见 5.4 节，`server_url` 必须是 Streamable HTTP Transport）：

```json
{
  "name": "Notion 集成",
  "implementation": "mcp",
  "mcp": {
    "server_url": "https://mcp.notion.so/...",
    "auth": { "type": "bearer", "token_secret": "{{secret.notion_token}}" },
    "allowed_tools": ["search", "create_page"]
  }
}
```

响应：返回完整 skill 对象，HTTP 状态 `201`。

错误情况：

- `409 CONFLICT`：同租户下已存在同名 skill
- `400 INVALID_REQUEST`：schema 不符合 JSON Schema Draft 7

### `PUT /api/v1/skills/{skillId}`

更新 skill。支持局部更新（PATCH 语义），未传字段保持原值。`implementation` 字段不可变，要换实现方式必须新建。

### `DELETE /api/v1/skills/{skillId}`

软删除。删除后该 skill 不会被列出，但保留 30 天可恢复。历史会话中已经调用过的记录不受影响。

响应：`204 No Content`。

### `POST /api/v1/skills/{skillId}/test`

在不创建真实会话的前提下测试 skill。

请求体：

```json
{
  "input": { "order_id": "ORD-2025-001" },
  "mock_secrets": false
}
```

响应：

```json
{
  "success": true,
  "output": { "status": "shipped", "total_amount": 199.0 },
  "duration_ms": 234,
  "logs": [
    "[info] 调用 https://api.tenant.com/agent/order-query",
    "[info] 响应 200 OK"
  ]
}
```

失败时 `success: false`，附 `error.code` 与 `error.message`。

速率限制：Skill 管理 API 共享 120 req/min per tenant；test 接口单独 30 req/min。

---

## 三、知识库 API

### `POST /api/v1/knowledge-bases`

创建知识库。第 6 章讲过，每个知识库对应一组 embedding + 一个独立的向量索引。

请求体：

```json
{
  "name": "产品手册",
  "description": "公司全线产品手册和 FAQ",
  "embedding_model": "voyage-3",
  "chunk_strategy": {
    "method": "semantic",
    "max_tokens": 512,
    "overlap_tokens": 50
  }
}
```

`embedding_model` 取值见第 6 章，支持 `voyage-3`（1024 维，默认）和 `text-embedding-3-small`（1536 维）。选定后不可更换——换模型等于全库重建索引。`chunk_strategy.method` 支持 `fixed`（固定字数）、`semantic`（按句子语义切）、`markdown`（按标题层级）。

响应：返回知识库对象，包含 `kb_id`。

### `POST /api/v1/knowledge-bases/{kbId}/documents`

上传文档。使用 `multipart/form-data`。

请求示例：

```http
POST /api/v1/knowledge-bases/kb_xxx/documents HTTP/1.1
Authorization: Bearer eyJhbGc...
Content-Type: multipart/form-data; boundary=----xxx

------xxx
Content-Disposition: form-data; name="file"; filename="product-manual.pdf"
Content-Type: application/pdf

<binary>
------xxx
Content-Disposition: form-data; name="metadata"

{"category":"manual","product":"AgentFlow Pro"}
------xxx--
```

支持的文件格式：PDF、Markdown、TXT、DOCX、HTML，单文件最大 50 MB。

响应（`202 Accepted`，因为 embedding 是异步的）：

```json
{
  "document_id": "doc_xxx",
  "status": "processing",
  "filename": "product-manual.pdf",
  "size_bytes": 2456789,
  "metadata": { "category": "manual", "product": "AgentFlow Pro" }
}
```

文档处理完成后 `status` 变为 `indexed`，失败则为 `failed`。

### `GET /api/v1/knowledge-bases/{kbId}/documents`

列出文档。

查询参数：

| 参数 | 说明 |
|------|------|
| `status` | `processing` / `indexed` / `failed` |
| `metadata.*` | 按元数据精确匹配，如 `metadata.category=manual` |
| `limit` / `cursor` | 通用分页 |

### `DELETE /api/v1/knowledge-bases/{kbId}/documents/{docId}`

删除文档及其所有 chunk 的向量。物理删除，无法恢复。

### `POST /api/v1/knowledge-bases/{kbId}/search`

直接调用知识库检索，主要用于调试或在 agent 之外的场景使用知识库。

请求体：

```json
{
  "query": "如何配置 SSO？",
  "top_k": 5,
  "filter": { "metadata.category": "manual" },
  "rerank": true
}
```

响应：

```json
{
  "results": [
    {
      "chunk_id": "chk_xxx",
      "document_id": "doc_xxx",
      "score": 0.87,
      "rerank_score": 0.92,
      "content": "AgentFlow 支持基于 SAML 2.0 的单点登录...",
      "metadata": { "page": 42, "section": "认证配置" }
    }
  ],
  "query_embedding_ms": 45,
  "search_ms": 12,
  "rerank_ms": 230
}
```

速率限制：

- 上传：30 req/min per tenant
- 搜索：120 req/min per tenant
- 列表/删除：300 req/min per tenant

---

## 四、租户配置 API

### `GET /api/v1/tenant/config`

获取当前租户的全部配置。

响应：

```json
{
  "tenant_id": "tnt_xxx",
  "name": "Acme Corp",
  "system_prompt": "你是 Acme 公司的客服助手...",
  "allowed_skill_ids": ["search-web", "skl_custom_xxx"],
  "default_kb_ids": ["kb_product", "kb_faq"],
  "llm_routing": {
    "primary": "claude-sonnet-4-5",
    "fallback": ["gpt-4o-mini"]
  },
  "session_ttl_minutes": 30,
  "data_residency": "cn-shanghai",
  "updated_at": "2025-05-10T14:00:00Z"
}
```

### `PUT /api/v1/tenant/config`

更新租户配置。PATCH 语义，只更新传入的字段。

可更新字段：

| 字段 | 说明 |
|------|------|
| `system_prompt` | 全局 system prompt，最大 8 KB |
| `allowed_skill_ids` | 启用的 skill 列表，空数组表示禁用所有 |
| `default_kb_ids` | 默认接入的知识库 |
| `llm_routing` | LLM 路由策略，第 4 章介绍过。`primary` 默认 `claude-sonnet-4-5`，`fallback` 默认 `[gpt-4o-mini]` |
| `session_ttl_minutes` | 会话不活跃过期时间，默认 30 分钟，可选范围 5-1440（即 5 分钟到 24 小时） |

`data_residency` 一经创建不可修改。

### `GET /api/v1/tenant/usage`

查询 token 用量和请求数统计。

查询参数：

| 参数 | 说明 |
|------|------|
| `from` / `to` | ISO 8601 时间范围，最大跨度 90 天 |
| `granularity` | `hour` / `day` / `month`，默认 `day` |

响应：

```json
{
  "from": "2025-05-01T00:00:00Z",
  "to": "2025-05-11T00:00:00Z",
  "granularity": "day",
  "data_points": [
    {
      "timestamp": "2025-05-01T00:00:00Z",
      "requests": 1245,
      "prompt_tokens": 856234,
      "completion_tokens": 234567,
      "total_tokens": 1090801,
      "cost_usd": 12.34
    }
  ],
  "totals": {
    "requests": 14520,
    "total_tokens": 12450000,
    "cost_usd": 142.5
  }
}
```

### `GET /api/v1/tenant/quota`

查询配额状态。

响应：

```json
{
  "plan": "professional",
  "quotas": {
    "monthly_tokens": {
      "limit": 50000000,
      "used": 12450000,
      "remaining": 37550000,
      "reset_at": "2025-06-01T00:00:00Z"
    },
    "requests_per_minute": {
      "limit": 60,
      "current": 12
    },
    "concurrent_sessions": {
      "limit": 100,
      "current": 24
    },
    "knowledge_base_size_mb": {
      "limit": 10240,
      "used": 1245
    }
  }
}
```

速率限制：租户配置 API 整体 60 req/min per tenant。

---

## 五、管理员 API

仅供平台运营使用，需要 root token。

### `POST /api/v1/admin/tenants`

创建租户。

请求体：

```json
{
  "name": "Acme Corp",
  "owner_email": "admin@acme.com",
  "plan": "professional",
  "data_residency": "cn-shanghai",
  "initial_config": {
    "system_prompt": "..."
  }
}
```

响应：返回新租户对象，含初始 API Key（仅本次返回）。

### `PUT /api/v1/admin/tenants/{tenantId}/quota`

调整配额。

```json
{
  "monthly_tokens": 100000000,
  "requests_per_minute": 120,
  "concurrent_sessions": 200
}
```

任何字段缺省表示保持原值。变更立即生效。

### `GET /api/v1/admin/audit-logs`

查询审计日志。第 9 章讲过审计的实现，所有写操作和敏感读操作都会落库。

查询参数：

| 参数 | 说明 |
|------|------|
| `tenant_id` | 限定租户 |
| `actor_id` | 限定操作者（API Key ID 或 admin user ID） |
| `action` | 操作类型，如 `skill.create`、`tenant.quota.update` |
| `from` / `to` | 时间范围 |
| `resource_id` | 关联资源 ID |

响应：

```json
{
  "items": [
    {
      "log_id": "log_xxx",
      "timestamp": "2025-05-11T08:00:00Z",
      "tenant_id": "tnt_xxx",
      "actor": {
        "type": "api_key",
        "id": "key_xxx",
        "ip": "203.0.113.42"
      },
      "action": "skill.create",
      "resource_id": "skl_xxx",
      "request_id": "req_xxx",
      "diff": {
        "before": null,
        "after": { "name": "查询订单状态", "implementation": "webhook" }
      },
      "result": "success"
    }
  ],
  "next_cursor": "..."
}
```

日志保留 13 个月，符合常见合规要求。如需更长保留期，可在控制台配置导出到租户的 S3 / OSS。

速率限制：管理员 API 整体 600 req/min（共享额度，不区分租户）。

---

## 附：SDK 与示例

官方维护 Node.js、Python、Go 三种 SDK，封装了认证、重试、SSE 解析等通用逻辑。开发新接入时推荐先翻 SDK 源码，里面对错误处理的细节比 HTTP 文档更全。

```ts
import { AgentFlow } from '@agentflow/sdk';

const client = new AgentFlow({ apiKey: process.env.AGENTFLOW_KEY });

const stream = await client.chat.send({
  message: '你好',
  userId: 'user_42',
});

for await (const event of stream) {
  if (event.type === 'token') process.stdout.write(event.delta);
}
```

更多端到端示例参见 `agentflow/examples/` 目录。

---

> 本附录来自《百万级 AI Agent 平台架构》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-enterprise-agent](https://github.com/diguike/book-enterprise-agent)
