---
title: Hello Agent 运行说明
---

## 环境要求

- Node.js 20.11 LTS（避开 22+/24+，第 5 章 `isolated-vm` 在新版本上 native binding 经常编译失败）
- npm 10+
- Docker + Docker Compose
- Anthropic API Key

## 运行步骤

**1. 启动基础设施**

```bash
# 在 examples/ 目录下执行
cd 02-local-dev/examples
docker compose up -d

# 等待所有服务就绪（约 30 秒）
docker compose ps
```

所有服务 Status 显示 `healthy` 或 `running` 后继续。

**2. 安装依赖**

```bash
cd hello-agent
npm install
```

**3. 设置环境变量**

```bash
export ANTHROPIC_API_KEY=sk-ant-api03-...
# 可选，默认连接本地 Docker 容器
export DATABASE_URL=postgresql://agentflow:agentflow_dev_password@localhost:5432/agentflow
export REDIS_URL=redis://localhost:6379
```

**4. 运行 Demo**

```bash
# 使用 tsx 直接运行 TypeScript（开发模式）
npm run dev
```

预期输出：

```
AgentFlow 本地环境验证 Demo
==================================================

[Step 1] 验证 PostgreSQL 连接...
  PostgreSQL 版本：PostgreSQL 14.x
  pgvector 扩展：已安装
  已加载租户：tenant-ecommerce, tenant-finance, tenant-saas

[Step 2] 验证 Redis 连接...
  Redis PING：PONG
  写入 key：tenant-ecommerce:session:demo-session-001
  读取成功：userId = user-demo-001
  Circuit breaker 状态写入 Redis：tenant-ecommerce:circuit-breaker:anthropic-api

[Step 3] 初始化 Anthropic 客户端...
  用户消息：用一句话介绍你自己，不超过30个字。

[Step 4] 调用 Anthropic API 并写回 PostgreSQL...
  助手响应：我是 AgentFlow 智能客服助手，专注为您提供高效、准确的服务支持。
  Token 用量：输入 xx，输出 xx
  对话记录已写入 llm_audit_logs 表

==================================================
所有验证通过，本地开发环境配置正确。
```

## 常见问题

**PostgreSQL 连接失败**：确认容器启动完成后 init.sql 已执行。可以手动检查：
```bash
docker exec agentflow-postgres psql -U agentflow -d agentflow -c '\dt'
```

**Redis 连接失败**：
```bash
docker exec agentflow-redis redis-cli ping
```

**Temporal UI 打不开**：Temporal Server 依赖 PostgreSQL 初始化完成，首次启动较慢，等待 30-60 秒后刷新。
