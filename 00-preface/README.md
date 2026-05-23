---
title: "前言"
feishu_url: "https://www.feishu.cn/wiki/HRjYwbh3Ti4tXrkdv9CcCPNcnEb"
last_synced: "2026-05-11T17:28:37.985Z"
---

> **配套资源**  
> 源码仓库 · [github.com/diguike/book-enterprise-agent](https://github.com/diguike/book-enterprise-agent)  
> 在线阅读 · [inferloop.dev/enterprise-agent](https://inferloop.dev/enterprise-agent)

## 这个时间窗口

2023 年初，GPT-4 API 开放的第一周，国内某头部电商平台的一支工程团队用 3 天搭出了一个智能客服原型——接入 LangChain，写了几十条规则，演示跑通了。产品经理当场说"可以上线"。

三个月后，这套系统在双十一压测中彻底崩溃：进程内 Map 存着几万个 session，一次 Pod 重启全清；用户请求超过 200 QPS 时，LLM 调用开始大规模超时，整个服务响应时间飙到十几秒；更糟糕的是，有几个 agent 陷入了循环调用 tool 的死锁，整个服务进程挂死。最后，那个原型被废掉了，换了一套规则引擎重新写。

这是一个典型的教训：agent 原型和生产系统之间存在一道工程鸿沟，而几乎所有现有资料都停在原型这边。

过去两年，我密集地做了一件事：拆解那些跑在生产上的 AI agent 系统，搞清楚它们是怎么解决内存管理、并发、故障恢复、成本控制这些具体工程问题的。本书是这个过程的结果。

## 这本书解决什么问题

市场上不缺 AI 资料，缺的是工程师视角的、能落地的内容。

现有资料大致分三类：第一类是学术论文，关注模型能力和 benchmark，工程师读完不知道代码往哪写；第二类是 README 和博客，教你把 OpenAI API 接进项目里，五分钟就能跑起来，但不告诉你跑起来之后怎么办；第三类是 Python 生态的框架文档，LangChain、LlamaIndex、AutoGen，丰富但对 TypeScript 工程师几乎没有直接参考价值——不是说 Python 不好，而是 Node.js 生态、TypeScript 类型系统、npm 包管理这些东西在 Python 资料里不存在。

本书填的是第四类的空缺：用 TypeScript 构建生产级 AI agent 系统的完整工程指南。

**本书不是什么：**

- 不是 LLM 调参手册。不讲 temperature、top_p、RLHF，不讲怎么让模型更聪明。
- 不是 Python AI 框架的翻译版。代码全部是 TypeScript，架构决策基于 Node.js 生态的实际约束。
- 不是速成教程。不会在第一章就让你"5 分钟跑起来一个 AI 助手"，然后后面的章节全是追加功能。本书从第一章就面对真实的生产问题。
- 不是概念科普。书里每个技术选择都有具体的依据——源码、测量数据或真实故障案例。如果某个说法无法验证，就不写。

## 读者画像

本书假设你：

- 有 2 年以上 TypeScript/Node.js 工程经验，理解 Promise、async/await、事件循环，见过 Express 或 Fastify 的生产代码。
- 有基本的系统设计经验，知道 Redis 干什么用、理解数据库索引、读过类似"高并发系统如何处理 10K QPS"的讨论。
- 会用 LLM API，但还没真正构建过生产级 agent 系统——用过 `openai.chat.completions.create()` 和 tool calling，但对状态管理、多租户隔离、成本控制没有系统性认知。
- 正在转型，或刚接到任务要构建 AI agent 系统，需要尽快搞清楚生产上该怎么做。

如果你是 Python 工程师且有意了解 TypeScript 生态的 agent 工程实践，本书也值得读——核心工程问题和架构思路是通用的，差异在于语言和工具链。

**这本书不适合谁：**

- 完全没写过后端代码的前端工程师或学生。书里默认你处理过数据库连接、读懂过 stack trace、调试过生产事故；如果"什么是连接池"还需要现学，建议先补一轮 Node.js 后端基础再来。
- 想要"5 分钟搭出一个 ChatBot"的产品同学。本书第 1 章就讨论 1M session 的换算，不是用来快速 demo 的。
- AI 研究方向的同学。本书不讲模型训练、不分析 attention，也不涉及推理 kernel 优化；想做这些内容，市面上有专门的书。
- 把这本书当作"LangChain.js 教程"来读的人。书里只在第 5 章 skill 系统提了一次 LangChain，主框架用的是 Mastra，原因第 1 章会写清楚。

## AgentFlow：贯穿全书的项目

本书的代码主线是一个多租户企业智能客服 SaaS 平台 **AgentFlow**。选这个场景，是因为客服远比表面看起来复杂——一个生产级客服 agent 需要理解用户意图（而不是关键词匹配）、调用内部系统 API（查订单、触发退款、创建工单）、维护跨轮次的会话状态、在用户等待时保持响应速度、在高峰期处理几万个并发 session。企业 agent 的核心工程难题，几乎都在这个场景里能找到对应物。

AgentFlow 服务三类典型租户，分别代表三种工程压力的极端：

- **租户 A（电商平台）**：查订单、退款、物流。双十一峰值 session 是平时的 10 倍，agent 要在毫秒级完成工具调用——典型的高吞吐、低延迟、弱合规场景。
- **租户 B（SaaS 软件公司）**：账单、工单、产品文档问答。几万条文档持续更新，RAG 召回质量直接影响客服解决率——典型的知识密集型 agent 场景。
- **租户 C（金融机构）**：合规严格，每次 LLM 调用必须落审计日志，部分操作需要人工审批节点，数据不能跨租户泄露——典型的低容忍、高审计、强隔离场景。

三个租户合起来覆盖了生产 agent 系统的主要技术维度：高并发、RAG、状态管理、成本控制、合规审计、多租户隔离。本书的每个核心章节都会从这三个租户的不同需求出发讨论技术决策。

## 技术栈

AgentFlow 是完整的 TypeScript 技术栈，主要组件包括 Mastra + LangGraph.js（agent 编排）、Vercel AI SDK（流式传输）、Temporal（持久执行）、BullMQ（任务队列）、isolated-vm（Skill 沙箱）、pgvector + Drizzle（向量检索）、Fastify v5（HTTP）、OpenTelemetry + Langfuse（可观测性）。每个选型的具体理由、解决的问题、带来的约束，第 1 章 1.4 节统一展开，本前言不重复列表。

## 如何阅读本书

**顺序阅读**：如果你正在从零开始构建一个 agent 系统，建议从第 1 章读到第 12 章。每章建立在前一章的基础上，代码示例逐步演化出完整的 AgentFlow 系统。

**跳章节阅读**：已经有 agent 基础的读者可以直接跳到目标章节——成本控制和 provider 切换看第 4 章，工具调用和沙箱看第 5 章，状态持久化看第 7 章，租户隔离看第 8 章，性能与稳定性看第 10 章。每章配套的 `examples/` 目录下都有独立可运行的代码，不依赖其他章节。

**参考手册用法**：附录 A-F 是参考性内容——API 手册、Skill 清单、Prompt 模板、压测数据、故障排查手册和上线 Checklist，实际开发时按需查阅。

## 代码说明

所有代码示例都经过实际运行验证。书中的代码片段是真实代码的节选，完整可运行版本在对应章节的 `examples/` 目录。

代码风格：单引号，2 空格缩进，TypeScript 严格模式。注释用中文，变量和函数名用英文。

运行环境要求：**Node.js 20.11 LTS**（避开 22+/24+——第 5 章 `isolated-vm` 在新版本 Node 上有 native binding 编译问题，详见第 2.0 节），npm 10+。每个 examples 目录有独立的 `package.json` 和 `README.md`，说明如何启动。

部分示例依赖外部服务（Redis、PostgreSQL、Temporal server），`examples/docker-compose.yml` 提供了本地开发所需的完整依赖。

## 关于准确性

AI agent 生态变化极快，书中提到的库版本和 API 可能已经迭代。每章开头会标注主要依赖的版本号；结论性的技术判断会给出依据，方便读者自行验证是否过时。

如果你发现书中的错误或过时内容，欢迎在本书的 GitHub 仓库提 issue。

---

本书第一章从一个具体的架构问题开始：1M 并发 session 到底意味着什么，以及大多数 agent 教程里的假设为什么在生产环境会失效。
