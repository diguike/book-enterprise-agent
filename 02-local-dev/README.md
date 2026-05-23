---
title: "第 2 章：本地开发环境"
feishu_url: "https://www.feishu.cn/wiki/BUX4woLBeiQR5Ckh1gCc3YMJnpe"
last_synced: "2026-05-11T17:28:46.777Z"
---

## 从零跑起来

AgentFlow 的第一次启动很难做到顺畅。它依赖四个外部服务：PostgreSQL（pgvector）、Redis、Temporal Server、Langfuse——缺少任何一个，代码要么无法启动，要么运行到一半崩掉。大多数教程绕开这个问题，直接假设"环境已就绪"，然后跳进核心代码。这本书不打算这样做。

本章的目标是：用 Docker Compose 把这四个服务一次性拉起来，再配好 Monorepo 的骨架和 TypeScript 配置，最后跑一个真实的 Hello Agent 验证整个链路通。做完这些，后续每章只需要往这个基础上叠加功能。

在此之前，先把环境要求和四条编码规则都讲清楚——如果现在不讲，后面会反复踩坑。

---

## 2.0 环境要求

全书的代码在以下版本组合下测试通过，强烈建议本地按这个清单准备环境：

| 组件 | 版本 | 必须的原因 |
|------|------|----------|
| **Node.js** | **20.11 LTS**（避开 22+ / 24+） | 第 5 章用 `isolated-vm` 做 V8 Isolate 沙箱，它依赖 native addon。Node 22+ 起 V8 ABI 变化，`isolated-vm` 在新版本上的 native binding 经常编译失败或加载时段错误，issue tracker 里堆了一长串。锁 Node 20 LTS 是当前最稳的选择 |
| **Python** | **3.9+** | `isolated-vm` 的 native build 阶段会调 `node-gyp`，`node-gyp` 需要本机有 Python（不用是项目代码语言，纯构建依赖） |
| **C/C++ 工具链** | Debian/Ubuntu：`build-essential`；macOS：Xcode Command Line Tools (`xcode-select --install`) | `isolated-vm` 没有 prebuilt binary，每台机器首次 `npm install` 都要从源码编译 |
| **Docker Engine** | **24+** | 第 2.2 节的 docker-compose.yml 使用了 healthcheck 的 `start_interval` 字段，Docker 24 才支持 |
| **Redis** | **6.2+**（建议 7.x） | BullMQ v5 在 Redis < 6.2 会打 deprecation 警告并降级；本书的 docker-compose.yml 用的是 `redis:7-alpine` |
| **PostgreSQL** | **14+**，预装 pgvector | 镜像用 `pgvector/pgvector:pg14` |

所有 examples 在 Node.js v20.11.0 下测试通过。

**Sonnet 模型版本**：全书 Sonnet 模型 ID 统一使用 `claude-sonnet-4-5`（2025 年的当前版本）；如果你的账号开通的是早期版本（如 `claude-3-5-sonnet-20241022`），把书中代码里的模型 ID 替换为对应的版本即可，调用接口完全兼容。

**Embedding 模型**：全书默认 `voyage-3`（1024 维），数据库列统一 `vector(1024)`。如果想用 OpenAI `text-embedding-3-small` 替代，需要把所有向量列改成 `vector(1536)` 并重建索引。

> **生产注意**：CI 和生产镜像的 Node.js 也应锁在 20.11 LTS。`package.json` 的 `engines` 字段建议显式写 `"node": ">=20.11.0 <21"`，配合 `npm install --engine-strict` 可以在构建阶段拦住误升级。

---

## 2.1 单机模拟规则

生产环境的 AgentFlow 运行在多个节点上：Redis Cluster 分片存储、多个 Temporal Worker Pod 并行执行、多个 API Server 实例处理请求。本地开发环境是单机，但不能因此写出只能在单机运行的代码。

以下四条规则描述的是：在单机环境里写出生产级代码习惯。

### 规则一：Key 命名遵循分片设计

单机用单节点 Redis，但所有 key 必须按 `{tenant_id}:{resource_type}:{id}` 格式命名。

