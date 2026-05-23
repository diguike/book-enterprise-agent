/**
 * LLMGateway：主入口，组合所有组件
 *
 * 请求处理顺序：
 * 1. 语义缓存检查（命中则直接返回，不消耗 token 配额）
 * 2. Token Budget 检查（预扣估算量）
 * 3. 构造带 cache_control 的优化 prompt
 * 4. 路由到 LLM Provider（含 retry + circuit breaker）
 * 5. 修正实际 token 消耗（多退少补）
 * 6. 写入审计日志（异步）
 * 7. 更新语义缓存（异步，仅限非实时数据类请求）
 */

import { Redis as RedisClient } from 'ioredis';
import {
  type LLMGatewayRequest,
  type LLMGatewayResponse,
  type LLMResponse,
  estimateInputTokens,
  QuotaExceededError,
} from './types.js';
import { LLMRouter } from './router.js';
import { PromptCacheBuilder } from './prompt-cache.js';
import { SemanticCache } from './semantic-cache.js';
import { QuotaManager } from './quota.js';
import { CostTracker } from './cost-tracker.js';

// ─── 模拟租户系统 Prompt 数据库（生产中从 DB 读取） ──────────────────────────────

/**
 * 租户定制系统 prompt（生产中存储在 DB，通过 tenantId 查询）
 * 这里用内存 Map 模拟，便于示例运行
 */
const TENANT_SYSTEM_PROMPTS: Map<string, string> = new Map([
  [
    'tenant-ecommerce',
    `你是【优购电商】的专属客服助手。

## 业务范围
- 订单管理：查询状态、修改地址（未发货）、取消订单（未发货 + 24小时内）
- 退换货：7天无理由退款，质量问题15天换货
- 物流查询：支持顺丰、京东、菜鸟等主流快递
- 促销活动：解答当前进行中的满减、优惠券使用规则

## 特殊规则
- 订单金额超过 5000 元的退款申请，需转人工客服审核
- 每日 00:00-06:00 为系统维护时间，物流信息可能延迟更新
- 遇到用户情绪激动时，优先表达理解，再说明处理方案

## 话术风格
亲切但专业，回复简洁不超过 150 字，复杂问题分步骤说明。`,
  ],
  [
    'tenant-saas',
    `你是【CloudDesk SaaS】的技术支持助手。

## 服务范围
- 账单与订阅：查询账单、升降级套餐、开具发票
- 技术问题：API 接口、SDK 集成、Webhook 配置
- 工单系统：创建工单、查询进度、上传附件
- 文档问答：基于产品文档回答使用方法

## 工单优先级规则
- P0（生产故障）：30分钟内响应，立即升级工程师
- P1（功能异常）：4小时内响应
- P2（咨询问题）：1个工作日响应

## 技术回答标准
给出代码示例时，默认使用 curl + JSON 格式，并标注 SDK 版本。`,
  ],
  [
    'tenant-finance',
    `你是【合规金融】平台的客服助手。本平台受金融监管，所有对话均被记录审计。

## 严格禁止
- 不提供任何投资建议或收益预测
- 不对具体金融产品作出好坏判断
- 不透露其他用户的账户信息

## 可处理业务
- 账户查询：余额、流水、持仓（需已完成身份验证）
- 产品介绍：基本产品信息（不含收益预测）
- 合规咨询：转接合规专员

## 固定声明
每次回复结尾必须附上：「以上信息仅供参考，不构成投资建议。」`,
  ],
]);

async function getTenantSystemPrompt(tenantId: string): Promise<string> {
  return TENANT_SYSTEM_PROMPTS.get(tenantId) ?? '你是一个企业智能客服助手，请礼貌、准确地回答用户问题。';
}

// ─── Gateway 配置 ──────────────────────────────────────────────────────────────

export interface GatewayConfig {
  /** Anthropic API Key */
  anthropicApiKey?: string;
  /** OpenAI API Key（用于 Fallback + 语义缓存 Embedding） */
  openaiApiKey?: string;
  /** Redis 连接 URL */
  redisUrl: string;
  /** PostgreSQL 连接 URL */
  databaseUrl?: string;
}

// ─── LLMGateway ──────────────────────────────────────────────────────────────

/**
 * LLM Gateway 主类
 *
 * 示例用法：
 * ```ts
 * const gateway = new LLMGateway({
 *   anthropicApiKey: process.env.ANTHROPIC_API_KEY,
 *   openaiApiKey: process.env.OPENAI_API_KEY,
 *   redisUrl: process.env.REDIS_URL,
 *   databaseUrl: process.env.DATABASE_URL,
 * });
 *
 * await gateway.init();
 *
 * const response = await gateway.complete({
 *   tenantId: 'tenant-ecommerce',
 *   sessionId: 'session-123',
 *   messages: [{ role: 'user', content: '我的订单什么时候发货？' }],
 *   complexity: 'moderate',
 * });
 * ```
 */
export class LLMGateway {
  private redis: RedisClient;
  private router: LLMRouter;
  private promptCacheBuilder: PromptCacheBuilder;
  private semanticCache: SemanticCache | null = null;
  private quotaManager: QuotaManager;
  private costTracker: CostTracker | null = null;

