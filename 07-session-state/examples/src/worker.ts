/**
 * Temporal Worker 启动入口
 *
 * Worker 进程负责：
 *   1. 连接 Temporal Server（默认 localhost:7233）
 *   2. 注册可执行的 Workflow 文件和 Activity 函数
 *   3. 监听指定的 task queue
 *   4. 接收任务、执行、上报结果
 *
 * 启动方式：
 *   npm run worker
 *
 * 生产注意：
 *   - 单机 Demo 用一个 Worker 进程即可
 *   - 生产环境通常部署多个 Worker，挂在同一个 task queue 上做负载均衡
 *   - Activity Worker 和 Workflow Worker 可以拆开部署，按 CPU/IO 特征调整副本数
 */

import { Worker, NativeConnection } from '@temporalio/worker';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import * as activities from './activities.js';

// ESM 下没有 __dirname，需要手动构造
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 默认 Temporal Server 地址（与 docker compose 启动的本地实例一致）
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
// task queue 名称：发起 Workflow 时必须指定相同的名字才能被这个 Worker 消费
const TASK_QUEUE = 'agentflow-reports';

/**
 * 启动 Worker
 */
export async function startWorker(): Promise<void> {
  console.log(`[Worker] 正在连接 Temporal Server: ${TEMPORAL_ADDRESS}`);

  // NativeConnection 是 Worker 专用的连接（基于 Rust core）
  // 与 Client 用的 Connection 不同，性能更好但 API 更受限
  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
  });

  // Worker.create() 同时注册 Workflow 和 Activity
  const worker = await Worker.create({
    connection,
    // Workflow 文件路径：Temporal 会用独立的 V8 isolate 加载它，保证确定性沙箱
    workflowsPath: resolve(__dirname, 'workflow.js'),
    // Activity 是普通的函数对象，直接传入即可
    activities,
    taskQueue: TASK_QUEUE,
    // 可选：限制并发数，避免单个 Worker 过载
    maxConcurrentActivityTaskExecutions: 10,
    maxConcurrentWorkflowTaskExecutions: 20,
  });

  console.log(`[Worker] 已启动，监听 task queue: ${TASK_QUEUE}`);
  console.log(`[Worker] 进程 PID: ${process.pid}`);

  // 优雅关闭：收到 SIGTERM/SIGINT 时停止接受新任务，等当前任务完成
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[Worker] 收到 ${signal}，开始优雅关闭...`);
    worker.shutdown();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // worker.run() 是阻塞调用，会一直运行直到 shutdown 被调用
  await worker.run();
  console.log('[Worker] 已退出');
}

// 直接执行此文件时启动 Worker
// 通过 `tsx src/worker.ts` 或 `npm run worker` 运行
if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch((err) => {
    console.error('[Worker] 启动失败:', err);
    process.exit(1);
  });
}
