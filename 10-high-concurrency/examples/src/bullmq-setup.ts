/**
 * BullMQ 深度使用：优先级队列、延迟任务、Parent-Child、并发与限流
 *
 * 演示场景对照 AgentFlow：
 *   - 主队列 agent-tasks：处理一次完整的 Agent 调用
 *   - skill 子队列 skill-tasks：Agent step 内部触发的 Skill 调用并发执行
 *   - 高优先级（priority=1）给租户 A 的实时客服对话
 *   - 低优先级（priority=10）给租户 C 的批量合规扫描
 *
 * 生产注意：BullMQ 的 priority 数字越小越优先（直觉容易反），写代码时用常量
 * 表达更安全。本文件用 PRIORITY 常量演示这种习惯。
 */

import { Queue, Worker, QueueEvents, FlowProducer, type Job } from 'bullmq';
import Redis from 'ioredis';

const connection = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
  // BullMQ 强制要求 maxRetriesPerRequest = null，否则重连时会丢任务
  maxRetriesPerRequest: null,
};

/**
 * 统一的队列 key 前缀（带 hash tag）。
 *
 * BullMQ 一个队列内部有十几个 key（wait/active/completed/delayed 等），Lua 脚本要
 * 跨这些 key 原子操作。Redis Cluster 要求脚本涉及的 key 全部落在同一个 hash slot，
 * 否则报 CROSSSLOT——所以官方要求 Queue/Worker/QueueEvents 构造时配
 * prefix: '{queueName}' 形式的 hash tag。
 *
 * 这里所有队列（含 skill 子队列和 DLQ）共用同一个 tag：FlowProducer 的
 * parent-child 要跨 agent-tasks / skill-tasks 两个队列原子写入，DLQ 重放要同时
 * 操作主队列和 DLQ 的 key，都必须同 slot。单机 Redis 不校验 slot，但按第 2 章的
 * 单机模拟规则，key 设计必须按 Cluster 写。
 */
export const QUEUE_PREFIX = '{agent-tasks}';

/** 业务约定的优先级档位，数字越小越优先 */
export const PRIORITY = {
  REALTIME: 1, // 实时客服对话
  STANDARD: 5, // 普通后台任务
  BATCH: 10, // 批量任务
} as const;

/** Agent 任务数据 */
export interface AgentJobData {
  tenantId: string;
  sessionId: string;
  message: string;
}

/** Skill 任务数据 */
export interface SkillJobData {
  tenantId: string;
  skillName: string;
  input: Record<string, unknown>;
}

/**
 * 构造 Agent 主队列：限速 + 优先级
 */
export function createAgentQueue(): Queue<AgentJobData> {
  return new Queue<AgentJobData>('agent-tasks', { connection, prefix: QUEUE_PREFIX });
}

/**
 * 构造 Skill 子队列
 */
export function createSkillQueue(): Queue<SkillJobData> {
  return new Queue<SkillJobData>('skill-tasks', { connection, prefix: QUEUE_PREFIX });
}

/**
 * 启动 Agent Worker
 *
 * concurrency 是单 Worker 进程内的并发数，不是全局并发。
 * 多 Pod 部署时全局并发 = Pod 数 × concurrency，限流要按全局算。
 */
export function createAgentWorker(
  processor: (job: Job<AgentJobData>) => Promise<unknown>,
): Worker<AgentJobData> {
  return new Worker<AgentJobData>('agent-tasks', processor, {
    connection,
    prefix: QUEUE_PREFIX,
    concurrency: 50,
    // limiter 作用于整个 Worker，跨 Pod 共享同名 group 时通过 Redis 协调
    limiter: {
      max: 100,
      duration: 1000,
    },
  });
}

/**
 * 演示 1：优先级队列
 */
