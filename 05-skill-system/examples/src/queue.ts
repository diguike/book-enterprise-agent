/**
 * BullMQ 队列配置：异步 Skill 执行
 *
 * 同步执行（executeSkill）适合快速响应的场景（<5 秒）。
 * 异步队列适合：
 * - 执行时间较长的 Skill（>5 秒）
 * - 需要在后台静默执行的 Skill（发邮件、生成报告）
 * - 需要重试语义的 Skill（外部服务偶发性故障时自动重试）
 *
 * 注意：at-least-once 语义意味着 Worker 崩溃后任务会被重新投递。
 * Skill 执行必须是幂等的，或者在 jobId 层面做去重。
 *
 * 生产注意：
 * - 单机示例用 concurrency: 10 在单进程内模拟并发
 * - 生产中 Worker 是多进程（Kubernetes 多副本），每副本 concurrency 设 5-10
 * - Redis 需要持久化配置（AOF），避免重启后任务状态丢失
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type { SkillJobData } from './types.js';

// ─── Redis 连接配置 ──────────────────────────────────────────────

/**
 * Redis 连接配置。
 *
 * 生产中使用 Redis Sentinel 或 Redis Cluster 保证高可用。
 * 单机示例用单节点 Redis，但连接配置和 Key 命名与生产保持一致，
 * 方便后续迁移到集群模式（只需修改 host/port 配置）。
 */
export function createRedisConnection(): ConnectionOptions {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
    // 断线自动重连（BullMQ 要求）
    enableOfflineQueue: false,
    maxRetriesPerRequest: null,
  };
}

// ─── 队列定义 ─────────────────────────────────────────────────────

/** Skill 异步执行队列名称 */
const SKILL_QUEUE_NAME = 'agentflow:skill-execution';

/**
 * 创建 Skill 执行队列。
 *
 * 队列名称用 "agentflow:" 前缀，在 Redis 里和其他应用的 Key 隔离。
 * 生产中不同环境（dev/staging/prod）用不同的 Redis 实例，不是不同的前缀。
 */
export function createSkillQueue(connection: ConnectionOptions): Queue<SkillJobData> {
  return new Queue<SkillJobData>(SKILL_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // 失败后最多重试 3 次（at-least-once 语义）
      attempts: 3,
      // 指数退避：1s, 2s, 4s
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      // Job 完成后在 Redis 里保留 24 小时（用于调试和监控）
      // 生产中可以设短一些（1小时）节省 Redis 内存
      removeOnComplete: { age: 86400 },
      // Job 失败后保留 72 小时（用于排查问题）
      removeOnFail: { age: 259200 },
    },
  });
}

// ─── 添加任务 ─────────────────────────────────────────────────────

/**
 * 投递异步 Skill 执行任务。
 *
 * jobId 用于幂等性：相同 jobId 的任务只会被执行一次。
 * 调用方用 idempotencyKey 生成 jobId，确保重复投递不重复执行。
 */
export async function enqueueSkillExecution(
  queue: Queue<SkillJobData>,
  data: SkillJobData
): Promise<string> {
  const job = await queue.add(
    'execute-skill',
    data,
    {
      // 用幂等 key 作为 Job ID，防止重复投递时重复执行
      jobId: `skill:${data.idempotencyKey}`,
    }
  );

  console.log(
    `[queue] 任务已投递: jobId=${job.id}`,
    `skillId=${data.skillId}, tenantId=${data.tenantId}`
  );

  return job.id!;
}

// ─── Worker 创建 ─────────────────────────────────────────────────

/**
 * 创建 Skill 执行 Worker。
 *
 * Worker 监听队列，取出 Job 并执行。
 * processor 函数由调用方传入，包含实际的执行逻辑。
 *
 * @param processor - Job 处理函数，抛出异常时 BullMQ 会自动重试
 */
export function createSkillWorker(
  connection: ConnectionOptions,
  processor: (job: Job<SkillJobData>) => Promise<unknown>
): Worker<SkillJobData> {
  const worker = new Worker<SkillJobData>(
    SKILL_QUEUE_NAME,
    processor,
    {
      connection,
      // 单机示例：单进程内 10 并发
      // 生产注意：多进程部署时，每个进程设 concurrency: 5，
      // 通过增加进程数（副本数）来扩展吞吐，而不是增加单进程并发
      concurrency: 10,
      // 延迟 Job 的精度（毫秒），影响定时任务的准确性
      // 生产中不需要高精度延迟时，设大一些（1000ms）减少 Redis 轮询频率
    }
  );

  // 监听 Worker 生命周期事件，写入可观测性系统
  worker.on('completed', (job, result) => {
    console.log(
      `[worker] Job 完成: ${job.id}`,
      `(skillId=${job.data.skillId}, 耗时=${Date.now() - job.timestamp}ms)`
    );
    void result; // 结果已写入 Job 的 returnvalue，这里只记录日志
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[worker] Job 失败: ${job?.id}`,
      `(尝试 ${job?.attemptsMade}/${job?.opts.attempts})`,
      err.message
    );
  });

  worker.on('error', (err) => {
    // Worker 本身的错误（比如 Redis 断连），不是 Job 执行错误
    console.error('[worker] Worker 错误:', err.message);
  });

  return worker;
}

// ─── 等待异步任务完成 ─────────────────────────────────────────────

/**
 * 等待指定 Job 完成，返回执行结果。
 *
 * 用于需要等待异步 Skill 结果的场景（比如 Agent 需要 Skill 结果才能继续）。
 * 轮询间隔 100ms，最长等待 timeout 毫秒。
 *
 * 更优的实现是用 BullMQ Events（Redis Pub/Sub），避免轮询。
 * 本示例用轮询保持代码简单。
 */
export async function waitForJobResult(
  queue: Queue<SkillJobData>,
  jobId: string,
  timeout: number = 30000
): Promise<unknown> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);

    if (!job) throw new Error(`Job ${jobId} 不存在`);

    const state = await job.getState();

    if (state === 'completed') {
      return job.returnvalue;
    }

    if (state === 'failed') {
      throw new Error(`Job ${jobId} 执行失败: ${job.failedReason}`);
    }

    // 等待 100ms 后重新检查
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`等待 Job ${jobId} 超时（${timeout}ms）`);
}
