/**
 * Fastify + SSE 流式响应端点
 * 实现 LLM 流式输出，让用户看到打字机效果
 */

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { streamText, generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { RuntimeContext } from '@mastra/core/runtime-context';
import { mastra, buildThreadId } from './agent.js';
import { queryOrderTool, queryShippingTool, initiateRefundTool } from './tools.js';

// ===== 类型定义 =====

// 请求体 schema（用 Zod 校验）
const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  sessionId: z.string(),
  tenantId: z.string(),
  userId: z.string(),
});

type ChatRequest = z.infer<typeof chatRequestSchema>;

// SSE 事件类型
type SSEEventType = 'text' | 'tool-call' | 'tool-result' | 'usage' | 'error' | 'done';

interface SSEEvent {
  type: SSEEventType;
  content?: string;    // type=text 时的文本增量
  toolName?: string;   // type=tool-call 时的工具名
  result?: unknown;    // type=tool-result 时的工具结果
  usage?: {            // type=usage 时的 token 用量
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  message?: string;    // type=error 时的错误信息
}

// ===== SSE 工具函数 =====

/**
 * 向 SSE 连接写入一个事件
 * SSE 协议格式：data: <json>\n\n
 */
function writeSSEEvent(reply: FastifyReply, event: SSEEvent): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ===== Fastify 实例 =====

export function createServer() {
  const fastify = Fastify({
    logger: {
      level: 'info',
    },
  });

  // ===== 路由：流式聊天 =====

  /**
   * POST /api/chat
   * 接收用户消息，以 SSE 流式返回 agent 回复
   *
   * 客户端使用方式：
   * const eventSource = new EventSource('/api/chat');
   * 或者用 fetch + ReadableStream（支持 POST body）
   */
  fastify.post(
    '/api/chat',
    async (
      request: FastifyRequest<{ Body: ChatRequest }>,
      reply: FastifyReply
    ) => {
      // 校验请求体
      const parseResult = chatRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: '请求参数错误',
          details: parseResult.error.flatten(),
        });
      }

      const { message, sessionId, tenantId, userId } = parseResult.data;

