/**
 * POST /api/v1/chat — 流式 SSE 聊天接口
 *
 * 处理顺序：
 *   1. 验证 JWT，提取 tenantId / userId
 *   2. 拿到 sessionId（请求带就复用，没有就新建）
 *   3. 从 Redis 取 SessionState；首次创建并初始化
 *   4. Agent Loop（最多 5 轮）：
 *      - 调 LLM Gateway（非流式 + tools）
 *      - 若返回 tool_use → 本地执行 tool → 把工具结果作为下一轮 user 消息
 *      - 若返回纯文本 → 进入第 5 步
 *   5. 把最终文本按 SSE chunk 推给前端（模拟流式打字效果）
 *   6. 保存会话到 Redis，异步写审计日志到 Postgres
 *
 * 设计简化：
 *   - MVP 不在 tool_use 阶段做真实流式（流式 tool_use 需要重组 partial JSON，复杂度高）；
 *     第 4 章完整版会引入"流式 + tool_use"的合成方案。
 *   - SSE 事件格式参考 Anthropic Messages stream 的事件类型。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  LLMGateway,
  type GatewayMessage,
  type GatewayTool,
} from '@agentflow/llm-gateway';
import {
  RedisSessionStore,
  AuditLogger,
  type ConversationMessage,
} from '@agentflow/session';
import { queryOrderTool } from '@agentflow/agent-engine';

// ─── 请求 schema ──────────────────────────────────────────────────────────────

const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  /** 续接已有会话；为空时服务器新建一个 */
  sessionId: z.string().optional(),
});

// ─── SSE 工具函数 ─────────────────────────────────────────────────────────────

type SSEEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'tool_use'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolName: string; result: unknown }
  | { type: 'text'; delta: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } }
  | { type: 'error'; message: string }
  | { type: 'done' };

