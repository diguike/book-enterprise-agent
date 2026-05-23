/**
 * LLM Gateway 核心类型定义
 *
 * 所有内部组件都依赖这里的类型，不直接依赖各 SDK 的原始类型。
 * 这样替换 SDK 版本时，改动范围仅限 provider 实现文件。
 */

// ─── 消息格式 ────────────────────────────────────────────────────────────────

/** 单个文本内容块（支持 Anthropic cache_control 扩展） */
export interface TextContentBlock {
  type: 'text';
  text: string;
  /** Anthropic Prompt Caching 标记，设置后该内容块会作为缓存断点 */
  cache_control?: { type: 'ephemeral' };
}

/** 消息内容：简单字符串或多内容块数组 */
export type MessageContent = string | TextContentBlock[];

/** 对话消息 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: MessageContent;
}

// ─── 工具定义 ─────────────────────────────────────────────────────────────────

/** 工具参数的 JSON Schema 描述（兼容 Anthropic InputSchema 的索引签名要求） */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  /** 允许额外的字符串索引（满足 Anthropic SDK 的 InputSchema 类型约束） */
  [key: string]: unknown;
}

/** 工具定义（Agent 传给 LLM 的工具列表） */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolParameterSchema;
}

// ─── Gateway 请求 / 响应 ──────────────────────────────────────────────────────

/**
 * 任务复杂度，影响模型选择：
 * - simple:   分类、提取、简单判断（Haiku 级别）
 * - moderate: 多步推理、工具调用（Sonnet 级别）
 * - complex:  复杂分析、长文档处理（Opus 级别）
 */
export type ComplexityLevel = 'simple' | 'moderate' | 'complex';

/** Gateway 入口请求结构，所有 Agent 通过此接口调用 LLM */
export interface LLMGatewayRequest {
  /** 租户 ID，用于配额检查和成本归因 */
  tenantId: string;
  /** 会话 ID，用于日志关联 */
  sessionId: string;
  /** 对话消息列表 */
  messages: Message[];
  /** 工具列表（可选） */
  tools?: ToolDefinition[];
  /** 任务复杂度，不传则由 Gateway 启发式推断 */
  complexity?: ComplexityLevel;
  /** 是否流式返回（本章暂不实现流式，仅做标记） */
  stream?: boolean;
  /**
   * 是否需要实时数据（影响语义缓存策略）
   * 查订单、查库存等需要实时数据的请求，不能走语义缓存
   */
  requiresRealtimeData?: boolean;
}

/** Token 消耗明细 */
export interface TokenUsage {
  /** 普通输入 tokens（按标准价格计费） */
  inputTokens: number;
  /** 输出 tokens */
  outputTokens: number;
  /** 缓存写入 tokens（首次建立 Prompt Cache，比普通输入贵 25%） */
  cacheCreationTokens?: number;
  /** 缓存命中 tokens（命中 Prompt Cache，比普通输入便宜 90%） */
  cacheReadTokens?: number;
}

/** LLM 原始响应（Provider 层返回，Gateway 内部流转） */
export interface LLMResponse {
  /** LLM 返回的文本内容 */
  content: string;
  /** 实际使用的模型 ID（可能是 fallback 模型） */
  model: string;
  /** 实际使用的 Provider 名称 */
  provider: string;
  /** Token 消耗明细 */
  usage: TokenUsage;
}

/** Gateway 对外暴露的响应结构 */
export interface LLMGatewayResponse extends LLMResponse {
  /** 是否来自语义缓存（true 表示没有实际调用 LLM） */
  cached: boolean;
  /** 端到端延迟（毫秒） */
  latencyMs: number;
}

// ─── 缓存相关 ──────────────────────────────────────────────────────────────────

/** 语义缓存存储的响应结构 */
export interface CachedResponse {
  content: string;
  model: string;
  provider: string;
  usage: TokenUsage;
}

// ─── 配额 / 成本相关 ───────────────────────────────────────────────────────────

/** 租户配额配置 */
export interface TenantQuota {
  tenantId: string;
  /** 每日 token 上限，超出后请求被拒绝（返回 429） */
  dailyTokenLimit: number;
  /** 每月 token 上限 */
  monthlyTokenLimit: number;
  /** 每分钟最大请求数（防止瞬间流量冲击） */
  requestsPerMinute: number;
  /** 突发允许倍数（默认 1.5x，允许短时间超出 RPM 限制） */
  burstAllowance: number;
}

/** 写入审计日志的完整记录 */
export interface LLMAuditLog {
  id: string;
  tenantId: string;
  sessionId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** 估算成本（美元），调用时按当前定价计算 */
  estimatedCost: number;
  latencyMs: number;
  success: boolean;
  /** 失败时的错误码 */
  errorCode?: string;
  createdAt: Date;
}

// ─── Provider 接口 ─────────────────────────────────────────────────────────────

/** LLM Provider 的统一接口，所有 provider 实现必须遵守 */
export interface LLMProvider {
  /** Provider 名称（用于日志和 circuit breaker key） */
  readonly name: string;
  /** 发起 LLM 调用 */
  complete(request: LLMGatewayRequest): Promise<LLMResponse>;
}

// ─── 模型定价 ──────────────────────────────────────────────────────────────────

/** 单个模型的价格（美元/百万 tokens） */
export interface ModelPricing {
  /** 输入 tokens 价格 */
  inputPerMillion: number;
  /** 输出 tokens 价格 */
  outputPerMillion: number;
}

/** 各模型的当前定价（2024 年，来自 Anthropic/OpenAI 官方文档） */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-3-haiku-20240307': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  'claude-sonnet-4-5': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-3-opus-20240229': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
};

/** 按复杂度映射的模型 ID */
export const MODEL_TIERS: Record<ComplexityLevel, string> = {
  simple: 'claude-3-haiku-20240307',
  moderate: 'claude-sonnet-4-5',
  complex: 'claude-3-opus-20240229',
} as const;

// ─── 错误类型 ──────────────────────────────────────────────────────────────────

/** 租户 token 预算耗尽 */
export class QuotaExceededError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly remaining: number
  ) {
    super(`Tenant ${tenantId} quota exceeded, remaining: ${remaining} tokens`);
    this.name = 'QuotaExceededError';
  }
}

/** Provider 不可用（所有 fallback 均失败） */
export class AllProvidersFailedError extends Error {
  constructor(public readonly lastError: Error) {
    super(`All LLM providers failed. Last error: ${lastError.message}`);
    this.name = 'AllProvidersFailedError';
  }
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 估算消息列表的 input token 数量
 * 用于预扣 quota 和选择模型层级的启发式判断
 * 规则：4 个字符 ≈ 1 token（英文场景），中文约 1.5-2 个字符 ≈ 1 token
 * 这里用保守估计：每个字符算 0.5 tokens，确保预扣足够
 */
export function estimateInputTokens(messages: Message[]): number {
  const totalChars = messages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map(b => b.text).join('');
    return sum + content.length;
  }, 0);

  // 保守估计：0.5 tokens/字符，至少 100 tokens
  return Math.max(Math.ceil(totalChars * 0.5), 100);
}

/** 等待指定毫秒数 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 判断错误是否可以重试（限速或网络抖动，不包括认证错误） */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  // HTTP 429（限速）、503（服务暂时不可用）、网络超时
  return (
    message.includes('429') ||
    message.includes('503') ||
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('enotfound')
  );
}
