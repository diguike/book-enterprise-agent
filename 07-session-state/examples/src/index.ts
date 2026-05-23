/**
 * 第7章演示入口
 *
 * 串联演示本章三个核心组件的协作：
 *   1. RedisSessionStore：跨 Pod 共享的会话状态
 *   2. compressContext：长对话的上下文压缩
 *   3. AuditLogger：金融租户的审计日志
 *   4. Temporal Workflow：长任务的持久执行（需要本地 Temporal Server 运行）
 *
 * 运行方式：
 *   # 仅运行 Session/Context/Audit 演示（不需要 Temporal）
 *   npm run demo
 *
 *   # 完整演示（需要先启动 Temporal Server 和 Worker）
 *   DEMO_TEMPORAL=1 npm run demo
 *
 * 依赖服务：
 *   - Redis: localhost:6379
 *   - Postgres: localhost:5432 / db=agentflow
 *   - Temporal Server: localhost:7233（可选）
 */

import { createSessionStore, type ConversationMessage } from './session-store.js';
import { compressContext, estimateMessagesTokens } from './context-manager.js';
import { createAuditLogger } from './audit-logger.js';
import type { ReportSummary } from './activities.js';

// ==================== 环境配置 ====================

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const PG_URL =
  process.env.PG_URL ?? 'postgres://postgres:postgres@localhost:5432/agentflow';
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const RUN_TEMPORAL_DEMO = process.env.DEMO_TEMPORAL === '1';

// ==================== Demo 1: Session 跨 Pod 共享 ====================

async function demoSessionStore(): Promise<void> {
  console.log('\n========== Demo 1: 跨 Pod Session 共享 ==========');

  const store = createSessionStore(REDIS_URL, PG_URL);
  const sessionId = `demo-session-${Date.now()}`;
  const tenantId = 'tenant-c-financial';
  const userId = 'user-001';

  // Pod-A 创建 session：用户发了第一条消息
  console.log('\n[Pod-A] 创建 session 并写入第一条消息');
  await store.set(sessionId, {
    sessionId,
    tenantId,
    userId,
    messages: [],
    agentConfig: {
      systemPrompt: '你是 AgentFlow 客服助手',
      model: 'claude-sonnet-4-5',
      maxTokens: 4096,
      temperature: 0.3,
      enabledSkills: ['order_query', 'refund'],
    },
    activeSkills: ['order_query'],
    metadata: { source: 'web' },
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });

  await store.appendMessage(sessionId, {
    role: 'user',
    content: '我的订单号是 12345，请帮我查一下状态',
    timestamp: Date.now(),
  });

  // Pod-B 处理用户的第二条消息：必须能读到 Pod-A 写入的状态
  console.log('[Pod-B] 接管该 session（模拟负载均衡到不同 Pod）');
  const session = await store.get(sessionId);
  if (!session) {
    throw new Error('Pod-B 读取 session 失败');
  }
  console.log(`[Pod-B] 读到 session，tenant=${session.tenantId} user=${session.userId}`);

  const messages = await store.getMessages(sessionId);
  console.log(`[Pod-B] 历史消息条数: ${messages.length}`);
  console.log(`[Pod-B] 上一轮用户说: "${messages[0]?.content}"`);

  // Pod-B 追加 assistant 的回复
  await store.appendMessage(sessionId, {
    role: 'assistant',
    content: '已查询到订单 12345，当前状态为「已发货」，预计 2 天后送达。',
    timestamp: Date.now(),
  });

  // 演示归档
  console.log('[Pod-B] 演示归档流程（写入 Postgres + 清理 Redis）');
  try {
    await store.archive(sessionId);
  } catch (err) {
    console.warn('归档失败（可能 Postgres 未启动或表不存在）:', (err as Error).message);
  }
}

// ==================== Demo 2: 长对话上下文压缩 ====================

async function demoContextCompression(): Promise<void> {
  console.log('\n========== Demo 2: 长对话上下文压缩 ==========');

  // 构造 60 条历史消息（模拟一个跑了一段时间的客服会话）
  const messages: ConversationMessage[] = [];
  messages.push({
    role: 'system',
    content: '你是一个专业的电商客服助手，帮助用户处理订单相关问题。',
    timestamp: Date.now() - 60 * 60 * 1000,
  });

  for (let i = 0; i < 60; i++) {
    const isUser = i % 2 === 0;
    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: isUser
        ? `这是第 ${i / 2 + 1} 个用户问题，里面包含一些订单查询、物流跟踪、退款申请等常见的客服场景内容，用来填充对话长度。`
        : `这是助手对第 ${(i - 1) / 2 + 1} 个问题的回复，里面包含了详细的解答过程、相关订单信息、推荐操作步骤，内容比较长以便测试压缩效果。`,
      timestamp: Date.now() - (60 - i) * 60 * 1000,
    });
  }

  const latestUserMessage = '帮我查一下订单 12345 的物流';
  const before = estimateMessagesTokens(messages);

  const result = compressContext(messages, latestUserMessage);

  console.log(`原始消息数: ${messages.length}`);
  console.log(`原始 token 估算: ${before}`);
  console.log(`压缩后消息数: ${result.messages.length}`);
  console.log(`压缩后 token 估算: ${result.compressedTokens}`);
  console.log(`丢弃消息数: ${result.droppedCount}`);
  console.log(`摘要化消息数: ${result.summarizedCount}`);
  console.log(
    `压缩率: ${((1 - result.compressedTokens / result.originalTokens) * 100).toFixed(1)}%`
  );
}

