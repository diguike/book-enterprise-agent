/**
 * Temporal Activities 实现
 *
 * Activity 是真正执行 I/O 的地方：DB 查询、HTTP 请求、LLM 调用、发邮件。
 * Activity 代码没有确定性要求，可以有随机性和副作用。
 *
 * 关键要求：
 * 1. 长时间运行的 Activity 必须定期发送心跳（heartbeat）
 * 2. Activity 必须设计为幂等的（可以被安全地重试）
 */

import { Context } from '@temporalio/activity';

// ==================== 类型定义 ====================

export interface Transaction {
  id: string;
  tenantId: string;
  amount: number;
  currency: string;
  timestamp: string;
  merchantId: string;
  riskFlags: string[];
}

export interface RiskAnalysisResult {
  transactionId: string;
  riskScore: number;      // 0-100
  riskLevel: 'low' | 'medium' | 'high';
  reasons: string[];
}

export interface ReportSummary {
  tenantId: string;
  totalTransactions: number;
  highRiskCount: number;
  totalAmount: number;
  generatedAt: string;
  content: string;         // LLM 生成的自然语言摘要
}

// ==================== fetchTransactions ====================

/**
 * 从数据库拉取指定租户的月度交易记录
 *
 * 实际场景里这是一个分页查询，可能需要几十秒。
 * 使用心跳防止 Temporal 认为 Activity 超时。
 */
export async function fetchTransactions(
  tenantId: string
): Promise<Transaction[]> {
  const ctx = Context.current();

  console.log(`[fetchTransactions] 开始拉取租户 ${tenantId} 的交易记录`);
  ctx.heartbeat('开始拉取交易记录');

  // 模拟分页数据库查询
  // 实际实现：SELECT * FROM transactions WHERE tenant_id = $1 AND ...
  const allTransactions: Transaction[] = [];
  const totalPages = 5; // 模拟5页数据，实际可能是100页

  for (let page = 0; page < totalPages; page++) {
    // 模拟数据库查询延迟
    await simulateDelay(200);

    // 生成模拟数据（实际场景替换为真正的 DB 查询）
    const pageBatch = generateMockTransactions(tenantId, page, 20);
    allTransactions.push(...pageBatch);

    // 每5页发送一次心跳，告知 Temporal 仍在运行
    if ((page + 1) % 5 === 0 || page === totalPages - 1) {
      ctx.heartbeat(`已拉取 ${allTransactions.length} 条记录（第 ${page + 1}/${totalPages} 页）`);
      console.log(`[fetchTransactions] 进度: ${page + 1}/${totalPages}`);
    }
  }

  console.log(`[fetchTransactions] 完成，共 ${allTransactions.length} 条`);
  return allTransactions;
}

// ==================== analyzeRisk ====================

/**
 * 对一批交易记录进行风险评估
 *
 * 接受批次索引（batchIndex）是为了支持幂等：
 * 如果 Activity 重试，同一批次的分析结果应该一致。
 */
export async function analyzeRisk(
  tenantId: string,
  transactions: Transaction[],
  batchIndex: number
): Promise<RiskAnalysisResult[]> {
  const ctx = Context.current();

  console.log(
    `[analyzeRisk] 处理批次 ${batchIndex}，共 ${transactions.length} 条`
  );
  ctx.heartbeat(`分析批次 ${batchIndex}`);

  // 模拟调用风险评估 API
  await simulateDelay(500);

  const results: RiskAnalysisResult[] = transactions.map((tx) => {
    // 模拟风险评分逻辑（实际替换为真正的风险评估服务调用）
    const riskScore = calculateMockRiskScore(tx);
    return {
      transactionId: tx.id,
      riskScore,
      riskLevel: riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'low',
      reasons: riskScore >= 70 ? ['金额异常', '频繁交易'] : [],
    };
  });

  console.log(`[analyzeRisk] 批次 ${batchIndex} 完成`);
  return results;
}

// ==================== generateSummary ====================

/**
 * 调用 LLM 生成月度合规报告摘要
 *
 * 实际实现应使用 @anthropic-ai/sdk，这里用模拟数据
 */
export async function generateSummary(
  tenantId: string
): Promise<ReportSummary> {
  const ctx = Context.current();

  console.log(`[generateSummary] 开始生成报告摘要，租户: ${tenantId}`);
  ctx.heartbeat('调用 LLM 生成摘要');

  // 模拟 LLM API 调用延迟
  await simulateDelay(1000);

  const summary: ReportSummary = {
    tenantId,
    totalTransactions: 100,
    highRiskCount: 3,
    totalAmount: 5_820_000,
    generatedAt: new Date().toISOString(),
    content: `本月共处理交易 100 笔，总金额 582 万元。
      识别高风险交易 3 笔，已标记待审。
      整体风险水平处于正常范围，建议对高风险交易进行人工复核。`,
  };

  console.log(`[generateSummary] 摘要生成完成`);
  return summary;
}

// ==================== sendEmail ====================

/**
 * 发送报告邮件给合规团队
 *
 * 幂等处理：使用 workflowRunId 作为幂等 key，防止重试时重复发送邮件。
 */
export async function sendEmail(
  tenantId: string,
  report: ReportSummary
): Promise<void> {
  const ctx = Context.current();

  // 用 Workflow Run ID 构造幂等 key
  // Activity Context 的 workflowExecution 在被 Workflow 调用时一定存在
  const runId = ctx.info.workflowExecution?.runId ?? 'standalone';
  const idempotencyKey = `email-report-${tenantId}-${runId}`;

  console.log(`[sendEmail] 准备发送邮件，幂等 key: ${idempotencyKey}`);
  ctx.heartbeat('发送邮件');

  // 检查是否已发送（实际场景用数据库或 Redis 存储幂等记录）
  const alreadySent = await checkEmailIdempotency(idempotencyKey);
  if (alreadySent) {
    console.log(`[sendEmail] 邮件已发送（幂等跳过）: ${idempotencyKey}`);
    return;
  }

  // 模拟邮件发送
  await simulateDelay(300);
  console.log(`[sendEmail] 邮件发送成功，租户: ${tenantId}，报告时间: ${report.generatedAt}`);

  // 记录幂等 key（实际用 DB/Redis 持久化）
  await markEmailSent(idempotencyKey);
}

// ==================== 工具函数（模拟实现）====================

async function simulateDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateMockTransactions(
  tenantId: string,
  page: number,
  count: number
): Transaction[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `tx-${tenantId}-${page * count + i}`,
    tenantId,
    amount: Math.floor(Math.random() * 100000) + 100,
    currency: 'CNY',
    timestamp: new Date(Date.now() - Math.random() * 30 * 24 * 3600 * 1000).toISOString(),
    merchantId: `merchant-${Math.floor(Math.random() * 100)}`,
    riskFlags: [],
  }));
}

function calculateMockRiskScore(tx: Transaction): number {
  // 简单的模拟评分逻辑
  let score = 10;
  if (tx.amount > 50000) score += 30;
  if (tx.amount > 80000) score += 30;
  return Math.min(100, score + Math.floor(Math.random() * 20));
}

// 内存模拟幂等存储（实际应使用 Redis 或数据库）
const sentEmailKeys = new Set<string>();

async function checkEmailIdempotency(key: string): Promise<boolean> {
  return sentEmailKeys.has(key);
}

async function markEmailSent(key: string): Promise<void> {
  sentEmailKeys.add(key);
}