```typescript
// 正确：包含 tenant_id 前缀
const sessionKey = `${tenantSlug}:session:${sessionId}`;
const circuitKey = `${tenantSlug}:circuit-breaker:anthropic-api`;
const rateLimitKey = `${tenantSlug}:rate-limit:${userId}`;

// 错误：没有 tenant_id 前缀
const sessionKey = `session:${sessionId}`;        // 迁移 Cluster 时要改代码
const circuitKey = `circuit-breaker:anthropic`;   // 多租户数据混在一起
```

为什么这条规则必须在开发阶段就遵守？Redis Cluster 按 key 的 hash slot 进行分片，默认对整个 key 求 CRC16。如果所有 key 都以 tenant_id 开头，同一租户的 key 大概率落在相邻的 slot 上，可以用 hash tag `{tenant_id}` 将其固定在同一个 slot，批量操作（MGET、MULTI/EXEC）才能正常工作。

> **生产注意**：Redis Cluster 中想让多个 key 落在同一个 slot，需要用 hash tag 语法：`{tenant-ecommerce}:session:abc`。大括号内的部分才参与 hash 计算。单机 Redis 没有这个限制，但 key 命名必须现在就预留这个位置，否则上线前的改造工作量巨大。

### 规则二：多进程模拟多 Worker

生产中 Temporal Worker、BullMQ Worker 是多个独立 Pod，各自处理不同的任务。单机开发时，用多个 Node.js 进程模拟：

```bash
# 启动 3 个 Temporal Worker 进程，模拟生产的多 Pod 部署
node dist/worker/temporal.js --worker-id=1 &
node dist/worker/temporal.js --worker-id=2 &
node dist/worker/temporal.js --worker-id=3 &

# 或用 npm 脚本并行启动
npm run worker:start -- --concurrency=3
```

不能用单线程假装并发——如果 Worker 代码有竞争条件（race condition），单线程下永远不会触发，到了多 Pod 环境才暴露，调试成本极高。

### 规则三：分布式状态必须用 Redis

Circuit breaker 的失败计数、rate limiter 的窗口计数、会话锁——这些状态哪怕在单机 Demo 里也必须存 Redis，不能存内存变量。

```typescript
// 错误：内存变量，两个 Pod 各自维护自己的计数
let failureCount = 0;  // Pod A 看到 3 次失败，Pod B 看到 2 次
                        // 熔断阈值 5 永远触发不了

// 正确：Redis 原子计数器，所有 Pod 共享状态
const key = `${tenantSlug}:circuit-breaker:anthropic-api:failures`;
const count = await redis.incr(key);
await redis.expire(key, WINDOW_SECONDS);
if (count >= FAILURE_THRESHOLD) {
  await redis.set(`${tenantSlug}:circuit-breaker:anthropic-api:state`, 'open');
}
```

这条规则的底线是：在单机开发阶段就养成用 Redis 存分布式状态的习惯，到生产直接水平扩展，不需要改代码。

### 规则四：显式标注单机 vs 生产差距

全书代码中，凡是单机行为与生产有差距的地方，用以下格式标注：

> **生产注意**：[具体说明差距是什么，生产需要如何调整]

这不是装饰，而是让读者清楚知道哪些代码可以直接用于生产、哪些需要额外改造。

---

## 2.2 Docker Compose 环境搭建

完整的 `docker-compose.yml` 在 `examples/docker-compose.yml`。这里逐服务说明关键配置决策。

### PostgreSQL 14 + pgvector

```yaml
postgres:
  image: pgvector/pgvector:pg14
  environment:
    POSTGRES_USER: agentflow
    POSTGRES_PASSWORD: agentflow_dev_password
    POSTGRES_DB: agentflow
  volumes:
    - postgres_data:/var/lib/postgresql/data
    - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
```

使用 `pgvector/pgvector:pg14` 而不是官方 `postgres:14`，是因为前者已预装 pgvector 扩展。如果用官方镜像，需要在容器内手动编译安装，Dockerfile 会增加十几行。

`init.sql` 挂载到 `docker-entrypoint-initdb.d/` 是 PostgreSQL 官方支持的初始化机制：容器首次启动、数据目录为空时，该目录下的 `.sql` 文件会按字母顺序自动执行。`init.sql` 做三件事：

1. `CREATE EXTENSION IF NOT EXISTS vector` — 安装 pgvector
2. `CREATE DATABASE langfuse` — 创建 Langfuse 专用库（Langfuse 需要独立数据库）
3. 建 agentflow 的基础表：`tenants`、`sessions`、`llm_audit_logs`、`knowledge_chunks`

