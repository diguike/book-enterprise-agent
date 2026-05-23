/**
 * CostTracker：LLM 调用成本追踪
 *
 * 每次 LLM 调用后写入 llm_audit_logs 表：
 * - 记录 token 消耗明细（普通输入/缓存写入/缓存命中/输出）
 * - 按当前定价计算估算成本
 * - 为租户级成本统计和告警提供数据基础
 *
 * 生产注意：
 * 高并发时同步写 DB 可能成为瓶颈（每次 LLM 调用都有一次 INSERT）。
 * 优化方案：先写 Redis List，异步 Worker 批量刷入 DB（第11章实现）。
 * 本章用同步写入，保持代码简单，便于理解核心逻辑。
 */

import pg from 'pg';
import { randomUUID } from 'crypto';
import { MODEL_PRICING, type LLMAuditLog, type TokenUsage } from './types.js';

const { Pool } = pg;

// ─── 成本计算 ──────────────────────────────────────────────────────────────────

/**
 * 根据 token 明细计算估算成本（美元）
 *
 * Anthropic Prompt Caching 定价（2024）：
 * - 普通输入：$3.00/M tokens
 * - 缓存写入：$3.75/M tokens（比普通输入贵 25%，首次建立缓存时计费）
 * - 缓存命中：$0.30/M tokens（比普通输入便宜 90%，后续命中时计费）
 * - 输出：$15.00/M tokens
 */
export function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    // 未知模型，用最贵的价格兜底（宁可高估，不要漏算）
    console.warn(`[CostTracker] Unknown model ${model}, using fallback pricing`);
    return (
      ((usage.inputTokens + usage.outputTokens) / 1_000_000) * 15.0
    );
  }

  // 普通输入费用
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;

  // 输出费用
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;

  // 缓存写入费用（比普通输入贵 25%）
  const cacheCreationCost =
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) *
    pricing.inputPerMillion *
    1.25;

  // 缓存命中费用（比普通输入便宜 90%，即原价的 10%）
  const cacheReadCost =
    ((usage.cacheReadTokens ?? 0) / 1_000_000) *
    pricing.inputPerMillion *
    0.1;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

// ─── DB Schema（建表 SQL，首次运行时执行） ─────────────────────────────────────

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS llm_audit_logs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             VARCHAR(255) NOT NULL,
  session_id            VARCHAR(255) NOT NULL,
  model                 VARCHAR(255) NOT NULL,
  provider              VARCHAR(50)  NOT NULL,
  input_tokens          INTEGER      NOT NULL DEFAULT 0,
  output_tokens         INTEGER      NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER      NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER      NOT NULL DEFAULT 0,
  estimated_cost        DECIMAL(10, 8) NOT NULL DEFAULT 0,
  latency_ms            INTEGER      NOT NULL,
  success               BOOLEAN      NOT NULL,
  error_code            VARCHAR(100),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 按租户 + 时间查询的复合索引（用于成本统计报表）
CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_tenant_time
  ON llm_audit_logs (tenant_id, created_at DESC);

-- 按会话查询的索引（用于调试特定会话的 token 消耗）
CREATE INDEX IF NOT EXISTS idx_llm_audit_logs_session
  ON llm_audit_logs (session_id);