function writeSSE(reply: FastifyReply, event: SSEEvent): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 把一段文本切成小 chunk，逐个写到 SSE，模拟打字机效果 */
async function streamTextChunks(
  reply: FastifyReply,
  text: string,
  chunkSize = 20,
  delayMs = 15
): Promise<void> {
  for (let i = 0; i < text.length; i += chunkSize) {
    const delta = text.slice(i, i + chunkSize);
    writeSSE(reply, { type: 'text', delta });
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ─── 工具调度 ─────────────────────────────────────────────────────────────────

/**
 * MVP 工具表：name → JSON Schema 定义 + 执行函数。
 * 与 Mastra Agent 配置共用 queryOrderTool 的 zod schema，
 * 但这里需要导出给 LLM Gateway 用的 input_schema（JSON Schema）。
 */
interface ToolEntry {
  definition: GatewayTool;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

/**
 * 把 zod schema 手动转换为 JSON Schema。
 * 工具只有 queryOrder 一个，硬编码即可；
 * 第 5 章会引入 zod-to-json-schema 做自动转换。
 */
const TOOLS: Record<string, ToolEntry> = {
  queryOrder: {
    definition: {
      name: 'queryOrder',
      description:
        '根据订单号查询订单状态、金额、商品列表和收货地址。用户询问订单进度、何时发货、订单详情时调用此工具。',
      input_schema: {
        type: 'object',
        properties: {
          orderId: {
            type: 'string',
            description: '订单号，5-12 位数字，例如：12345',
          },
        },
        required: ['orderId'],
      },
    },
    execute: async (input) => {
      // 复用 Mastra tool 的 execute；context 在 Mastra 0.10 中是 zod 校验后的输入对象
      const parsed = z
        .object({ orderId: z.string() })
        .safeParse(input);
      if (!parsed.success) {
        return { found: false, error: '工具参数不合法' };
      }
      // queryOrderTool.execute 接收 Mastra 内部 context；MVP 直接调内部 Mock 逻辑
      // 为了避免依赖 Mastra runtime，直接用 zod 解析后的对象走我们自己的 mock
      return queryOrderTool.execute!({
        context: parsed.data,
        // 下面这些字段在 mock execute 里不会用到，传 undefined 安全
        runtimeContext: {} as never,
        mastra: undefined as never,
        runId: 'mvp-run',
        threadId: undefined,
        resourceId: undefined,
      } as never);
    },
  },
};

// ─── 路由依赖 ─────────────────────────────────────────────────────────────────

export interface ChatRouteDeps {
  gateway: LLMGateway;
  sessionStore: RedisSessionStore;
  auditLogger: AuditLogger;
  tenantSystemPrompt: string;
  /** 演示用：把所有请求都归到这个 tenantId（生产环境从 JWT 取） */
  defaultTenantId: string;
  defaultTenantSlug: string;
}

// ─── 路由注册 ─────────────────────────────────────────────────────────────────

export async function chatRoutes(
  app: FastifyInstance,
  deps: ChatRouteDeps
): Promise<void> {
  app.post('/api/v1/chat', async (request, reply) => {
    // ── 1. 校验请求 ──────────────────────────────────────────────────────────
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    // ── 2. 解析 JWT（无 JWT 时退化到 demo 租户，便于本地 curl） ───────────────
    const auth = request.auth;
    const tenantId = auth?.tenantId ?? deps.defaultTenantId;
    const userId = auth?.sub ?? 'demo-user';

    // ── 3. 建立 SSE 响应头 ───────────────────────────────────────────────────
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sessionId = parsed.data.sessionId ?? `session_${ulid()}`;
    writeSSE(reply, { type: 'session', sessionId });

    try {
      await runChat({
        deps,
        reply,
        request,
        sessionId,
        tenantId,
        userId,
        userMessage: parsed.data.message,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      app.log.error({ err }, '[chat] 请求处理失败');
      writeSSE(reply, { type: 'error', message: '服务器内部错误，请稍后重试' });
      // 仅在 debug 模式下回传原始 message
      if (process.env.LOG_LEVEL === 'debug') {
        writeSSE(reply, { type: 'error', message });
      }
    } finally {
      writeSSE(reply, { type: 'done' });
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
  });
}

// ─── Chat 核心逻辑 ────────────────────────────────────────────────────────────

interface RunChatParams {
  deps: ChatRouteDeps;
  reply: FastifyReply;
  request: FastifyRequest;
  sessionId: string;
  tenantId: string;
  userId: string;
  userMessage: string;
}

async function runChat(params: RunChatParams): Promise<void> {
  const { deps, reply, sessionId, tenantId, userId, userMessage } = params;

  // 1. 取/建会话
  let state =
    (await deps.sessionStore.get(sessionId)) ??
    (await deps.sessionStore.create({ sessionId, tenantId, userId }));

  // 2. 追加用户消息
  const userMsg: ConversationMessage = {
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
  };
  state.messages.push(userMsg);

  // 3. 构造给 Gateway 的消息历史（截尾 + 转换）
  // 注意：state.messages 已经只有 user/assistant，与 Gateway 接口一致
  const history: GatewayMessage[] = state.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // 4. Tool-use 循环（最多 5 轮，避免无限循环）
  const MAX_ITERATIONS = 5;
  const tools = Object.values(TOOLS).map((t) => t.definition);
  const startTime = Date.now();

  let finalText = '';
  let totalUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  let lastModel = 'unknown';
  let lastProvider: 'anthropic' = 'anthropic';

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const resp = await deps.gateway.complete({
      tenantId,
      sessionId,
      tenantSystemPrompt: deps.tenantSystemPrompt,
      messages: history,
      tools,
    });

    // 累加 token 用量
    totalUsage.inputTokens += resp.usage.inputTokens;
    totalUsage.outputTokens += resp.usage.outputTokens;
    totalUsage.cacheCreationTokens += resp.usage.cacheCreationTokens;
    totalUsage.cacheReadTokens += resp.usage.cacheReadTokens;
    lastModel = resp.model;
    lastProvider = resp.provider;

    if (resp.toolUses.length === 0) {
      // 模型给出最终文本回复，跳出循环
      finalText = resp.content;
      break;
    }

    // 否则：执行所有 tool_use，再把结果作为 user 消息塞回历史
    // 把 assistant 这一轮（带 tool_use）也加进历史，Anthropic 协议要求 tool_result 必须紧跟在带 tool_use 的 assistant 消息后
    // 在 Messages API 里需要传结构化 content；MVP 用简化做法：assistant 文本 + 文本化的 tool 结果
    // 这种简化版本损失了一些精度（LLM 看到的不是结构化 tool_use block），
    // 但对单一工具 + 简单查询场景已经够用。
    history.push({
      role: 'assistant',
      content:
        (resp.content || '') +
        '\n\n[正在调用工具：' +
        resp.toolUses.map((t) => t.name).join(', ') +
        ']',
    });

    const toolResultsText: string[] = [];
    for (const toolUse of resp.toolUses) {
      writeSSE(reply, {
        type: 'tool_use',
        toolName: toolUse.name,
        input: toolUse.input,
      });

      const entry = TOOLS[toolUse.name];
      let result: unknown;
      if (!entry) {
        result = { error: `未知工具：${toolUse.name}` };
      } else {
        try {
          result = await entry.execute(toolUse.input);
        } catch (err) {
          result = { error: (err as Error).message };
        }
      }

      writeSSE(reply, {
        type: 'tool_result',
        toolName: toolUse.name,
        result,
      });

      toolResultsText.push(
        `工具 ${toolUse.name} 的执行结果：\n${JSON.stringify(result, null, 2)}`
      );
    }

    history.push({
      role: 'user',
      content: toolResultsText.join('\n\n') + '\n\n请基于以上结果继续回答。',
    });
  }

  // 如果耗尽 MAX_ITERATIONS 仍未拿到最终文本
  if (!finalText) {
    finalText = '抱歉，处理时间过长，请稍后重试或联系人工客服。';
  }

  // 5. 把最终文本推送为伪流式 chunk
  await streamTextChunks(reply, finalText);

  // 6. 把 assistant 最终回复追加到会话
  state.messages.push({
    role: 'assistant',
    content: finalText,
    timestamp: Date.now(),
  });
  await deps.sessionStore.save(state);

  // 7. 推送 usage 摘要
  writeSSE(reply, {
    type: 'usage',
    usage: {
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      cacheReadTokens: totalUsage.cacheReadTokens,
    },
  });

  // 8. 异步写审计日志，不阻塞响应结束
  void deps.auditLogger.record({
    tenantId,
    sessionId: undefined, // MVP 不把 sessionId 写入 sessions 表，所以这里留空
    provider: lastProvider,
    model: lastModel,
    requestBody: {
      tenantSystemPrompt: deps.tenantSystemPrompt,
      userMessage,
    },
    responseBody: { text: finalText },
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    cacheCreationTokens: totalUsage.cacheCreationTokens,
    cacheReadTokens: totalUsage.cacheReadTokens,
    latencyMs: Date.now() - startTime,
    success: true,
  });
}