`knowledge_chunks` 表此时就创建，包含 `vector(1024)` 类型的 `embedding` 列（对应第 6 章默认的 voyage-3 embedding 模型）。这是为了让 pgvector 的 HNSW 索引从一开始就建好，避免后续数据量大时添加索引的维护窗口。全书统一使用 1024 维；切换到 OpenAI `text-embedding-3-small` 时需要把这列改成 `vector(1536)` 并重建索引。

> **生产注意**：生产环境的 PostgreSQL 应当分库：agentflow 业务数据和 Langfuse 观测数据放在不同的 RDS 实例，分开扩容和备份。单机环境合并在一个容器只是为了节省资源。

> **生产注意（pg14 vs pg16）**：本地用 `pgvector/pgvector:pg14` 不是因为只支持 14——是因为 14 仍在 AWS RDS Free Tier 兼容范围（便于读者跑云端验证），且 `pgvector/pgvector` 的 pg14 tag 是更新最频繁、文档最稳定的开发镜像。生产建议直接上 PG 16：HNSW 索引构建速度比 pg14 快约 30%（pgvector 0.7+ 在 PG 16 上启用了并行构建），高并发写入下 WAL 路径上的锁竞争也更轻。本书 SQL 不依赖 14/16 之间的差异，从本地 pg14 迁到生产 pg16 不需要改 schema，只需 `pg_dump` + `pg_restore` 走一遍。

### Redis 7

```yaml
redis:
  image: redis:7-alpine
  command: >
    redis-server
    --appendonly yes
    --appendfsync everysec
    --maxmemory 512mb
    --maxmemory-policy allkeys-lru
```

四个关键参数的原因：

- `--appendonly yes`：开启 AOF 持久化，容器重启后不丢队列数据
- `--appendfsync everysec`：每秒 fsync 一次，比 `always` 性能好，比 `no` 安全（最多丢 1 秒数据）
- `--maxmemory 512mb`：防止开发机内存被吃光
- `--maxmemory-policy allkeys-lru`：内存满时淘汰最久未访问的 key，适合缓存场景

> **生产注意**：单机用单节点 Redis，生产需要 Redis Cluster（最小 3 主 3 从）。Cluster 模式下，`MULTI/EXEC` 事务要求所有 key 在同一个 slot，这是规则一（key 命名带 hash tag）的直接动因。另外，AOF 在生产中通常与 RDB 快照并用，单机环境只开 AOF 足够。

### Temporal Server

```yaml
temporal:
  image: temporalio/auto-setup:1.24
  environment:
    - DB=postgres12
    - POSTGRES_USER=agentflow
    - POSTGRES_PWD=agentflow_dev_password
    - POSTGRES_SEEDS=postgres
  ports:
    - '7233:7233'   # gRPC，Temporal SDK 连接此端口
```

`temporalio/auto-setup` 是官方提供的开发模式镜像，内置了 `temporal-server` 和 schema 自动初始化逻辑，首次启动会在 PostgreSQL 里创建 Temporal 所需的表结构，不需要手动运行 `temporal-sql-tool`。

7233 端口是 Temporal gRPC 接口，Node.js SDK（`@temporalio/worker`、`@temporalio/client`）连接这个端口提交和查询 Workflow。

8080 端口是 Temporal Web UI（由单独的 `temporal-ui` 容器提供），用于可视化查看 Workflow 执行历史、重放事件、手动触发 Workflow。调试 Agent 会话状态机时，这个界面是最直接的排查工具。

> **生产注意**：`auto-setup` 镜像把所有 Temporal 服务（Frontend、History、Matching、Worker）压缩在一个进程里，适合开发和 CI，不适合生产。生产部署应拆分为独立的 Deployment，各组件分别扩容。Temporal Cloud 是另一个选项，省去运维负担但有数据驻留限制（某些金融合规场景不能用）。

### Langfuse

Langfuse 由两个容器组成（以下为核心字段节选，完整配置见 `examples/docker-compose.yml`）：