      // 设置 SSE 响应头
      // 注意：一旦调用 writeHead，Fastify 的错误处理中间件就不再生效
      // 后续所有错误都必须手动处理，通过 SSE 事件告知客户端
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // 禁用 Nginx 缓冲，确保实时推送
      });

      const threadId = buildThreadId({ tenantId, userId, sessionId });

      // 累计 token 用量（多步工具调用时，每步都有 usage）
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      try {
        // 获取 agent 实例
        const agent = mastra.getAgent('ecommerceAgent');

        // 获取对话历史
        // 生产环境：从 Mastra Memory 读取
        // 这里用空历史模拟
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

        // 使用 Vercel AI SDK 的 streamText 实现流式输出
        // 这里直接用 AI SDK，展示底层机制
        // 实际项目中可以用 agent.stream() 替代，Mastra 会处理工具转换
        const result = streamText({
          model: anthropic('claude-sonnet-4-5'),
          system: agent.instructions ?? '',
          messages: [
            ...history,
            { role: 'user', content: message },
          ],

          // 把 Mastra 工具适配为 AI SDK 的 tool 格式
          tools: {
            queryOrder: {
              description: queryOrderTool.description ?? '',
              parameters: queryOrderTool.inputSchema,
              // execute 在 createTool 时一定传入，用非空断言消除 TS 的可选检查
              execute: async (args: { orderId: string }) => {
                const ctx = {
                  context: args,
                  threadId,
                  resourceId: userId,
                  mastra,
                  runId: `run-${Date.now()}`,
                  runtimeContext: new RuntimeContext(),
                };
                return queryOrderTool.execute!(ctx as Parameters<NonNullable<typeof queryOrderTool.execute>>[0]);
              },
            },
            queryShipping: {
              description: queryShippingTool.description ?? '',
              parameters: queryShippingTool.inputSchema,
              execute: async (args: { trackingNumber: string; carrier: string }) => {
                const ctx = {
                  context: args,
                  threadId,
                  resourceId: userId,
                  mastra,
                  runId: `run-${Date.now()}`,
                  runtimeContext: new RuntimeContext(),
                };
                return queryShippingTool.execute!(ctx as Parameters<NonNullable<typeof queryShippingTool.execute>>[0]);
              },
            },
            initiateRefund: {
              description: initiateRefundTool.description ?? '',
              parameters: initiateRefundTool.inputSchema,
              execute: async (args: { orderId: string; reason: string; amount: number }) => {
                const ctx = {
                  context: args,
                  threadId,
                  resourceId: userId,
                  mastra,
                  runId: `run-${Date.now()}`,
                  runtimeContext: new RuntimeContext(),
                };
                return initiateRefundTool.execute!(ctx as Parameters<NonNullable<typeof initiateRefundTool.execute>>[0]);
              },
            },
          },

          // 每次工具调用或文本 chunk 时触发
          onChunk: ({ chunk }) => {
            if (chunk.type === 'text-delta') {
              // 文本 chunk：推送给前端追加显示
              writeSSEEvent(reply, {
                type: 'text',
                content: chunk.textDelta,
              });
            } else if (chunk.type === 'tool-call') {
              // 工具调用开始：通知前端显示"正在查询..."
              writeSSEEvent(reply, {
                type: 'tool-call',
                toolName: chunk.toolName,
              });
            } else if (chunk.type === 'tool-result') {
              // 工具返回结果：可选地推送给前端（部分场景需要展示中间结果）
              writeSSEEvent(reply, {
                type: 'tool-result',
                toolName: chunk.toolName,
                result: chunk.result,
              });
            }
          },

          // 每一步（包括工具调用的中间步骤）完成时触发
          // 用于累加 token 用量，得到完整计费数据
          onStepFinish: ({ usage }) => {
            totalInputTokens += usage.promptTokens;
            totalOutputTokens += usage.completionTokens;
          },

          // 全部流式输出完成时触发
          onFinish: () => {
            // 推送完整的 token 用量
            // 注意：这里用累加的 totalInputTokens，而不是 usage.promptTokens
            // 原因：onFinish 的 usage 只包含最后一步，累加值才是全部调用的真实消耗
            writeSSEEvent(reply, {
              type: 'usage',
              usage: {
                promptTokens: totalInputTokens,
                completionTokens: totalOutputTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
              },
            });

            // 结束标记，客户端收到后关闭连接
            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();

            // 异步写入计费记录（不阻塞响应）
            // 生产环境：发到 BullMQ 队列
            // void billingQueue.add({ tenantId, userId, tokens: totalInputTokens + totalOutputTokens });
          },
        });

        // 等待流完成（onFinish 里已经处理了 end）
        await result.text;
      } catch (err) {
        // 异常：推送错误事件并关闭连接
        // 注意：如果 writeHead 已经调用，不能再 reply.status(500)
        const errorMessage = err instanceof Error ? err.message : '服务器内部错误';
        console.error('Stream error:', err);

        writeSSEEvent(reply, {
          type: 'error',
          message: '服务器内部错误，请稍后重试',
        });
        reply.raw.end();
      }
    }
  );

  // ===== 路由：非流式聊天（用于测试和后台任务） =====

  fastify.post(
    '/api/chat/sync',
    async (
      request: FastifyRequest<{ Body: ChatRequest }>,
      reply: FastifyReply
    ) => {
      const parseResult = chatRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: '请求参数错误' });
      }

      const { message, userId } = parseResult.data;
      const agent = mastra.getAgent('ecommerceAgent');

      try {
        const result = await generateText({
          model: anthropic('claude-sonnet-4-5'),
          system: agent.instructions ?? '',
          messages: [{ role: 'user', content: message }],
        });

        return reply.send({
          text: result.text,
          usage: result.usage,
          userId,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : '未知错误';
        return reply.status(500).send({ error: errorMessage });
      }
    }
  );

  // ===== 路由：健康检查 =====

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  return fastify;
}
