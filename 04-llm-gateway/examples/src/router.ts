/**
 * LLMRouter：多 Provider 路由与 Fallback
 *
 * 职责：
 * 1. 按优先级依次尝试 Provider
 * 2. 单个 Provider 内用指数退避重试（最多 3 次）
 * 3. 全部失败时返回降级响应，不向上抛出（保证服务可用）
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Redis } from 'ioredis';
import {
  type LLMGatewayRequest,
  type LLMResponse,
  type LLMProvider,
  type ComplexityLevel,
  MODEL_TIERS,
  AllProvidersFailedError,
  isRetryableError,
  sleep,
} from './types.js';

// ─── Circuit Breaker 配置 ─────────────────────────────────────────────────────

/** 触发熔断的连续失败次数阈值 */
const CIRCUIT_BREAK_THRESHOLD = 5;
/** 熔断状态持续时间（秒），超过后自动尝试恢复 */
const CIRCUIT_RESET_TTL = 60;

/**
 * 检查某个 Provider 的 Circuit Breaker 是否处于打开状态
 *
 * 生产注意：这里是简化版本，只检查失败计数。
 * 完整版（见第10章）需要实现 half-open 探测机制：
 * 熔断后不是永远拒绝，而是每隔一段时间放一个请求进去探测是否恢复。
 */
async function isCircuitOpen(
  redis: Redis,
  providerName: string
): Promise<boolean> {
  const key = `circuit:${providerName}:failures`;
  const failures = await redis.get(key);
  return parseInt(failures ?? '0') >= CIRCUIT_BREAK_THRESHOLD;
}

/**
 * 记录 Provider 失败（用于 Circuit Breaker 计数）
 */
async function recordFailure(
  redis: Redis,
  providerName: string
): Promise<void> {
  const key = `circuit:${providerName}:failures`;
  const count = await redis.incr(key);
  // 首次写入时设置 TTL，确保计数会自动清零
  if (count === 1) {
    await redis.expire(key, CIRCUIT_RESET_TTL);
  }
}

/**
 * 记录 Provider 成功（重置失败计数）
 */
async function recordSuccess(
  redis: Redis,
  providerName: string
): Promise<void> {
  await redis.del(`circuit:${providerName}:failures`);
}

// ─── Anthropic Provider ───────────────────────────────────────────────────────

/**
 * 推断请求复杂度，用于选择模型层级
 * 优先使用调用方显式指定，否则根据消息长度和工具数量启发式判断
 */
function inferComplexity(request: LLMGatewayRequest): ComplexityLevel {
  if (request.complexity) return request.complexity;

  // 计算消息总字符数
  const totalLength = request.messages.reduce((sum, m) => {
    const text = typeof m.content === 'string'
      ? m.content
      : m.content.map(b => b.text).join('');
    return sum + text.length;
  }, 0);

  const toolCount = request.tools?.length ?? 0;

  if (totalLength > 8000 || toolCount > 5) return 'complex';
  if (totalLength > 2000 || toolCount > 0) return 'moderate';
  return 'simple';
}

/**
 * Anthropic Claude Provider
 */
class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: LLMGatewayRequest): Promise<LLMResponse> {
    const complexity = inferComplexity(request);
    const model = MODEL_TIERS[complexity];

    // 构造 Anthropic 消息格式
    // 注意：system 角色在 Anthropic API 中独立传递，不在 messages 数组里
    const systemMessage = request.messages.find(m => m.role === 'system');
    const conversationMessages = request.messages.filter(m => m.role !== 'system');

    // 将 Message[] 转换为 Anthropic SDK 所需的格式
    const anthropicMessages = conversationMessages.map(msg => {
      if (typeof msg.content === 'string') {
        return { role: msg.role as 'user' | 'assistant', content: msg.content };
      }
      // 多内容块格式（含 cache_control）
      return {
        role: msg.role as 'user' | 'assistant',
        content: msg.content.map(block => ({
          type: 'text' as const,
          text: block.text,
          ...(block.cache_control ? { cache_control: block.cache_control } : {}),
        })),
      };
    });

    // 构造 system 参数：若 content 是多块且含 cache_control，用 SystemPrompt[] 格式保留标记
    // 若 content 是纯字符串，直接传字符串（Anthropic SDK 两种格式都支持）
    let systemParam: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> | undefined;
    if (systemMessage) {
      if (typeof systemMessage.content === 'string') {
        systemParam = systemMessage.content;
      } else {
        // 多内容块：保留 cache_control 标记（用于 system prompt caching）
        systemParam = systemMessage.content.map(block => ({
          type: 'text' as const,
          text: block.text,
          ...(block.cache_control ? { cache_control: block.cache_control } : {}),
        }));
      }
    }

    const response = await this.client.messages.create({
      model,
      max_tokens: 4096,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      system: systemParam as any,
      messages: anthropicMessages,
      // 传递工具定义（如果有）
      // 使用 as any 绕过 SDK 的严格 InputSchema 类型检查（我们的 ToolParameterSchema 已兼容）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: request.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as any,
      })),
    });

    // 提取文本内容（忽略 tool_use 块，这里只处理文本响应）
    const textContent = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('');

    return {
      content: textContent,
      model: response.model,
      provider: this.name,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        // Prompt Caching 专属字段：Anthropic SDK 在 Usage 类型上的扩展
        // 通过 unknown 中转绕过 SDK 严格类型，这些字段在 API 文档中已明确
        cacheCreationTokens: (response.usage as unknown as Record<string, number>)
          ['cache_creation_input_tokens'],
        cacheReadTokens: (response.usage as unknown as Record<string, number>)
          ['cache_read_input_tokens'],
      },
    };
  }
}