```yaml
langfuse-web:
  image: langfuse/langfuse:2
  ports:
    - '3000:3000'
  environment:
    - DATABASE_URL=postgresql://agentflow:agentflow_dev_password@postgres:5432/langfuse
    - NEXTAUTH_SECRET=langfuse_nextauth_secret_dev_only_change_in_prod
    - SALT=langfuse_salt_dev_only_change_in_prod

langfuse-worker:
  image: langfuse/langfuse-worker:2
  environment:
    - DATABASE_URL=postgresql://agentflow:agentflow_dev_password@postgres:5432/langfuse
    - SALT=langfuse_salt_dev_only_change_in_prod
```

`langfuse-web` 提供 HTTP API 和前端界面（3000 端口）。`langfuse-worker` 是后台任务处理进程，负责异步处理 trace 数据、计算 token 成本、触发评估任务。两者共用同一个 PostgreSQL 数据库（`langfuse` 库）。

注意 `NEXTAUTH_SECRET` 和 `SALT` 这两个值在开发环境可以随意设置，但**生产环境必须使用随机生成的强密钥**，且两个容器的 `SALT` 必须保持一致，否则 Langfuse Worker 无法解密 Web 层写入的数据。

### 启动与验证

```bash
# 启动所有服务（后台模式）
cd examples
docker compose up -d

# 查看服务状态，等所有服务变成 healthy/running
docker compose ps

# 验证 PostgreSQL：能看到 tenants 表和三条测试数据
docker exec agentflow-postgres \
  psql -U agentflow -d agentflow \
  -c 'SELECT slug, name FROM tenants;'

# 验证 Redis：返回 PONG
docker exec agentflow-redis redis-cli ping

# 验证 Temporal：返回 "temporal-system" namespace 信息
docker exec agentflow-temporal \
  temporal operator namespace describe --namespace temporal-system --address localhost:7233

# 验证 Langfuse：返回 {"status":"OK"}
curl -s http://localhost:3000/api/public/health
```

所有验证通过后，可以访问图形界面：

| 服务 | 地址 |
|------|------|
| Langfuse Web UI | http://localhost:3000（首次访问需注册账号） |
| Temporal Web UI | http://localhost:8080 |
| MailHog | http://localhost:8025 |

---

## 2.3 Monorepo 结构详解

AgentFlow 使用 npm workspaces 管理 Monorepo。按职责拆分 packages，让每个包有清晰的边界——这比把所有代码堆在一个 src 目录里更容易管理依赖关系和测试范围。

### 目录结构

```
agentflow/
├── package.json              # 根 package.json，定义 workspaces
├── turbo.json                # Turborepo 构建缓存配置
├── tsconfig.base.json        # 全局 TypeScript 基础配置
│
├── packages/                 # 可复用的功能包
│   ├── shared/               # 共享类型定义、工具函数（第1章建立）
│   │   └── src/
│   │       ├── types.ts      # 核心领域类型：Tenant、Session、Message
│   │       └── errors.ts     # 统一错误类型
│   │
│   ├── agent-engine/         # Mastra + LangGraph agent 核心（第3章）
│   │   └── src/
│   │       ├── mastra.ts     # Mastra 实例初始化
│   │       ├── agents/       # 各场景 agent 定义
│   │       └── tools/        # agent 可调用的 tool 定义
│   │
│   ├── llm-gateway/          # LLM 路由、缓存、降级（第4章）
│   │   └── src/
│   │       ├── router.ts     # 多 provider 路由逻辑
│   │       ├── cache.ts      # 语义缓存（Redis + pgvector）
│   │       └── circuit.ts    # 熔断器（状态存 Redis）
│   │
│   ├── skill-system/         # Skill 注册表和 V8 沙箱（第5章）
│   │   └── src/
│   │       ├── registry.ts   # Skill 注册和发现
│   │       └── sandbox.ts    # isolated-vm 沙箱执行
│   │
│   ├── knowledge-base/       # RAG 流水线（第6章）
│   │   └── src/
│   │       ├── ingest.ts     # 文档解析和 chunk 切分
│   │       ├── embed.ts      # 向量嵌入（调用 embedding API）
│   │       └── retrieve.ts   # pgvector 相似度检索
│   │
│   ├── session/              # 会话状态机 + Temporal workflow（第7章）
│   │   └── src/
│   │       ├── workflow.ts   # Temporal workflow 定义
│   │       ├── activities.ts # Temporal activities
│   │       └── state.ts      # 会话状态类型和转换
│   │
│   └── observability/        # OpenTelemetry + Langfuse 集成（第11章）
│       └── src/
│           ├── tracer.ts     # OTel tracer 初始化
│           └── langfuse.ts   # Langfuse SDK 封装
│
└── apps/                     # 可执行的应用进程
    ├── api/                  # Fastify HTTP 服务（贯穿全书）
    │   └── src/
    │       ├── app.ts        # Fastify 实例和插件注册
    │       ├── routes/       # 路由定义
    │       └── plugins/      # 自定义插件（认证、限流等）
    │
    ├── worker/               # Temporal + BullMQ Worker 进程（第7章引入）
    │   └── src/
    │       ├── temporal.ts   # Temporal Worker 入口
    │       └── bullmq.ts     # BullMQ Worker 入口
    │
    └── sandbox/              # isolated-vm 沙箱进程（第5章引入）
        └── src/
            └── index.ts      # 沙箱进程，独立运行避免 VM 崩溃污染主进程
```

