/**
 * 四层背压联动演示
 *
 * 这个文件把前面几个独立组件串起来，演示 AgentFlow 在一次请求路径上的完整背压：
 *
 *   入口层（Fastify + 令牌桶）
 *     -> 拒绝超额请求，返回 429
 *   Agent 层（BullMQ + concurrency）
 *     -> 排队，超出并发时延迟入队
 *   LLM Gateway 层（Circuit Breaker）
 *     -> 下游故障时短路，触发降级
 *   Skill 层（超时控制）
 *     -> 单次 Skill 限时 30s，超时进 DLQ
 *
 * 启动后用：curl -X POST http://localhost:3000/chat -H 'Content-Type: application/json' \
 *   -d '{"tenantId":"tenant-a","sessionId":"s1","message":"测试"}'
 *
 * 演示完整管线时建议同时打开 k6/load-test.js 做压力测试。
 */

import Fastify from 'fastify';
import Redis from 'ioredis';
import { QueueEvents } from 'bullmq';
import { RedisTokenBucket } from './token-bucket.js';
import { RedisCircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker.js';
import { createAgentQueue, createAgentWorker, PRIORITY, type AgentJobData } from './bullmq-setup.js';

const redis = new Redis({
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
});

// 入口层：每租户 60 容量、10/s 补充
const entryLimiter = new RedisTokenBucket(redis, 'entry-rate', 60, 10);

// LLM Gateway 层断路器
const llmBreaker = new RedisCircuitBreaker(redis, 'anthropic-api', {
  failureThreshold: 5,
  successThreshold: 2,
  openMs: 5000,
  halfOpenProbes: 2,
  windowMs: 30_000,
});

const agentQueue = createAgentQueue();

// 用于等待任务完成的事件流，需要复用同一个实例避免反复连接 Redis
const agentEvents = new QueueEvents('agent-tasks', {
  connection: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
});

/** 模拟 LLM 调用，带随机故障 */
async function callLLM(message: string): Promise<string> {
  // 30% 几率失败，演示断路器触发
  if (Math.random() < 0.3) {
    throw new Error('Anthropic 429 rate_limit');
  }
  await new Promise((r) => setTimeout(r, 100));
  return `回复: ${message}`;
}

/** 模拟 Skill 调用，带超时控制 */
async function callSkill<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`skill timeout after ${timeoutMs}ms`)), timeoutMs);
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Agent Worker：从队列消费，串联断路器与 Skill 超时
const worker = createAgentWorker(async (job) => {
  const { message, tenantId, sessionId } = job.data;

  // LLM 层：走断路器
  const reply = await llmBreaker
    .execute(
      () => callLLM(message),
      // fallback：断路器打开时返回降级答复
      async () => '系统繁忙，请稍后重试',
    )
    .catch((err) => {
      if (err instanceof CircuitBreakerOpenError) return '服务降级中';
      throw err;
    });

  // Skill 层：示例超时
  const skillResult = await callSkill(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return 'skill-ok';
  }, 30_000);

  return { tenantId, sessionId, reply, skillResult };
});

worker.on('failed', (job, err) => {
  console.error(`[worker] 任务 ${job?.id} 失败: ${err.message}`);
});

// 入口层
const app = Fastify({ logger: false });

app.post('/chat', async (req, reply) => {
  const body = req.body as AgentJobData;
  if (!body?.tenantId || !body?.message) {
    return reply.code(400).send({ error: 'bad request' });
  }

  // 入口层：令牌桶限流
  const allowed = await entryLimiter.tryConsume(body.tenantId);
  if (!allowed) {
    return reply.code(429).send({ error: 'rate_limited' });
  }

  // 区分租户优先级：tenant-a 实时，其他批量
  const priority = body.tenantId === 'tenant-a' ? PRIORITY.REALTIME : PRIORITY.BATCH;

  // 入队
  const job = await agentQueue.add('process', body, {
    priority,
    attempts: 3,
    backoff: { type: 'exponential', delay: 500 },
  });

  // 等结果（生产中通常异步：返回 jobId，前端 SSE 拉结果）
  try {
    const result = await job.waitUntilFinished(agentEvents, 15_000);
    return reply.send(result);
  } catch (err) {
    return reply.code(504).send({ error: 'timeout', detail: (err as Error).message });
  }
});

app.get('/health', async () => ({
  ok: true,
  llmBreakerState: await llmBreaker.getState(),
}));

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`AgentFlow demo listening on http://localhost:${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// 优雅退出，避免本地反复重启留下游离 worker
async function shutdown(): Promise<void> {
  await worker.close();
  await agentEvents.close();
  await agentQueue.close();
  await redis.quit();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