// ─── OpenAI Provider ──────────────────────────────────────────────────────────

/**
 * OpenAI Provider（作为 Anthropic 的 Fallback）
 * 使用 gpt-4o-mini：在 Fallback 场景下，可用性比性能更重要
 */
class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(request: LLMGatewayRequest): Promise<LLMResponse> {
    // Fallback 场景统一用 gpt-4o-mini，不按复杂度分层
    // 原因：fallback 时首要目标是保证服务可用，而非最优性能
    const model = 'gpt-4o-mini';

    // 将内部 Message 格式转换为 OpenAI 格式
    // OpenAI 不支持 content block 数组中的 cache_control，直接拼接文本
    const openaiMessages = request.messages.map(msg => ({
      role: msg.role as 'system' | 'user' | 'assistant',
      content: typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(b => b.text).join('\n'),
    }));

    const response = await this.client.chat.completions.create({
      model,
      messages: openaiMessages,
      max_tokens: 4096,
    });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error('OpenAI returned empty response');
    }

    return {
      content: choice.message.content,
      model: response.model,
      provider: this.name,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        // OpenAI 没有 Anthropic 风格的 Prompt Caching，置为 0
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };
  }
}

// ─── LLMRouter ────────────────────────────────────────────────────────────────

/** 重试配置 */
const MAX_RETRY_ATTEMPTS = 3;
/** 基础重试间隔（毫秒），实际间隔 = base * 2^attempt + jitter */
const BASE_RETRY_DELAY_MS = 1000;

/**
 * 多 Provider 路由器
 *
 * 使用方式：
 * ```ts
 * const router = new LLMRouter(redis, {
 *   anthropicApiKey: process.env.ANTHROPIC_API_KEY,
 *   openaiApiKey: process.env.OPENAI_API_KEY,
 * });
 * const response = await router.complete(request);
 * ```
 */
export class LLMRouter {
  private providers: LLMProvider[];

  constructor(
    private redis: Redis,
    config: {
      anthropicApiKey?: string;
      openaiApiKey?: string;
    }
  ) {
    // 按优先级排列：Anthropic 在前，OpenAI 在后
    this.providers = [];

    if (config.anthropicApiKey) {
      this.providers.push(new AnthropicProvider(config.anthropicApiKey));
    }
    if (config.openaiApiKey) {
      this.providers.push(new OpenAIProvider(config.openaiApiKey));
    }

    if (this.providers.length === 0) {
      throw new Error('At least one API key (ANTHROPIC or OPENAI) must be provided');
    }
  }

  /**
   * 发起 LLM 调用，依次尝试所有 Provider，直到成功或全部失败
   */
  async complete(request: LLMGatewayRequest): Promise<LLMResponse> {
    let lastError: Error | null = null;

    for (const provider of this.providers) {
      // 检查 Circuit Breaker：如果 Provider 处于熔断状态，直接跳过
      const circuitOpen = await isCircuitOpen(this.redis, provider.name);
      if (circuitOpen) {
        console.warn(`[LLMRouter] Circuit open for ${provider.name}, skipping`, {
          tenantId: request.tenantId,
          sessionId: request.sessionId,
        });
        continue;
      }

      try {
        const response = await this.tryProvider(provider, request, 0);
        // 成功：重置 Circuit Breaker 计数
        await recordSuccess(this.redis, provider.name);
        return response;
      } catch (err) {
        lastError = err as Error;
        // 失败：累计计数（可能触发熔断）
        await recordFailure(this.redis, provider.name);
        console.warn(`[LLMRouter] Provider ${provider.name} failed, trying next`, {
          error: (err as Error).message,
          tenantId: request.tenantId,
          sessionId: request.sessionId,
        });
      }
    }

    // 所有 Provider 均失败
    throw new AllProvidersFailedError(lastError ?? new Error('No providers available'));
  }

  /**
   * 单个 Provider 的带重试调用
   * @param attempt 当前重试次数（从 0 开始）
   */
  private async tryProvider(
    provider: LLMProvider,
    request: LLMGatewayRequest,
    attempt: number
  ): Promise<LLMResponse> {
    try {
      return await provider.complete(request);
    } catch (err) {
      // 已达最大重试次数，向上抛出，触发 Provider 切换
      if (attempt >= MAX_RETRY_ATTEMPTS - 1) {
        throw err;
      }

      // 非可重试错误（如认证失败、请求格式错误）直接抛出，不重试
      if (!isRetryableError(err)) {
        throw err;
      }

      // 指数退避 + ±20% 随机抖动，避免惊群效应
      const baseDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
      const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
      const delay = Math.max(0, baseDelay + jitter);

      console.warn(
        `[LLMRouter] ${provider.name} attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`,
        { error: (err as Error).message }
      );

      await sleep(delay);
      return this.tryProvider(provider, request, attempt + 1);
    }
  }
}