// ==================== Demo 3: 审计日志 + PII 脱敏 ====================

async function demoAuditLogger(): Promise<void> {
  console.log('\n========== Demo 3: 审计日志 + PII 脱敏 ==========');

  const logger = createAuditLogger(PG_URL);

  // 模拟一次 LLM 调用，prompt 里含 PII
  const rawPrompt = '用户 13812345678 提供身份证 110101199001011234 申请退款，卡号 6225880123456789';
  await logger.write({
    tenantId: 'tenant-c-financial',
    sessionId: 'session-demo-001',
    eventType: 'llm_call',
    actor: 'user-001',
    payload: {
      model: 'claude-sonnet-4-5',
      inputTokens: 1024,
      outputTokens: 512,
      latencyMs: 1850,
      skillsUsed: ['refund'],
      promptSummary: rawPrompt,
      responseStatus: 'success',
    },
  });

  console.log('已写入一条 llm_call 审计日志（PII 已自动脱敏）');
  console.log(`原始 prompt: ${rawPrompt}`);

  // 通过 sanitizePii 直接看脱敏效果
  const { sanitizePii } = await import('./audit-logger.js');
  console.log(`脱敏后:      ${sanitizePii(rawPrompt)}`);

  // 查询验证
  try {
    const logs = await logger.queryByTenant('tenant-c-financial', { limit: 5 });
    console.log(`租户 C 最近 ${logs.length} 条审计日志已查询到`);
  } catch (err) {
    console.warn(
      '查询失败（可能 audit_logs 表未创建）:',
      (err as Error).message
    );
  }
}

// ==================== Demo 4: Temporal 月度报告 Workflow ====================

async function demoTemporalWorkflow(): Promise<void> {
  console.log('\n========== Demo 4: Temporal 月度报告 Workflow ==========');

  // 动态导入 Temporal Client，避免在不需要时引入连接开销
  const { Connection, Client } = await import('@temporalio/client');
  const { monthlyReportWorkflow } = await import('./workflow.js');

  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection });

  const tenantId = 'tenant-c-financial';
  const yearMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  const workflowId = `monthly-report-${tenantId}-${yearMonth}`;

  console.log(`发起 Workflow: ${workflowId}`);

  const handle = await client.workflow.start(monthlyReportWorkflow, {
    taskQueue: 'agentflow-reports',
    workflowId,
    args: [tenantId],
  });

  console.log(`Workflow 已启动，等待结果...`);

  // 阻塞等待结果（生产场景可以选择不等，让 Workflow 后台跑）
  const result: ReportSummary = await handle.result();
  console.log('Workflow 完成');
  console.log(`  报告时间: ${result.generatedAt}`);
  console.log(`  交易总数: ${result.totalTransactions}`);
  console.log(`  高风险交易: ${result.highRiskCount}`);
  console.log(`  报告摘要: ${result.content.slice(0, 80)}...`);

  await connection.close();
}

// ==================== 主入口 ====================

async function main(): Promise<void> {
  console.log('AgentFlow 第7章演示');
  console.log(`Redis: ${REDIS_URL}`);
  console.log(`Postgres: ${PG_URL}`);
  console.log(`Temporal: ${TEMPORAL_ADDRESS} (${RUN_TEMPORAL_DEMO ? '启用' : '跳过'})`);

  // 三个不依赖 Temporal 的 demo 是相互独立的
  // 任何一个失败不影响其他 demo 继续执行
  await safeRun('Demo 1', demoSessionStore);
  await safeRun('Demo 2', demoContextCompression);
  await safeRun('Demo 3', demoAuditLogger);

  if (RUN_TEMPORAL_DEMO) {
    await safeRun('Demo 4', demoTemporalWorkflow);
  } else {
    console.log('\n[Demo 4] 已跳过（设置 DEMO_TEMPORAL=1 启用）');
    console.log('  启用前请先在另一个终端运行:');
    console.log('    1. docker run -d --name temporal -p 7233:7233 temporalio/auto-setup');
    console.log('    2. npm run worker');
  }

  // 让进程退出（Redis 和 PG 连接池保持长连接，需要显式 exit）
  process.exit(0);
}

async function safeRun(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`\n[${name}] 执行失败:`, (err as Error).message);
  }
}

main().catch((err) => {
  console.error('Demo 执行异常:', err);
  process.exit(1);
});
