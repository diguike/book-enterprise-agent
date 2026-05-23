/**
 * Temporal Workflow 定义
 *
 * 月度合规报告 Workflow，对应租户 C（金融机构）的真实场景：
 *   1. 拉取一个月的交易记录（约 10 万条，预计 30 秒）
 *   2. 分批进行风险评估（每批 1000 条，每批耗时数秒）
 *   3. 调用 LLM 生成报告摘要（耗时 1 分钟）
 *   4. 发送邮件给合规团队
 *
 * 整个 Workflow 总耗时 5-10 分钟，期间任意环节崩溃都能从断点恢复。
 *
 * 确定性约束（重要）：
 *   ✗ 不能使用 Date.now()、Math.random()、原生 setTimeout、直接 fetch
 *   ✓ 只能使用 Temporal 提供的 sleep / workflowInfo / proxyActivities
 *   ✓ 真正的 I/O 必须封装为 Activity 通过 proxy 调用
 */

import { proxyActivities, sleep, workflowInfo, log } from '@temporalio/workflow';
import type * as activities from './activities.js';
import type { ReportSummary } from './activities.js';

// 通过 proxyActivities 声明此 Workflow 会调用的 Activity
// 这里设置的是整组 Activity 的统一重试策略，单个 Activity 可在调用处覆盖
const { fetchTransactions, analyzeRisk, generateSummary, sendEmail } =
  proxyActivities<typeof activities>({
    // startToCloseTimeout: 单次 Activity 执行的最长时间
    startToCloseTimeout: '10 minutes',
    // heartbeatTimeout: Activity 心跳超时，超过此值未收到心跳视为失活
    heartbeatTimeout: '30 seconds',
    retry: {
      // 失败后最多重试 3 次，第 4 次失败 Workflow 才会得到异常
      maximumAttempts: 3,
      // 第一次重试间隔
      initialInterval: '1 second',
      // 指数退避系数：1s → 2s → 4s
      backoffCoefficient: 2,
      maximumInterval: '1 minute',
    },
  });

// ==================== 月度报告 Workflow ====================

/**
 * 月度合规报告 Workflow 主体
 *
 * 入口参数：tenantId（哪个租户的报告）
 * 返回值：ReportSummary（最终生成的报告摘要）
 *
 * 每个 await 调用都是一个 checkpoint：Worker 重启后会从最后一个完成的
 * checkpoint 之后继续执行，而不是从头开始。
 */
export async function monthlyReportWorkflow(
  tenantId: string
): Promise<ReportSummary> {
  // workflowInfo() 返回当前 Workflow 的元数据，重放时一致（确定性）
  const info = workflowInfo();
  log.info('月度报告 Workflow 启动', {
    workflowId: info.workflowId,
    runId: info.runId,
    tenantId,
  });

  // ====== 阶段 1：拉取交易记录 ======
  // 如果这里崩溃，重启后会重新执行 fetchTransactions
  const transactions = await fetchTransactions(tenantId);
  log.info('交易记录拉取完成', { count: transactions.length });

  // ====== 阶段 2：分批进行风险评估 ======
  // 分批的好处：每批是一个独立的 Activity，崩溃后只重做当前批，
  // 已完成的批次结果保留在 event history 里
  const batchSize = 1000;
  const allRiskResults: activities.RiskAnalysisResult[] = [];

  for (let i = 0; i < transactions.length; i += batchSize) {
    const batch = transactions.slice(i, i + batchSize);
    const batchIndex = Math.floor(i / batchSize);

    // 每个批次都是一个独立的 Activity 调用
    // 注意：传 batchIndex 参数是为了 Activity 内部做幂等去重
    const batchResults = await analyzeRisk(tenantId, batch, batchIndex);
    allRiskResults.push(...batchResults);

    log.info('批次风险评估完成', {
      batchIndex,
      processed: allRiskResults.length,
      total: transactions.length,
    });
  }

  // ====== 阶段 3：稍微等一下，给下游系统一点缓冲时间 ======
  // 不要用原生 setTimeout，必须用 Temporal 提供的 sleep（确定性的）
  await sleep('2 seconds');

  // ====== 阶段 4：调用 LLM 生成摘要 ======
  const summary = await generateSummary(tenantId);
  log.info('LLM 摘要生成完成', {
    highRiskCount: summary.highRiskCount,
    totalAmount: summary.totalAmount,
  });

  // ====== 阶段 5：发送邮件 ======
  // 即使 Workflow 在这里崩溃重试，sendEmail Activity 内部有幂等保护
  await sendEmail(tenantId, summary);
  log.info('邮件发送完成');

  return summary;
}

// ==================== Workflow 健康检查 ====================

/**
 * 一个简单的 ping Workflow，用于验证 Worker 是否在线
 * 在 index.ts 中用来作为 Demo
 */
export async function pingWorkflow(message: string): Promise<string> {
  log.info('收到 ping', { message });
  // 用 Temporal 的 sleep，不能用原生 setTimeout
  await sleep('100 milliseconds');
  return `pong: ${message}`;
}
