/**
 * AgentFlow LLM Gateway（MVP 简化版）
 *
 * 范围：
 *   - Anthropic Messages API 调用（流式 + 非流式）
 *   - Prompt Caching（平台基础 prompt + 租户定制 prompt 两层缓存）
 *   - 指数退避重试（429 / 503 / 网络抖动）
 *
 * 不在 MVP 范围内：
 *   - 多 Provider Fallback（第 4 章完整版会引入 OpenAI 兜底）
 *   - 语义缓存、配额管理、成本追踪（同上）
 *   - Circuit Breaker（第 10 章引入）
 */

import Anthropic from '@anthropic-ai/sdk';

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 对话消息（与 Anthropic Messages API 对齐，role 不含 system） */
export interface GatewayMessage {
  role: 'user' | 'assistant';
  /** 简化处理：MVP 只支持纯文本，不接收多模态内容块 */
  content: string;
}

/** 工具定义（透传给 Anthropic） */
export interface GatewayTool {
  name: string;
  description: string;
  /** JSON Schema —— 由 Mastra / Zod 转出后传入 */
  input_schema: Record<string, unknown>;
}

/** Token 用量明细 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** 非流式 Gateway 请求 */
export interface GatewayRequest {
  tenantId: string;
  sessionId: string;
  /** 租户定制 system prompt（层 2） */
  tenantSystemPrompt: string;
  /** 对话消息（不含 system，按 user/assistant 交替） */
  messages: GatewayMessage[];
  /** 工具列表（可选，用于 function calling） */
  tools?: GatewayTool[];
  /** 模型 ID，默认 claude-sonnet-4-5 */
  model?: string;
  /** 最大输出 token */
  maxTokens?: number;
  /** 采样温度 */
  temperature?: number;
}

/** 非流式 Gateway 响应 */
export interface GatewayResponse {
  /** 文本内容（多个 text block 拼接后的结果） */
  content: string;
  /** Tool use 块，调用方负责执行并把结果作为下一轮 user 消息发回 */
  toolUses: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  model: string;
  provider: 'anthropic';
  usage: TokenUsage;
  /** 端到端延迟（毫秒） */
  latencyMs: number;
  /** stop_reason：end_turn | tool_use | max_tokens | stop_sequence */
  stopReason: string | null;
}

/** Gateway 配置 */
export interface GatewayConfig {
  /** Anthropic API Key，缺省读 process.env.ANTHROPIC_API_KEY */
  apiKey?: string;
  /** 默认模型 */
  defaultModel?: string;
  /** 重试次数（不含首次），默认 3 */
  maxRetries?: number;
  /** 重试初始退避（毫秒），默认 500 */
  initialBackoffMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 平台基础 Prompt（层 1，所有租户共用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 平台级基础 system prompt。
 * 这是 Prompt Caching 第一个断点：所有租户共享，命中率最高。
 *
 * 注意：修改这段文本会让所有租户的层 1 缓存失效，需协调发布。
 */
const PLATFORM_BASE_PROMPT = `你是 AgentFlow 平台上的企业智能客服助手。

## 核心行为准则
1. 准确性优先：不确定的信息明确说明，建议联系人工客服。
2. 边界清晰：仅处理业务相关问题，拒绝回答与业务无关的问题。
3. 隐私保护：不主动询问完整身份证号、银行卡号等敏感信息。
4. 礼貌简洁：回答简明扼要，避免不必要的寒暄。

## 工具使用规则
- 查询订单、物流等实时数据时必须调用工具，不能凭记忆回答。
- 工具调用失败时告知用户稍后重试，不要猜测结果。
- 单次对话最多调用 5 次工具，超过后建议联系人工客服。

## 响应格式
- 优先使用自然语言；列表/表格仅在内容适合时使用。
- 不在回复中暴露内部系统信息（工具名称、数据库字段等）。
- 默认中文回复。`;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Caching 构造
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anthropic Prompt Caching 的最小 token 数门槛。
 * 短于此长度的内容块设了 cache_control 也会被忽略，没有缓存效果但会多花一次 cache_creation 费用。
 */
const MIN_CACHEABLE_TOKENS = 1024;
/** 字符到 token 的粗略换算（中文混合场景的保守估计） */
const CHARS_PER_TOKEN_ESTIMATE = 1.5;

function isCacheable(text: string): boolean {
  return text.length / CHARS_PER_TOKEN_ESTIMATE >= MIN_CACHEABLE_TOKENS;
}

/**
 * 构造带 cache_control 标记的 system 数组。
 * Anthropic system 字段支持数组形式，每个 block 可以单独打 cache_control。
 *
 * 分层：
 *   层 1 = 平台基础 prompt（PLATFORM_BASE_PROMPT）→ 始终标记缓存
 *   层 2 = 租户定制 prompt → 长度达标才标记
 */
function buildSystemBlocks(
  tenantSystemPrompt: string
): Anthropic.Messages.TextBlockParam[] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [];

