---
title: 第 1 章代码示例
---

## 运行方法

```bash
cd examples
npm install
npx tsx src/scale-calculator.ts
npx tsx src/session-state-demo.ts
```

Node.js 版本要求：>= 20.0.0

## 示例说明

### scale-calculator.ts

对应章节 1.1「规模校准：数字背后的真实含义」。

演示如何将业务目标数字（session 数、QPS）换算为基础设施压力指标。包含三个典型场景：

- 低峰期（凌晨 2 点）：5 万 session，QPS 500
- 正常工作日（上午 10 点）：20 万 session，QPS 1 万
- 双十一峰值（电商租户 50x 流量）：100 万 session，QPS 5 万

核心换算逻辑：

```
真实并发 session = totalSessions × activeRatio
每秒推理请求    = userQPS × inferenceRatio
每秒 LLM 调用  = 每秒推理请求 × avgStepsPerRequest × avgLLMCallsPerStep
LLM 并发连接   = 每秒 LLM 调用 × avgLLMLatencySec  （Little's Law）
```

不依赖任何外部 API，可直接运行。

### session-state-demo.ts

对应章节 1.2「假设一：状态在内存里」。

对比两种 session 状态存储方案，演示 Pod 重启时的行为差异：

| 方案 | 实现 | Pod 重启后 | 多 Pod 扩容后 |
|------|------|-----------|-------------|
| 错误做法 | 进程内 `Map` | session 全部丢失 | 跨 Pod 数据不共享 |
| 正确做法 | Redis 外部存储（Mock） | 状态透明恢复 | 所有 Pod 共享同一份数据 |

`Session` 类型从 `../../agentflow/packages/shared/src/index.ts` 引入。
在 monorepo 项目中，实际通过包名引入：

```typescript
import type { Session } from '@agentflow/shared';
```

Redis 操作通过 Mock 实现，不需要启动真实 Redis 即可运行。
真实 Redis 集成详见第 7 章。
