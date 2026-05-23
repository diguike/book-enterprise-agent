# AgentFlow MVP

《百万级 AI Agent 平台架构：智能客服 SaaS 实战》随书完整可运行项目。

本目录提供一个真正能 `git clone && docker compose up && npm run dev` 跑起来的端到端示例，覆盖：

- Fastify HTTP API（JWT 认证、SSE 流式响应）
- LLM Gateway（Anthropic 调用、Prompt Caching、指数退避重试）
- Mastra Agent（电商客服）+ `queryOrder` 工具（Mock 数据）
- Redis 会话存储（滑动过期）
- Postgres 审计日志（每次 LLM 调用都落库）

完整版书中各章节会在此基础上逐步加入：知识库 RAG、isolated-vm 沙箱、多 Provider Fallback、Temporal 持久化执行、Circuit Breaker、可观测性等能力。

## 快速上手

### 1. 启动依赖容器

```bash
docker compose up -d
# 等待健康检查通过（约 10 秒）
docker compose ps
```

容器启动时 Postgres 会自动执行 `scripts/init.sql`，建表并插入演示租户 `tenant-ecommerce`。

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少填入 ANTHROPIC_API_KEY
```

### 3. 安装依赖并构建

```bash
npm install
npm run build
```

`npm run build` 会按 `packages/shared → llm-gateway → session → agent-engine → apps/api` 的顺序编译。

### 4. 启动 API

```bash
npm run dev --workspace=@agentflow/api
```

服务监听 `http://localhost:3000`。

### 5. 测试

先签一个开发用 JWT：

```bash
curl http://localhost:3000/api/v1/dev/token
# → { "token": "eyJhbGciOi...", "usage": "Authorization: Bearer ..." }
```

然后发起流式聊天（订单号 `12345` 和 `67890` 是 Mock 数据里存在的）：

```bash
TOKEN=$(curl -s http://localhost:3000/api/v1/dev/token | jq -r .token)

curl -N -X POST http://localhost:3000/api/v1/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "查询订单 #12345"}'
```

响应是 SSE 流，事件类型：

| `type`        | 说明                                       |
| ------------- | ------------------------------------------ |
| `session`     | 第一帧，回传新建/复用的 `sessionId`        |
| `tool_use`    | LLM 决定调用某个工具                       |
| `tool_result` | 本地工具执行完毕，结果（仅调试用，可隐藏） |
| `text`        | 最终回复的文本增量（伪流式 chunk）         |
| `usage`       | 本次会话累计 token 用量                    |
| `done`        | 流结束                                     |

续接同一会话：把上一次返回的 `sessionId` 带在请求里：

```bash
curl -N -X POST http://localhost:3000/api/v1/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"session_xxx", "message":"那 #67890 呢？"}'
```

### 6. 查看审计日志

```bash
docker exec -it agentflow-mvp-postgres psql -U agentflow -d agentflow \
  -c "SELECT model, input_tokens, output_tokens, cache_read_tokens, latency_ms, created_at FROM llm_audit_logs ORDER BY created_at DESC LIMIT 5;"
```

## 目录结构

```
agentflow/
├── docker-compose.yml      # MVP 用的精简版（Postgres + Redis）
├── package.json            # npm workspaces 根
├── tsconfig.base.json      # 全局 TS 配置（strict 模式）
├── turbo.json              # Turborepo 任务编排
├── .env.example
├── scripts/
│   ├── init.sql            # 建表 + 演示租户
│   └── db-init.mjs         # 在已运行的 DB 上重跑 init.sql
├── packages/
│   ├── shared/             # 共享类型（Tenant、Session、AgentConfig 等）
│   ├── llm-gateway/        # Anthropic 调用 + Prompt Caching + 重试
│   ├── session/            # Redis session store + Postgres 审计
│   └── agent-engine/       # Mastra Agent + queryOrder 工具
└── apps/
    └── api/                # Fastify + SSE 接口
        ├── Dockerfile
        └── src/
            ├── index.ts
            ├── config.ts
            ├── auth.ts
            └── routes/
                ├── chat.ts
                └── dev.ts
```

## 架构说明

MVP 故意没有把 Mastra Agent 的 streaming 包到一切之外，而是手写了一个轻量的 agent loop（在 `apps/api/src/routes/chat.ts` 里）。原因：

1. 把"工具调用 → 工具执行 → 把结果塞回去"这个核心机制显式写出来，便于读者跟踪。
2. 我们需要插入自己的 LLM Gateway（带 Prompt Caching、审计日志）；用 Mastra 的封装反而要绕过去。
3. 第 3 章会用 Mastra 自己的 `streamText` 演示更高级的写法；这里保持简单。

> **生产注意**：MVP 的 agent loop 把 tool_use 当作纯文本拼回历史，损失了 Anthropic 协议的结构化 tool_result block。生产环境应该用 Messages API 的 `content: [{type:'tool_use', ...}]` 结构，见第 3 章完整版。

## 范围 & 不在范围

**在 MVP 内：**

- 单租户（电商）端到端流程
- Anthropic Claude Sonnet 4.5（`claude-sonnet-4-5`）主调用
- Prompt Caching 两层断点
- 一个 Mock 工具（queryOrder）
- 完整的请求/响应审计

**不在 MVP 内（书后续章节补齐）：**

- 知识库 RAG（第 6 章）
- 自定义 Skill 沙箱（第 5 章）
- 多 Provider Fallback（第 4 章完整版）
- 多租户配额、限流（第 8、10 章）
- Temporal 持久化 workflow（第 7 章完整版）
- OpenTelemetry + Langfuse 可观测性（第 11 章）

## 故障排查

**`npm install` 卡住？**
检查代理 / npm registry：`npm config get registry`。

**`ANTHROPIC_API_KEY` 没配？**
启动会立即报错：`[config] 缺少必填环境变量：ANTHROPIC_API_KEY`。

**`Connection refused 5432 / 6379`？**
容器没起：`docker compose ps`；端口被占：`lsof -i :5432`。

**审计日志为空？**
SSE 响应结束后再查（写库是 fire-and-forget）。
