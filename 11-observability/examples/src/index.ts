/**
 * 端到端 demo：一次完整的 Agent 调用
 *
 * 这个文件演示「OTel + Langfuse + 评估」三件事如何串在一起：
 *   1. OTel：记录 agent.step / planner / executor / skill.* 等 span
 *   2. Langfuse：记录 trace + generation + 关联 prompt 版本
 *   3. 评估：对 Agent 输出跑 pointwise 评分，分数写回 Langfuse
 *
 * 运行方式：
 *   npm run start
 *
 * 必要的环境变量（缺失时部分功能降级）：
 *   OTEL_EXPORTER_OTLP_ENDPOINT  -> Jaeger / OTel Collector 的 HTTP 端点
 *   LANGFUSE_PUBLIC_KEY          -> Langfuse 项目 public key
 *   LANGFUSE_SECRET_KEY          -> Langfuse 项目 secret key
 *   LANGFUSE_BASE_URL            -> Langfuse 自托管 URL（默认 http://localhost:3000）
 *
 * 注意：otel-init.ts 必须由 tsx 的 --import 参数预先加载，
 * 见 package.json 的 start 脚本。
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';
import { runAgentStep } from './agent-tracer.js';
import {
  chatWithLangfuse,
  scoreGeneration,
  shutdownLangfuse,
} from './langfuse-wrapper.js';
import { evaluateRelevance } from './evaluator.js';

const tracer = trace.getTracer('agentflow-demo', '1.0.0');

interface DemoRequest {
  tenantId: string;
  userId: string;
  sessionId: string;
  userMessage: string;
}

async function handleOneRequest(req: DemoRequest): Promise<void> {
  // 整个请求是一个根 trace
  await tracer.startActiveSpan('request.handle', async (rootSpan) => {
    rootSpan.setAttribute('tenant.id', req.tenantId);
    rootSpan.setAttribute('user.id', req.userId);
    rootSpan.setAttribute('session.id', req.sessionId);

    try {
      // ============ 阶段 1：跑 Agent step（OTel 打点） ============
      const agentResult = await runAgentStep({
        tenantId: req.tenantId,
        sessionId: req.sessionId,
        userId: req.userId,
        stepType: 'planner',
        iteration: 1,
        messages: [
          { role: 'system', content: '你是一个客服 Agent' },
          { role: 'user', content: req.userMessage },
        ],
      });

      // ============ 阶段 2：把对话记录到 Langfuse ============
      let traceId: string | null = null;
      try {
        const chatOut = await chatWithLangfuse({
          tenantId: req.tenantId,
          userId: req.userId,
          sessionId: req.sessionId,
          requestId: rootSpan.spanContext().traceId,
          messages: [{ role: 'user', content: req.userMessage }],
        });
        traceId = chatOut.traceId;
        // eslint-disable-next-line no-console
        console.log(`Langfuse trace: ${traceId}`);

        // ============ 阶段 3：评估 Agent 输出，分数写回 Langfuse ============
        const relScore = await evaluateRelevance(req.userMessage, chatOut.content);
        // eslint-disable-next-line no-console
        console.log(
          `relevance score=${relScore.score} reasoning=${relScore.reasoning}`,
        );
        await scoreGeneration(
          traceId,
          'relevance',
          relScore.score,
          relScore.reasoning,
        );
      } catch (err) {
        // Langfuse 没配 key 等场景下降级，但不影响主流程
        // eslint-disable-next-line no-console
        console.warn(`Langfuse 流程跳过：${(err as Error).message}`);
      }

      rootSpan.setAttribute('agent.total_tokens', agentResult.plan.usage.totalTokens);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      rootSpan.recordException(err as Error);
      rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      throw err;
    } finally {
      rootSpan.end();
    }
  });
}

async function main(): Promise<void> {
  const requests: DemoRequest[] = [
    {
      tenantId: 'tenant-A',
      userId: 'user-001',
      sessionId: 'sess-A-001',
      userMessage: '帮我查一下订单 ORD-123 的状态',
    },
    {
      tenantId: 'tenant-B',
      userId: 'user-077',
      sessionId: 'sess-B-077',
      userMessage: '我想了解一下退款流程',
    },
  ];

  for (const req of requests) {
    // eslint-disable-next-line no-console
    console.log(`\n=== 处理请求 tenant=${req.tenantId} user=${req.userId} ===`);
    try {
      await handleOneRequest(req);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('请求失败', err);
    }
  }

  // 让 BatchSpanProcessor 把 span 发出去
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Langfuse 显式 flush
  try {
    await shutdownLangfuse();
  } catch {
    // 如果没初始化过就跳过
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