apps 和 packages 的划分原则：packages 是被引用的库，apps 是运行的进程。`api` 和 `worker` 是两个独立的进程，生产中分别部署，互相不直接 import 对方的代码——共享逻辑通过 packages 引用。

### npm workspaces 配置

根目录的 `package.json`：

```json
{
  "name": "agentflow",
  "private": true,
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.7.0"
  }
}
```

### Turborepo 配置

`turbo.json` 定义构建任务的依赖关系和缓存策略：

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**/*.ts", "tsconfig.json"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "inputs": ["src/**/*.ts", "tsconfig.json"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"],
      "inputs": ["src/**/*.ts", "tests/**/*.ts"]
    }
  }
}
```

`"dependsOn": ["^build"]` 的语义是：执行 `build` 前，先构建所有依赖包（`^` 表示依赖的上游包）。这样 `apps/api` 的 `build` 会自动先触发 `packages/shared`、`packages/agent-engine` 等的 `build`，不需要手动排序。

---

## 2.4 TypeScript 基础配置

`tsconfig.base.json` 放在 `examples/` 目录下，供所有子包继承。完整配置在 `examples/tsconfig.base.json`，这里解释几个关键决策。

### `strict: true`

在 Agent 代码里，`strict` 的价值比普通业务代码高很多。原因在于 LLM 的输出是动态的 JSON，如果不严格类型检查，解析代码很容易写成这样：

```typescript
// 没有 strict 时很容易写出
const intent = response.content[0].text;  // content[0] 可能是 undefined
const action = JSON.parse(intent).action; // intent 可能是 undefined

// strict 强制你处理每个可能的 undefined
const block = response.content[0];
if (!block || block.type !== 'text') {
  throw new AgentParseError('LLM 返回了意外的内容类型');
}
const action = JSON.parse(block.text).action as string;
```

严格模式把大量的运行时 crash 提前到编译期。

### `exactOptionalPropertyTypes: true`

这个配置区分"属性值为 `undefined`"和"属性不存在"：

```typescript
interface SessionState {
  endedAt?: Date;  // 开启 exactOptionalPropertyTypes 后
                   // { endedAt: undefined } 和 {} 是不同的类型
}

// 以下赋值在 exactOptionalPropertyTypes 下会报错
const state: SessionState = { endedAt: undefined };
//                           ~~~~~~~ Type 'undefined' is not assignable to type 'Date'
// 正确写法：省略该字段，而不是显式写 undefined
const state2: SessionState = {};
```

在会话状态机里，"字段不存在"和"字段明确为空"有语义差异：`endedAt` 不存在表示会话从未结束过，`endedAt: undefined` 是一个 bug（应该要么有值要么不设置这个字段）。

### `target: "ES2022"`

Node.js 18+ 原生支持 ES2022 的所有特性（`Array.at()`、class static blocks、`Object.hasOwn()` 等），不需要降级编译。保持 `target: "ES2022"` 让 TypeScript 输出的代码更接近源码，调试 source map 对应更准确。

---

## 2.5 环境验证：跑通第一个 Hello Agent

理论说完了，用一段真实代码把整个链路跑通。`examples/hello-agent/` 是一个独立的 Node.js 项目，做四件事：

1. 连接 PostgreSQL，查询 `tenants` 表
2. 连接 Redis，用正确的 key 命名格式写入一条数据
3. 调用 Anthropic API，发一条消息并取得响应
4. 把对话记录写入 `llm_audit_logs` 表

### 核心代码结构

```typescript
// 遵循规则一：key 包含 tenant_id 前缀
const sessionKey = `${tenantSlug}:session:${sessionId}`;
await redis.set(sessionKey, JSON.stringify(sessionData), 'EX', 3600);

