/**
 * Langfuse 集成 wrapper
 *
 * 提供三类能力：
 *   1. trace + generation：把一次 LLM 调用记录到 Langfuse
 *   2. prompt 拉取：从 Langfuse 拉版本化 prompt（带本地缓存）
 *   3. score 写回：把评估结果挂到 generation 上
 *
 * 注意：Langfuse 客户端默认是 batch flush，进程退出前必须 await shutdownAsync()，
 * 否则 batch 队列里的 trace 会被丢弃。
 */

import {
  Langfuse,
  type LangfuseTraceClient,
  type LangfuseGenerationClient,
  type TextPromptClient,
} from 'langfuse';

// ============ 全局单例 ============

let langfuseInstance: Langfuse | null = null;

export function getLangfuse(): Langfuse {
  if (langfuseInstance) return langfuseInstance;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new Error(
      '缺少 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 环境变量。' +
        '请先在 Langfuse UI 里创建 project 并生成 API key。',
    );
  }

  langfuseInstance = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL ?? 'http://localhost:3000',
    flushAt: 15, // 攒够 15 条 event 后 flush
    flushInterval: 10_000, // 或每 10s flush 一次
  });
  return langfuseInstance;
}

/** 进程退出前调用，避免丢数据 */
export async function shutdownLangfuse(): Promise<void> {
  if (langfuseInstance) {
    await langfuseInstance.shutdownAsync();
    langfuseInstance = null;
  }
}

// ============ 类型定义 ============

export interface ChatInput {
  tenantId: string;
  userId: string;
  sessionId: string;
  requestId: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}

export interface ChatOutput {
  content: string;
  traceId: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ============ 模拟 LLM Gateway（真实项目里替换为实际 client） ============

async function llmComplete(req: {
  system: string;
  messages: ChatInput['messages'];
  model: string;
  temperature: number;
}): Promise<{ content: string; usage: LlmUsage }> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const inputTokens =
    req.system.length / 4 + req.messages.reduce((s, m) => s + m.content.length / 4, 0);
  return {
    content: '模拟的 LLM 响应',
    usage: {
      inputTokens: Math.floor(inputTokens),
      outputTokens: 128,
      totalTokens: Math.floor(inputTokens) + 128,
    },
  };
}

// ============ 拉取版本化 prompt（带本地缓存） ============

interface CompiledPrompt {
  /** 编译后的 system prompt 文本 */
  system: string;
  /** Langfuse 里的 prompt 引用，用于关联到 generation */
  ref: TextPromptClient | null;
}

async function loadSystemPrompt(
  tenantId: string,
  currentDate: string,
): Promise<CompiledPrompt> {
  const langfuse = getLangfuse();
  try {
    // type: 'text' 让 TS 收窄返回类型为 TextPromptClient
    const promptRef = await langfuse.getPrompt(
      'customer-service-system',
      undefined,
      { cacheTtlSeconds: 60, label: 'production', type: 'text' },
    );
    const compiled = promptRef.compile({
      tenantName: tenantId,
      currentDate,
    });
    return { system: compiled, ref: promptRef };
  } catch {
    // 本地 demo 时 Langfuse 里可能没有这个 prompt，降级用 fallback
    // 真实项目里这种降级要打告警
    return { system: '你是一个礼貌专业的客服 Agent。', ref: null };
  }
}

// ============ 核心：一次带 Langfuse 埋点的对话 ============

/**
 * 完整流程：
 *   1. 创建 trace（一次对话）
 *   2. 从 Langfuse 拉 production label 的 system prompt
 *   3. 创建 generation 并关联 prompt 版本
 *   4. 调 LLM
 *   5. 结束 generation，写入 usage（Langfuse 据此算成本）
 */
export async function chatWithLangfuse(input: ChatInput): Promise<ChatOutput> {
  const langfuse = getLangfuse();

  // 1. 创建 trace
  const lfTrace: LangfuseTraceClient = langfuse.trace({
    name: 'customer-service-chat',
    userId: input.userId,
    sessionId: input.sessionId,
    metadata: {
      tenantId: input.tenantId,
      requestId: input.requestId,
    },
    tags: ['production', `tenant:${input.tenantId}`],
    input: input.messages,
  });

  // 2. 拉版本化 prompt
  const { system, ref: promptRef } = await loadSystemPrompt(
    input.tenantId,
    new Date().toISOString(),
  );

  // 3. 创建 generation 并关联 prompt 版本
  const generation: LangfuseGenerationClient = lfTrace.generation({
    name: 'main-llm-call',
    model: 'claude-sonnet-4-5',
    modelParameters: { temperature: 0.2, maxTokens: 2048 },
    input: [{ role: 'system', content: system }, ...input.messages],
    // 只在拿到 prompt 引用时才关联
    ...(promptRef ? { prompt: promptRef } : {}),
  });

  try {
    // 4. 调 LLM
    const result = await llmComplete({
      system,
      messages: input.messages,
      model: 'claude-sonnet-4-5',
      temperature: 0.2,
    });

    // 5. 结束 generation —— usage 必须填，Langfuse 据此算成本
    generation.end({
      output: result.content,
      usage: {
        input: result.usage.inputTokens,
        output: result.usage.outputTokens,
        total: result.usage.totalTokens,
        unit: 'TOKENS',
      },
    });

    // trace 顶层也记一份输出
    lfTrace.update({ output: result.content });

    return { content: result.content, traceId: lfTrace.id };
  } catch (err) {
    generation.end({
      level: 'ERROR',
      statusMessage: (err as Error).message,
    });
    lfTrace.update({ output: { error: (err as Error).message } });
    throw err;
  }
}

// ============ 给 generation 写评估分数 ============

/**
 * 评估结果写回 trace，可以在 Langfuse UI 里按 score 排序、筛选。
 *
 * @param traceId 之前对话的 trace id
 * @param scoreName 评分维度名，如 "relevance"、"accuracy"
 * @param value 分数（建议归一化到 0-1 或 1-5）
 * @param comment 可选的评分说明（LLM Judge 的 reasoning）
 */
export async function scoreGeneration(
  traceId: string,
  scoreName: string,
  value: number,
  comment?: string,
): Promise<void> {
  const langfuse = getLangfuse();
  langfuse.score({
    traceId,
    name: scoreName,
    value,
    ...(comment !== undefined ? { comment } : {}),
  });
}

// ============ Demo ============

async function main(): Promise<void> {
  try {
    const out = await chatWithLangfuse({
      tenantId: 'tenant-A',
      userId: 'user-42',
      sessionId: 'sess-001',
      requestId: 'req-' + Date.now(),
      messages: [{ role: 'user', content: '帮我查订单 ORD-123 的状态' }],
    });
    // eslint-disable-next-line no-console
    console.log(`chat 完成 traceId=${out.traceId}`);

    // 给这次对话打一个相关性分数（实际中应该由 evaluator.ts 调用）
    await scoreGeneration(out.traceId, 'relevance', 4, '回复准确覆盖了用户意图');
  } finally {
    // 关键：进程退出前 flush
    await shutdownLangfuse();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