  constructor(private config: GatewayConfig) {
    // 初始化 Redis 连接
    this.redis = new RedisClient(config.redisUrl, {
      // 连接失败时不立即退出进程，允许降级运行
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    // 初始化各组件
    this.router = new LLMRouter(this.redis, {
      anthropicApiKey: config.anthropicApiKey,
      openaiApiKey: config.openaiApiKey,
    });

    this.promptCacheBuilder = new PromptCacheBuilder();
    this.quotaManager = new QuotaManager(this.redis);

    // 语义缓存需要 OpenAI Embedding，仅在提供 OpenAI Key 时启用
    if (config.openaiApiKey) {
      this.semanticCache = new SemanticCache(this.redis, config.openaiApiKey);
    }

    // 成本追踪需要 DB 连接，仅在提供 databaseUrl 时启用
    if (config.databaseUrl) {
      this.costTracker = new CostTracker(config.databaseUrl);
    }
  }

  /**
   * 初始化（连接 Redis、创建 DB 表）
   * 应在服务启动时调用一次
   */
  async init(): Promise<void> {
    await this.redis.connect();
    await this.costTracker?.init();
    console.log('[LLMGateway] Initialized');
  }

  /**
   * 处理 LLM 请求
   * 这是 Gateway 对外暴露的唯一入口
   */
  async complete(request: LLMGatewayRequest): Promise<LLMGatewayResponse> {
    const startTime = Date.now();

    // ── 步骤 1：语义缓存检查 ──────────────────────────────────────────────────
    // 在 quota 检查之前：命中缓存则完全不消耗 token 配额
    if (this.semanticCache && !request.requiresRealtimeData) {
      const lastMessage = request.messages.at(-1);
      const queryText = lastMessage
        ? (typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.content.map(b => b.text).join(''))
        : '';

      const semanticHit = await this.semanticCache.get(queryText, request.tenantId);
      if (semanticHit) {
        console.log('[LLMGateway] Semantic cache hit', {
          tenantId: request.tenantId,
          sessionId: request.sessionId,
        });
        return {
          content: semanticHit.content,
          model: semanticHit.model,
          provider: semanticHit.provider,
          usage: semanticHit.usage,
          cached: true,
          latencyMs: Date.now() - startTime,
        };
      }
    }

    // ── 步骤 2：Token Budget 检查（原子预扣） ────────────────────────────────
    const estimatedTokens = estimateInputTokens(request.messages);
    // 保守估算：输入 tokens × 1.5（包含预期输出）
    const reservedTokens = Math.ceil(estimatedTokens * 1.5);

    // checkAndConsume 会在超出预算时抛出 QuotaExceededError
    await this.quotaManager.checkAndConsume(request.tenantId, reservedTokens);

    // ── 步骤 3：构造带 cache_control 的优化 prompt ────────────────────────────
    const tenantSystemPrompt = await getTenantSystemPrompt(request.tenantId);
    const optimizedMessages = this.promptCacheBuilder.build(
      tenantSystemPrompt,
      request.messages
    );

    // ── 步骤 4：路由到 LLM Provider ──────────────────────────────────────────
    let llmResponse: LLMResponse;
    let callSuccess = true;
    let errorCode: string | undefined;

    try {
      llmResponse = await this.router.complete({
        ...request,
        messages: optimizedMessages,
      });
    } catch (err) {
      callSuccess = false;
      errorCode = (err as Error).name;
      // 记录失败日志后重新抛出
      await this.recordCall(request, null, reservedTokens, startTime, false, errorCode);
      throw err;
    }

    // ── 步骤 5：修正实际 token 消耗（多退少补） ──────────────────────────────
    await this.quotaManager.adjust(
      request.tenantId,
      llmResponse.usage,
      reservedTokens
    );

    // ── 步骤 6：写入审计日志（异步，不阻塞响应） ─────────────────────────────
    void this.recordCall(request, llmResponse, reservedTokens, startTime, callSuccess, errorCode);

    // ── 步骤 7：更新语义缓存（异步，仅限非实时类请求） ───────────────────────
    if (this.semanticCache && !request.requiresRealtimeData) {
      const lastMessage = request.messages.at(-1);
      const queryText = lastMessage
        ? (typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.content.map(b => b.text).join(''))
        : '';

      void this.semanticCache.set(queryText, llmResponse, request.tenantId);
    }

    return {
      ...llmResponse,
      cached: false,
      latencyMs: Date.now() - startTime,
    };
  }

  /** 关闭所有连接 */
  async close(): Promise<void> {
    await this.redis.quit();
    await this.costTracker?.close();
  }

  /** 记录一次 LLM 调用到审计日志 */
  private async recordCall(
    request: LLMGatewayRequest,
    response: LLMResponse | null,
    _reservedTokens: number,
    startTime: number,
    success: boolean,
    errorCode?: string
  ): Promise<void> {
    if (!this.costTracker) return;

    try {
      await this.costTracker.record({
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        model: response?.model ?? 'unknown',
        provider: response?.provider ?? 'unknown',
        usage: response?.usage ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        latencyMs: Date.now() - startTime,
        success,
        errorCode,
      });
    } catch (err) {
      // 审计日志写失败不影响主流程
      console.error('[LLMGateway] Failed to record audit log:', (err as Error).message);
    }
  }
}

// ─── 工厂函数：从环境变量创建 Gateway ─────────────────────────────────────────

/**
 * 从环境变量创建 LLMGateway 实例
 * 适合在应用启动时调用一次，得到单例 Gateway
 */
export function createGatewayFromEnv(): LLMGateway {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

  return new LLMGateway({
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
    openaiApiKey: process.env['OPENAI_API_KEY'],
    redisUrl,
    databaseUrl: process.env['DATABASE_URL'],
  });
}

// 导出用于测试的工具函数
export { calculateCost } from './cost-tracker.js';
export { QuotaExceededError };