// 遵循规则三：circuit breaker 状态存 Redis，不存内存
const circuitKey = `${tenantSlug}:circuit-breaker:anthropic-api`;
await redis.set(circuitKey, '0', 'EX', 60);

// 直接调用 Anthropic SDK
const response = await anthropic.messages.create({
  model: 'claude-3-5-haiku-20241022',
  max_tokens: 256,
  messages: [{ role: 'user', content: userMessage }],
});
```

完整代码在 `examples/hello-agent/src/index.ts`，包含中文注释和完整类型定义。

### 运行方法

```bash
# 确保 Docker Compose 服务已启动
cd examples
docker compose up -d

# 安装依赖并运行
cd hello-agent
npm install
export ANTHROPIC_API_KEY=sk-ant-api03-...
npm run dev
```

所有四个 Step 都通过后，环境配置正确。如果某一步失败，错误信息会给出具体的排查方向。

### 依赖版本说明

`package.json` 使用锁定的主版本范围（`^0.39.0` 而不是 `*` 或 `latest`）：

| 包 | 版本 | 说明 |
|----|------|------|
| `@anthropic-ai/sdk` | `^0.39.0` | Anthropic 官方 SDK |
| `ioredis` | `^5.4.0` | Redis 客户端，Cluster 模式与单节点 API 一致 |
| `pg` | `^8.13.0` | PostgreSQL 原生驱动，直接执行 SQL |

`hello-agent` 只做环境验证，有意不引入 Mastra 和 Drizzle ORM——它们从第3章起正式引入，此处用最少依赖保持链路清晰。

---

## 对三个租户意味着什么

这章搭起来的本地环境，是给三个租户共用的一套基础设施，差异只在配置层。

**租户 A（电商）**：Postgres + Redis + Temporal 这一套就是双十一峰值场景的本地等比例缩影——单机一个 Redis 节点对应生产的 Cluster，单进程多 Worker 对应生产的多 Pod，所有 key 命名已经预留分片字段，第 10 章压测时不用改业务代码。

**租户 B（SaaS 软件）**：同一套 Postgres 即兼做业务库和 pgvector 向量库（第 6 章用），知识库的本地开发不需要额外搭 Milvus/Qdrant，写完入库脚本就能跑。

**租户 C（金融机构）**：合规相关配置通过 docker-compose 的环境变量开关切换（如 `AUDIT_ENABLED`、`PII_MASK_MODE`），开发态默认关闭，给租户 C 部署时一键打开。这意味着同一份镜像可以服务三类租户，不需要为合规场景维护单独分支。

## 本章小结

本章建立了全书的本地开发基础：Docker Compose 一键启动四个服务，Monorepo 目录结构映射后续章节，TypeScript 严格模式从一开始就配好。更重要的是四条单机模拟规则——key 命名格式、多进程模拟 Worker、分布式状态存 Redis、显式标注生产差距——这四条规则在后续每章的代码里都会体现。

Hello Agent 验证了从 API 调用到数据库持久化的完整链路。第3章在这个基础上，把这个简单的 `anthropic.messages.create` 调用替换成真正的 Mastra Agent，引入工具调用和多轮对话状态管理。

## 参考资料

- [pgvector 官方文档](https://github.com/pgvector/pgvector)：HNSW 索引参数调优
- [Temporal auto-setup 镜像文档](https://hub.docker.com/r/temporalio/auto-setup)：支持的环境变量列表
- [Langfuse 自托管指南](https://langfuse.com/docs/deployment/self-host)：生产部署注意事项
- [ioredis Cluster 模式文档](https://github.com/redis/ioredis#cluster)：hash tag 语法和 slot 路由
- [Turborepo 任务缓存](https://turbo.build/repo/docs/crafting-your-repository/caching)：`inputs` 和 `outputs` 配置

---

> 本章来自《百万级 AI Agent 平台架构》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev)  
> 源码仓库：[github.com/diguike/book-enterprise-agent](https://github.com/diguike/book-enterprise-agent)
