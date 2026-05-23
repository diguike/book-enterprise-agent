/**
 * 死信队列（Dead Letter Queue）
 *
 * BullMQ 默认行为：任务重试到 attempts 上限仍失败时，状态变成 'failed'，
 * 留在 failed 集合里。如果不清理，几天就涨到几十万条；如果清理，关键失败
 * 现场就丢了。
 *
 * 工程做法：把彻底失败的任务搬到独立的 DLQ 队列，配上：
 *   - 持久化到 Postgres dead_letter_jobs 表，便于审计和分析
 *   - 触发告警（按租户、任务类型分级）
 *   - 提供管理后台：人工查看 + 修复参数 + 重放
 *   - 增长率监控（突然飙升说明系统有问题）
 *
 * 本文件演示前两步——搬到 DLQ 队列 + 持久化到一个内存表（生产换成 SQL）。
 */

import { Queue, Worker, type Job } from 'bullmq';

const connection = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
};

/** 死信记录的结构，落库时按这个结构建表 */
export interface DeadLetterRecord {
  id: string;
  originalQueue: string;
  jobName: string;
  data: unknown;
  error: string;
  stack: string | undefined;
  attemptsMade: number;
  failedAt: number;
  tenantId: string | undefined;
}

/**
 * 简化版"持久化层"：实际生产应换成 Postgres insert
 */
class DeadLetterStore {
  private records: DeadLetterRecord[] = [];

  async save(record: DeadLetterRecord): Promise<void> {
    this.records.push(record);
    // 生产中这里：await db.insert(deadLetterJobs).values(record);
  }

  async list(): Promise<DeadLetterRecord[]> {
    return [...this.records];
  }

  /** 按租户统计，用于告警分级 */
  async countByTenant(): Promise<Record<string, number>> {
    const stats: Record<string, number> = {};
    for (const r of this.records) {
      const key = r.tenantId ?? 'unknown';
      stats[key] = (stats[key] ?? 0) + 1;
    }
    return stats;
  }
}

/**
 * 把彻底失败的任务搬到 DLQ
 *
 * 用法：在原 Worker 的 'failed' 事件里调用，仅当 attemptsMade 达到上限时
 * 才搬运（这样允许 BullMQ 自动重试若干次，不是一失败就进 DLQ）。
 */
export function attachDeadLetterHandler(
  // 用任意 Worker 类型避免泛型推断把 ResultType 锁成 never
  worker: Worker<any, any>,
  dlqQueue: Queue,
  store: DeadLetterStore,
): void {
  worker.on('failed', async (job: Job<any, any> | undefined, error: Error) => {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      // 还能继续重试，不进 DLQ
      return;
    }

    const record: DeadLetterRecord = {
      id: job.id ?? `unknown-${Date.now()}`,
      originalQueue: worker.name,
      jobName: job.name,
      data: job.data,
      error: error.message,
      stack: error.stack,
      attemptsMade: job.attemptsMade,
      failedAt: Date.now(),
      tenantId: (job.data as { tenantId?: string })?.tenantId,
    };

    // 双写：BullMQ DLQ 队列 + Postgres
    // DLQ 队列方便用同一套消费机制做"重放"
    await dlqQueue.add('dead-letter', record, {
      // DLQ 任务不重试，单纯做现场存档
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
    await store.save(record);

    console.warn(
      `[DLQ] 任务 ${record.id} (${record.originalQueue}/${record.jobName}) 进入死信队列：${record.error}`,
    );
  });
}

/**
 * DLQ Worker：可选——做告警、统计
 */
export function createDlqWorker(onRecord: (r: DeadLetterRecord) => Promise<void>): Worker {
  return new Worker<DeadLetterRecord>(
    'dlq',
    async (job) => {
      await onRecord(job.data);
    },
    { connection, concurrency: 5 },
  );
}

// --- 演示 ---
async function demo(): Promise<void> {
  const taskQueue = new Queue('demo-tasks', { connection });
  const dlqQueue = new Queue('dlq', { connection });
  const store = new DeadLetterStore();

  // 清场
  await taskQueue.obliterate({ force: true });
  await dlqQueue.obliterate({ force: true });

  // 模拟一个永远失败的任务
  // 显式标注第二个泛型为 unknown，避免 TypeScript 把 ResultType 推断成 never
  const worker = new Worker<unknown, unknown>(
    'demo-tasks',
    async (): Promise<unknown> => {
      throw new Error('下游永久挂了');
    },
    {
      connection,
      // 退避策略：每次重试间隔指数增长
      settings: { backoffStrategy: (attempts) => 100 * attempts },
    },
  );

  attachDeadLetterHandler(worker, dlqQueue, store);

  const dlqWorker = createDlqWorker(async (record) => {
    // 实际告警：根据租户的严重程度发邮件 / 钉钉 / 飞书
    console.log(`[告警] 租户 ${record.tenantId} 任务失败：${record.error}`);
  });

  // 投递 3 个任务，每个最多 2 次尝试（初次 + 1 次重试），用尽后进 DLQ
  for (let i = 0; i < 3; i++) {
    await taskQueue.add(
      'process',
      { tenantId: `tenant-${i}`, payload: i },
      { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    );
  }

  // 等够时间让所有重试 + DLQ 处理完
  await new Promise((r) => setTimeout(r, 1500));

  console.log('DLQ 统计：', await store.countByTenant());

  await worker.close();
  await dlqWorker.close();
  await taskQueue.close();
  await dlqQueue.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
