/**
 * BullMQ context 传播 helper
 *
 * 问题：BullMQ 的 job 是普通 JSON，OTel 默认 instrumentation 不会自动注入 traceparent。
 * 方案：投任务时显式 inject context；消费任务前显式 extract context。
 *
 * HTTP 链路上不需要这套代码 —— HTTP instrumentation 默认会处理 W3C traceparent header。
 */

import {
  trace,
  propagation,
  context,
  SpanKind,
  SpanStatusCode,
  type Context,
} from '@opentelemetry/api';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';

const tracer = trace.getTracer('agent-task', '1.0.0');

// ============ 类型定义 ============

export interface TaskPayload {
  tenantId: string;
  sessionId: string;
  prompt: string;
  /** OTel context carrier，由 enqueueAgentTask 自动注入 */
  _otelCarrier?: Record<string, string>;
}

// ============ 生产端：投任务时注入 trace context ============

/**
 * 把当前 active context（含 traceparent）序列化到 carrier，再随 job 一起入队。
 * carrier 序列化后通常只有 100-200 字节，可忽略不计。
 */
export async function enqueueAgentTask(
  queue: Queue<TaskPayload>,
  payload: Omit<TaskPayload, '_otelCarrier'>,
): Promise<void> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  await queue.add('agent-task', { ...payload, _otelCarrier: carrier });
}

// ============ 消费端：处理任务时提取 trace context ============

/**
 * 创建一个 Worker，在每个 job 处理前自动提取 trace context，
 * 让 worker 内部创建的 span 与生产端的 span 串成同一个 trace。
 *
 * @param queueName 队列名
 * @param connection Redis 连接（生产里通常注入外部连接池）
 * @param handler 实际业务处理函数，调用时 context 已被切换为生产端的 trace
 */
export function createAgentWorker(
  queueName: string,
  connection: IORedis,
  handler: (job: Job<TaskPayload>) => Promise<unknown>,
): Worker<TaskPayload> {
  return new Worker<TaskPayload>(
    queueName,
    async (job) => {
      // 从 job 数据里取出 carrier，提取 context
      const carrier = (job.data._otelCarrier ?? {}) as Record<string, string>;
      const parentCtx: Context = propagation.extract(context.active(), carrier);

      // context.with 设置 active context，handler 内部创建的 span 会自动挂到这个 trace 下
      return context.with(parentCtx, async () => {
        return tracer.startActiveSpan(
          'agent-task.process',
          { kind: SpanKind.CONSUMER },
          async (span) => {
            span.setAttribute('job.id', job.id ?? 'unknown');
            span.setAttribute('queue.name', queueName);
            span.setAttribute('tenant.id', job.data.tenantId);
            span.setAttribute('session.id', job.data.sessionId);
            span.setAttribute('messaging.system', 'bullmq');
            span.setAttribute('messaging.operation', 'process');
            try {
              const result = await handler(job);
              span.setStatus({ code: SpanStatusCode.OK });
              return result;
            } catch (err) {
              span.recordException(err as Error);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: (err as Error).message,
              });
              throw err;
            } finally {
              span.end();
            }
          },
        );
      });
    },
    { connection },
  );
}

// ============ Demo：模拟一次跨进程 trace ============

async function main(): Promise<void> {
  const connection = new IORedis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
  });

  const queueName = 'demo-agent-tasks';
  const queue = new Queue<TaskPayload>(queueName, { connection });

  // Worker：模拟一个会处理任务的进程
  const worker = createAgentWorker(queueName, connection.duplicate(), async (job) => {
    // eslint-disable-next-line no-console
    console.log(`[worker] 处理 job=${job.id} tenant=${job.data.tenantId}`);
    // 在 worker 处理逻辑中再创建一个子 span
    return tracer.startActiveSpan('agent-task.handler', async (s) => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { ok: true };
      } finally {
        s.end();
      }
    });
  });

  // 生产端：在一个 outer span 下投任务，验证 context 能传过去
  await tracer.startActiveSpan('demo.enqueue', async (outer) => {
    outer.setAttribute('demo.note', '此 span 是 worker 处理 span 的父级');
    await enqueueAgentTask(queue, {
      tenantId: 'tenant-A',
      sessionId: 'sess-demo',
      prompt: 'hello',
    });
    outer.end();
  });

  // 等 worker 处理完
  await new Promise((resolve) => setTimeout(resolve, 1500));

  await worker.close();
  await queue.close();
  await connection.quit();

  // 让 BatchSpanProcessor 有机会 flush
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