async function demoPriority(queue: Queue<AgentJobData>): Promise<void> {
  console.log('--- 演示 1：优先级队列 ---');
  // 先投 5 个低优先级
  for (let i = 0; i < 5; i++) {
    await queue.add(
      'process',
      { tenantId: 'tenant-c', sessionId: `c-${i}`, message: '批量任务' },
      { priority: PRIORITY.BATCH },
    );
  }
  // 再投 2 个高优先级，预期会插队到前面
  for (let i = 0; i < 2; i++) {
    await queue.add(
      'process',
      { tenantId: 'tenant-a', sessionId: `a-${i}`, message: '实时对话' },
      { priority: PRIORITY.REALTIME },
    );
  }
}

/**
 * 演示 2：延迟任务
 *
 * 用途：被限流时不直接拒绝用户，而是把任务推迟到配额恢复后执行。
 */
async function demoDelay(queue: Queue<AgentJobData>): Promise<void> {
  console.log('--- 演示 2：延迟任务（5 秒后执行）---');
  await queue.add(
    'process',
    { tenantId: 'tenant-a', sessionId: 'delayed', message: '延迟示例' },
    { delay: 5000 },
  );
}

/**
 * 演示 3：Parent-Child 任务
 *
 * Agent 一次 step 触发多个 Skill 并发执行，全部完成后再走汇总逻辑。
 * FlowProducer 创建的 parent 任务会自动等所有 children 完成。
 */
async function demoFlow(): Promise<void> {
  console.log('--- 演示 3：Parent-Child 任务 ---');
  // FlowProducer 也要带同一个 prefix：parent-child 跨两个队列原子写入，key 必须同 slot
  const flow = new FlowProducer({ connection, prefix: QUEUE_PREFIX });

  await flow.add({
    name: 'aggregate',
    queueName: 'agent-tasks',
    data: { tenantId: 'tenant-a', sessionId: 'flow-1', message: '汇总响应' },
    children: [
      {
        name: 'skill',
        queueName: 'skill-tasks',
        data: { tenantId: 'tenant-a', skillName: 'queryOrder', input: { orderId: '123' } },
      },
      {
        name: 'skill',
        queueName: 'skill-tasks',
        data: { tenantId: 'tenant-a', skillName: 'queryLogistics', input: { orderId: '123' } },
      },
    ],
  });

  await flow.close();
}

// --- 演示入口 ---
async function demo(): Promise<void> {
  const queue = createAgentQueue();
  const skillQueue = createSkillQueue();

  // 清掉历史任务，便于反复演示
  await queue.obliterate({ force: true });
  await skillQueue.obliterate({ force: true });

  const agentEvents = new QueueEvents('agent-tasks', { connection, prefix: QUEUE_PREFIX });

  // 启动两个 worker：agent 主队列、skill 子队列
  const agentWorker = createAgentWorker(async (job) => {
    // 模拟 Agent 处理耗时
    await new Promise((r) => setTimeout(r, 50));
    console.log(`[agent] 处理 ${job.data.sessionId} (priority=${job.opts.priority ?? 'n/a'})`);
    return { ok: true };
  });
  const skillWorker = new Worker<SkillJobData>(
    'skill-tasks',
    async (job) => {
      await new Promise((r) => setTimeout(r, 30));
      console.log(`[skill] ${job.data.skillName}`);
      return { result: 'mock' };
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 20 },
  );

  await demoPriority(queue);
  await demoDelay(queue);
  await demoFlow();

  // 等所有立刻入队的任务跑完，延迟任务不等
  await new Promise<void>((resolve) => {
    let done = 0;
    const target = 7 + 3; // 7 个优先级 + 1 个 aggregate + 2 个 skill
    agentEvents.on('completed', () => {
      done++;
      if (done >= target) resolve();
    });
    // 兜底超时
    setTimeout(resolve, 5000);
  });

  await agentWorker.close();
  await skillWorker.close();
  await agentEvents.close();
  await queue.close();
  await skillQueue.close();

  // 关掉演示用的 Redis 连接池
  const r = new Redis(connection);
  await r.quit();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