`;

// ─── CostTracker ──────────────────────────────────────────────────────────────

/** 记录一次 LLM 调用的输入参数 */
export interface TrackCallInput {
  tenantId: string;
  sessionId: string;
  model: string;
  provider: string;
  usage: TokenUsage;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
}

/**
 * 成本追踪器
 *
 * 使用方式：
 * ```ts
 * const tracker = new CostTracker(databaseUrl);
 * await tracker.init(); // 创建表（幂等，可多次调用）
 * await tracker.record({ tenantId, sessionId, model, ... });
 * ```
 */
export class CostTracker {
  private pool: pg.Pool;
  private initialized = false;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  /**
   * 初始化数据库（建表）
   * 幂等操作（CREATE TABLE IF NOT EXISTS），可以在每次启动时调用
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.pool.query(CREATE_TABLE_SQL);
      this.initialized = true;
      console.log('[CostTracker] Database initialized');
    } catch (err) {
      // DB 不可用时不阻止 Gateway 启动，但记录错误
      // 成本追踪是重要功能但不是关键路径，允许降级
      console.error('[CostTracker] Failed to initialize database:', (err as Error).message);
    }
  }

  /**
   * 记录一次 LLM 调用
   * 计算估算成本并异步写入 DB
   */
  async record(input: TrackCallInput): Promise<LLMAuditLog> {
    const estimatedCost = calculateCost(input.model, input.usage);

    const log: LLMAuditLog = {
      id: randomUUID(),
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      model: input.model,
      provider: input.provider,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheCreationTokens: input.usage.cacheCreationTokens ?? 0,
      cacheReadTokens: input.usage.cacheReadTokens ?? 0,
      estimatedCost,
      latencyMs: input.latencyMs,
      success: input.success,
      errorCode: input.errorCode,
      createdAt: new Date(),
    };

    // 异步写入，不阻塞 Gateway 返回响应
    this.insertLog(log).catch(err => {
      console.error('[CostTracker] Failed to insert log:', (err as Error).message);
    });

    return log;
  }

  /**
   * 查询租户在指定日期范围内的成本汇总
   * 用于账单计算和用量报表
   */
  async getTenantCostSummary(
    tenantId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    requestCount: number;
    cacheHitRate: number;
  }> {
    if (!this.initialized) {
      return {
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        requestCount: 0,
        cacheHitRate: 0,
      };
    }

    const result = await this.pool.query<{
      total_cost: string;
      total_input_tokens: string;
      total_output_tokens: string;
      total_cache_read_tokens: string;
      request_count: string;
    }>(
      `SELECT
         SUM(estimated_cost)        AS total_cost,
         SUM(input_tokens)          AS total_input_tokens,
         SUM(output_tokens)         AS total_output_tokens,
         SUM(cache_read_tokens)     AS total_cache_read_tokens,
         COUNT(*)                   AS request_count
       FROM llm_audit_logs
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
         AND success = true`,
      [tenantId, startDate, endDate]
    );

    const row = result.rows[0];
    if (!row) {
      return {
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        requestCount: 0,
        cacheHitRate: 0,
      };
    }

    const totalInputTokens = parseInt(row.total_input_tokens ?? '0');
    const totalCacheReadTokens = parseInt(row.total_cache_read_tokens ?? '0');
    const totalProcessedTokens = totalInputTokens + totalCacheReadTokens;

    return {
      totalCost: parseFloat(row.total_cost ?? '0'),
      totalInputTokens,
      totalOutputTokens: parseInt(row.total_output_tokens ?? '0'),
      totalCacheReadTokens,
      requestCount: parseInt(row.request_count ?? '0'),
      // 缓存命中率 = 缓存读取 tokens / 总处理 tokens
      cacheHitRate: totalProcessedTokens > 0
        ? totalCacheReadTokens / totalProcessedTokens
        : 0,
    };
  }

  /** 关闭 DB 连接池 */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /** 实际执行 DB INSERT */
  private async insertLog(log: LLMAuditLog): Promise<void> {
    if (!this.initialized) return; // DB 未初始化时跳过

    await this.pool.query(
      `INSERT INTO llm_audit_logs (
         id, tenant_id, session_id, model, provider,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         estimated_cost, latency_ms, success, error_code, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        log.id,
        log.tenantId,
        log.sessionId,
        log.model,
        log.provider,
        log.inputTokens,
        log.outputTokens,
        log.cacheCreationTokens,
        log.cacheReadTokens,
        log.estimatedCost,
        log.latencyMs,
        log.success,
        log.errorCode ?? null,
        log.createdAt,
      ]
    );
  }
}
