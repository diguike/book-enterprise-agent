# 百万级 AI Agent 平台架构

> 在线阅读 · [inferloop.dev/enterprise-agent](https://inferloop.dev/enterprise-agent)  
> 所有书目 · [inferloop.dev](https://inferloop.dev)

智能客服 SaaS 实战 — 从零搭一个能跑起来的多租户 Agent 平台（AgentFlow）。

## 这本书在讲什么

把"一个真正能跑、能扛百万级流量、能给企业用的 Agent 平台"该有的所有东西讲清楚，并配套一份完整可运行的 MVP（`agentflow/` 目录）：

- 多租户隔离与配额
- Agent 引擎与会话状态
- 内置 LLM Gateway（多 Provider Fallback）
- Skill 系统（隔离沙箱）
- 知识库 RAG
- 高并发 / Circuit Breaker / 限流
- 可观测性 / 审计 / 计费
- 生产部署与故障排查

读完不仅理解架构，还能 `git clone && docker compose up && npm run dev` 跑起来。

## 目录

- [前言](00-preface/README.md)
- [第 1 章 架构设计与技术选型](01-architecture/README.md)
- [第 2 章 本地开发环境](02-local-dev/README.md)
- [第 3 章 核心 Agent 引擎](03-agent-engine/README.md)
- [第 4 章 LLM Gateway](04-llm-gateway/README.md)
- [第 5 章 Skill 系统](05-skill-system/README.md)
- [第 6 章 知识库系统（RAG）](06-knowledge-base/README.md)
- [第 7 章 会话与状态管理](07-session-state/README.md)
- [第 8 章 多租户设计](08-multi-tenant/README.md)
- [第 9 章 安全设计](09-security/README.md)
- [第 10 章 高并发与稳定性](10-high-concurrency/README.md)
- [第 11 章 可观测性与评估](11-observability/README.md)
- [第 12 章 部署与运维](12-deployment/README.md)
- 附录 A-F（[appendix/](appendix/)）

## 跑配套项目

```bash
git clone https://github.com/diguike/book-enterprise-agent.git
cd book-enterprise-agent/agentflow
docker compose up -d   # 起 Postgres + Redis
npm install
npm run db:init
npm run dev
```

详细步骤见 [`agentflow/README.md`](agentflow/README.md)。

## License

CC BY-NC-SA 4.0

## 相关书

来自同一作者的其他书:

- [《Hermes Agent 源码解读》](https://inferloop.dev/hermes-agent)
- [《LLM Infra 工程实战》](https://inferloop.dev/llm-infra)
- [《AI Token 中转站实战》](https://inferloop.dev/llm-gateway)
- [《Agent Memory 工程实战》](https://inferloop.dev/claude-mem)
- [《OpenClaw 源码解析》](https://inferloop.dev/openclaw)
- [《Transformer 教学》](https://inferloop.dev/transformer)
- [《Claude Code Skill 开发指南》](https://inferloop.dev/claude-skill)
- [《Claude 插件官方指南》](https://inferloop.dev/claude-plugins)
- [《自己动手写 AI Agent》](https://inferloop.dev/ling-agent)