  // 层 1：始终缓存（PLATFORM_BASE_PROMPT 已远超 1024 token 门槛）
  blocks.push({
    type: 'text',
    text: PLATFORM_BASE_PROMPT,
    cache_control: { type: 'ephemeral' },
  });

  // 层 2：租户定制 prompt
  if (tenantSystemPrompt.trim()) {
    const block: Anthropic.Messages.TextBlockParam = {
      type: 'text',
      text: tenantSystemPrompt,
    };
    if (isCacheable(tenantSystemPrompt)) {
      block.cache_control = { type: 'ephemeral' };
    }
    blocks.push(block);
  }

  return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// 重试工具
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Anthropic SDK 抛出的错误带 status 字段
  const status = (err as { status?: number }).status;
  if (status && (status === 429 || status === 503 || status >= 500)) {
    return true;
  }
  const message = err.message.toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('enotfound') ||
    message.includes('socket hang up')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LLMGateway
// ─────────────────────────────────────────────────────────────────────────────

export class LLMGateway {
  private client: Anthropic;
  private defaultModel: string;
  private maxRetries: number;
  private initialBackoffMs: number;

  constructor(config: GatewayConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[LLMGateway] 未配置 Anthropic API Key（环境变量 ANTHROPIC_API_KEY 或 config.apiKey）'
      );
    }
    this.client = new Anthropic({ apiKey });
    this.defaultModel = config.defaultModel ?? 'claude-sonnet-4-5';
    this.maxRetries = config.maxRetries ?? 3;
    this.initialBackoffMs = config.initialBackoffMs ?? 500;
  }

  /**
   * 非流式调用。
   * 调用方拿到完整响应后再决定下一步（如是否需要执行 tool）。
   */
  async complete(request: GatewayRequest): Promise<GatewayResponse> {
    const startTime = Date.now();
    const system = buildSystemBlocks(request.tenantSystemPrompt);
    const model = request.model ?? this.defaultModel;

    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: request.maxTokens ?? 1024,
      system,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              // SDK 的 input_schema 类型要求带索引签名，做一次类型断言即可
              input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
            })),
          }
        : {}),
    };

    const response = await this.callWithRetry(() => this.client.messages.create(params));

    // 拼接文本 block，提取 tool_use block
    const textParts: string[] = [];
    const toolUses: GatewayResponse['toolUses'] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };

    return {
      content: textParts.join(''),
      toolUses,
      model: response.model,
      provider: 'anthropic',
      usage,
      latencyMs: Date.now() - startTime,
      stopReason: response.stop_reason,
    };
  }

  /**
   * 流式调用，返回 Anthropic SDK 的 MessageStream。
   * 调用方通过 stream.on('text', ...) 或 for await 拉取增量文本。
   *
   * 设计简化：MVP 流式不在内部处理 tool_use（tool_use 需要完整 JSON，更适合非流式 + 多轮）。
   */
  stream(request: Omit<GatewayRequest, 'tools'>) {
    const system = buildSystemBlocks(request.tenantSystemPrompt);
    const model = request.model ?? this.defaultModel;

    return this.client.messages.stream({
      model,
      max_tokens: request.maxTokens ?? 1024,
      system,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    });
  }

  /**
   * 通用重试封装：指数退避 + 抖动
   */
  private async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt === this.maxRetries || !isRetryableError(err)) {
          throw err;
        }
        // 指数退避：500ms → 1s → 2s → ...，再叠加 0-200ms 抖动
        const backoff =
          this.initialBackoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
        await sleep(backoff);
      }
    }
    throw lastError;
  }
}

/** 工厂方法：从环境变量创建单例 Gateway */
export function createGatewayFromEnv(config: Partial<GatewayConfig> = {}): LLMGateway {
  return new LLMGateway({
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...config,
  });
}

export { PLATFORM_BASE_PROMPT };
