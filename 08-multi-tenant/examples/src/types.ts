/**
 * 第8章：多租户核心类型定义
 *
 * 本文件定义了 AgentFlow 多租户系统的所有核心数据类型。
 * 这些类型贯穿整个多租户实现：中间件、配置管理、配额追踪、计费记录。
 */

// ─── 租户基础类型 ───────────────────────────────────────────────────────────

/**
 * 租户套餐级别
 * - starter:    小团队，有较严格的配额限制
 * - pro:        中型企业，适中配额
 * - enterprise: 大客户，高配额，支持自定义合规配置
 */
export type TenantPlan = 'starter' | 'pro' | 'enterprise';

/**
 * 租户基本信息
 */
export interface Tenant {
  id: string;             // UUID，全局唯一
  name: string;           // 企业名称
  plan: TenantPlan;
  apiKey: string;         // API 访问密钥（哈希存储）
  createdAt: Date;
  isActive: boolean;      // 是否启用，false 则拒绝所有请求
}

// ─── 租户配置类型 ────────────────────────────────────────────────────────────

/**
 * 租户可定制的 Agent 行为配置
 *
 * 所有字段都是可选的，NULL 表示使用平台默认值。
 * 配置存储在 tenant_configs 表，通过 Redis 缓存加速读取。
 */
export interface TenantConfig {
  tenantId: string;

  // Agent 行为配置
  systemPrompt: string | null;         // 自定义系统 prompt，覆盖平台默认
  allowedSkillIds: string[] | null;    // Skill 白名单，null 表示允许全部
  knowledgeBaseIds: string[] | null;   // 绑定的知识库 ID 列表
  maxContextTurns: number;             // 最大对话轮数（影响 context 长度）
  enableBuiltinKnowledge: boolean;     // 是否启用平台内置知识库

  // LLM 配置
  preferredModel: string | null;       // 首选模型，null 使用平台默认
  fallbackModel: string | null;        // 配额不足时的降级模型

  // 合规与安全配置
  requireAuditLog: boolean;            // 是否记录完整审计日志（金融租户必开）
  piiMaskingEnabled: boolean;          // 是否启用 PII 脱敏
  allowedIpRanges: string[] | null;    // IP 白名单，null 不限制

  updatedAt: Date;
}

// ─── 配额类型 ────────────────────────────────────────────────────────────────

/**
 * 租户配额定义
 *
 * 配额分两类：
 * - 速率配额（requestsPerMinute）：控制请求频率，用滑动窗口限流
 * - 总量配额（dailyTokenLimit 等）：控制总消耗量，用计数器追踪
 */
export interface TenantQuota {
  tenantId: string;
  plan: TenantPlan;

  // LLM Token 配额（总量）
  dailyTokenLimit: number;              // 每日 Token 上限
  monthlyTokenLimit: number;            // 每月 Token 上限

  // 请求频率配额（速率）
  requestsPerMinute: number;            // 每分钟请求数上限
  requestsPerDay: number;               // 每日请求总数上限

  // 资源配额
  customSkillLimit: number;             // 自定义 Skill 数量上限
  knowledgeBaseSizeGb: number;          // 知识库总存储上限（GB）
  concurrentSessionLimit: number;       // 最大并发 session 数
}

/**
 * 各套餐的默认配额配置
 */
export const PLAN_QUOTAS: Record<TenantPlan, Omit<TenantQuota, 'tenantId' | 'plan'>> = {
  starter: {
    dailyTokenLimit: 1_000_000,        // 100 万 Token/天
    monthlyTokenLimit: 20_000_000,     // 2000 万 Token/月
    requestsPerMinute: 20,
    requestsPerDay: 5_000,
    customSkillLimit: 3,
    knowledgeBaseSizeGb: 1,
    concurrentSessionLimit: 50,
  },
  pro: {
    dailyTokenLimit: 10_000_000,       // 1000 万 Token/天
    monthlyTokenLimit: 200_000_000,    // 2 亿 Token/月
    requestsPerMinute: 100,
    requestsPerDay: 50_000,
    customSkillLimit: 20,
    knowledgeBaseSizeGb: 10,
    concurrentSessionLimit: 500,
  },
  enterprise: {
    dailyTokenLimit: 100_000_000,      // 1 亿 Token/天
    monthlyTokenLimit: 2_000_000_000,  // 20 亿 Token/月
    requestsPerMinute: 1_000,
    requestsPerDay: 500_000,
    customSkillLimit: 100,
    knowledgeBaseSizeGb: 100,
    concurrentSessionLimit: 5_000,
  },
};

// ─── 配额检查结果类型 ─────────────────────────────────────────────────────────

/**
 * 配额检查结果
 */
export interface QuotaCheckResult {
  allowed: boolean;
  used?: number;         // 已使用量
  limit?: number;        // 总限额
  remaining?: number;    // 剩余量
  reason?: string;       // 拒绝原因（仅 allowed=false 时有值）
  resetAt?: Date;        // 配额重置时间（仅 allowed=false 时有值）
}

/**
 * 限流检查结果
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;           // 速率上限（请求/分钟）
  retryAfter?: number;     // 建议重试间隔（秒），仅 allowed=false 时有值
}

// ─── 计费记录类型 ────────────────────────────────────────────────────────────

/**
 * 账单状态
 * - draft:     当月进行中，数据持续累积
 * - finalized: 月末结算完毕，数据冻结，不再变更
 * - paid:      已收款
 */
export type BillingStatus = 'draft' | 'finalized' | 'paid';

/**
 * 月度账单记录
 *
 * 每个租户每个自然月有一条记录，在月末结算时从 draft 转为 finalized。
 * 费用以分（cents）为单位，避免浮点数精度问题。
 */
export interface BillingRecord {
  id: string;
  tenantId: string;
  periodStart: Date;           // 账期开始（当月1日）
  periodEnd: Date;             // 账期结束（当月最后一天）

  // Token 用量明细
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheHitTokens: number; // 命中缓存的 token（计费有优惠）
  totalRequests: number;

  // 费用明细（以分为单位）
  inputTokenCostCents: number;
  outputTokenCostCents: number;
  amountCents: number;         // 总费用
  currency: string;            // 货币代码，如 'USD', 'CNY'

  status: BillingStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Token 用量上报（每次 LLM 调用后记录）
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;  // Anthropic prompt caching 命中的 token 数
  model: string;           // 实际使用的模型（可能与请求模型不同，比如触发了降级）
}

// ─── 错误类型 ─────────────────────────────────────────────────────────────────

export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = 'TenantNotFoundError';
  }
}

export class TenantInactiveError extends Error {
  constructor(tenantId: string) {
    super(`Tenant is inactive: ${tenantId}`);
    this.name = 'TenantInactiveError';
  }
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly reason: string,
    public readonly resetAt?: Date
  ) {
    super(`Quota exceeded: ${reason}`);
    this.name = 'QuotaExceededError';
  }
}

export class RateLimitError extends Error {
  constructor(public readonly retryAfter: number) {
    super(`Rate limit exceeded, retry after ${retryAfter}s`);
    this.name = 'RateLimitError';
  }
}
