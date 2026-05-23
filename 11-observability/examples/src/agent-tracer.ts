/**
 * Agent 关键路径的手动埋点
 *
 * 用 OTel 的 GenAI semantic conventions（半官方标准）打 attribute，
 * 让下游的 Jaeger / Tempo / Langfuse 都能识别。
 *
 * 关键 attribute 列表：
 *   gen_ai.system                     -> "anthropic" | "openai" | ...
 *   gen_ai.request.model              -> "claude-sonnet-4-5"
 *   gen_ai.request.temperature        -> number
 *   gen_ai.usage.input_tokens         -> number
 *   gen_ai.usage.output_tokens        -> number
 *   gen_ai.usage.cache_read_input_tokens -> number
 *   gen_ai.response.id                -> string
 *   gen_ai.response.finish_reasons    -> string[]
 */

import { trace, SpanStatusCode, SpanKind, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('agent-engine', '1.0.0');

// ============ 类型定义 ============

export interface AgentInput {
  tenantId: string;
  sessionId: string;
  userId: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  stepType: 'planner' | 'executor' | 'reflector';
  iteration: number;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  totalTokens: number;
}

export interface LlmResult {
  id: string;
  content: string;
  toolCalls: ToolCall[];
  usage: LlmUsage;
  finishReason: string;
}

export interface AgentOutput {
  plan: LlmResult;
  skillResults: unknown[];
}

// ============ 模拟下游：真实项目里这两个会接 LLM Gateway 和 Skill Registry ============

async function llmGatewayComplete(req: {
  model: string;
  messages: AgentInput['messages'];
  tenantId: string;
  temperature?: number;
}): Promise<LlmResult> {
  // 模拟 200-800ms 的网络延迟
  await sleep(200 + Math.random() * 600);
  const inputTokens = req.messages.reduce((sum, m) => sum + m.content.length / 4, 0);
  return {
    id: `resp_${Date.now()}`,
    content: '模拟的 LLM 响应内容',
    toolCalls: [
      { name: 'order.lookup', args: { orderId: 'ORD-123' } },
      { name: 'kb.search', args: { query: '退款政策' } },
    ],
    usage: {
      inputTokens: Math.floor(inputTokens),
      outputTokens: 128,
      cacheReadTokens: Math.floor(inputTokens * 0.6),
      totalTokens: Math.floor(inputTokens) + 128,
    },
    finishReason: 'stop',
  };
}

async function skillInvoke(name: string, args: Record<string, unknown>): Promise<unknown> {
  await sleep(50 + Math.random() * 200);
  return { skill: name, result: 'ok', argsEcho: args };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============ 核心：一次 Agent step 的埋点 ============

export async function runAgentStep(input: AgentInput): Promise<AgentOutput> {
  return tracer.startActiveSpan(
    'agent.step',
    { kind: SpanKind.INTERNAL },
    async (span) => {
      // 业务标签 —— 全部用低基数维度（tenantId 通常 < 1万，sessionId 用 userId 更高基的话拆开）
      span.setAttribute('tenant.id', input.tenantId);
      span.setAttribute('session.id', input.sessionId);
      span.setAttribute('user.id', input.userId);
      span.setAttribute('agent.step.type', input.stepType);
      span.setAttribute('agent.step.iteration', input.iteration);

      try {
        const plan = await runPlanner(input);
        const skillResults = await runExecutor(input, plan.toolCalls);

        // 把整步骤的关键指标抬到父 span 上，方便 Jaeger 列表页直接看
        span.setAttribute('agent.step.total_tokens', plan.usage.totalTokens);
        span.setAttribute('agent.step.skill_count', plan.toolCalls.length);

        span.setStatus({ code: SpanStatusCode.OK });
        return { plan, skillResults };
      } catch (err) {
        // 异常路径必须显式记录，OTel 不会自动捕获 throw
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
}

// ============ Planner：单次 LLM 调用 ============

async function runPlanner(input: AgentInput): Promise<LlmResult> {
  return tracer.startActiveSpan('agent.planner', async (span) => {
    // GenAI semantic conventions
    span.setAttribute('gen_ai.system', 'anthropic');
    span.setAttribute('gen_ai.request.model', 'claude-sonnet-4-5');
    span.setAttribute('gen_ai.request.temperature', 0.2);
    span.setAttribute('gen_ai.operation.name', 'chat');

    try {
      const result = await llmGatewayComplete({
        model: 'claude-sonnet-4-5',
        messages: input.messages,
        tenantId: input.tenantId,
        temperature: 0.2,
      });

      // Usage 字段按 GenAI semconv 命名
      span.setAttribute('gen_ai.usage.input_tokens', result.usage.inputTokens);
      span.setAttribute('gen_ai.usage.output_tokens', result.usage.outputTokens);
      span.setAttribute(
        'gen_ai.usage.cache_read_input_tokens',
        result.usage.cacheReadTokens ?? 0,
      );
      span.setAttribute('gen_ai.response.id', result.id);
      span.setAttribute('gen_ai.response.finish_reasons', [result.finishReason]);

      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ============ Executor：并行调用多个 Skill ============

async function runExecutor(input: AgentInput, toolCalls: ToolCall[]): Promise<unknown[]> {
  return tracer.startActiveSpan('agent.executor', async (span) => {
    span.setAttribute('agent.executor.skill_count', toolCalls.length);
    span.setAttribute('tenant.id', input.tenantId);

    try {
      const results = await Promise.all(
        toolCalls.map((call) => invokeSkillTraced(call)),
      );
      span.setStatus({ code: SpanStatusCode.OK });
      return results;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

async function invokeSkillTraced(call: ToolCall): Promise<unknown> {
  return tracer.startActiveSpan(`skill.${call.name}`, async (span: Span) => {
    span.setAttribute('skill.name', call.name);
    span.setAttribute('skill.input.size_bytes', JSON.stringify(call.args).length);
    try {
      const result = await skillInvoke(call.name, call.args);
      span.setAttribute('skill.output.size_bytes', JSON.stringify(result).length);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ============ 直接运行此文件时：跑一次 demo ============

async function main(): Promise<void> {
  const result = await runAgentStep({
    tenantId: 'tenant-A',
    sessionId: 'sess-001',
    userId: 'user-42',
    stepType: 'planner',
    iteration: 1,
    messages: [
      { role: 'system', content: '你是一个客服 Agent' },
      { role: 'user', content: '帮我查一下订单 ORD-123 的状态' },
    ],
  });
  // eslint-disable-next-line no-console
  console.log('agent step 完成', JSON.stringify(result, null, 2));
  // 给 BatchSpanProcessor 一点时间 flush
  await sleep(2000);
}

// ESM 下判断「直接运行此文件」的写法
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
