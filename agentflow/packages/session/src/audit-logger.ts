/**
 * Postgres 审计日志记录器（MVP 简化版）
 *
 * 写 llm_audit_logs 表，记录每次 LLM 调用的请求/响应/token 用量。
 * MVP 在主流程中"fire-and-forget"调用：
 *   void auditLogger.record(...)
 * 让写入不阻塞响应；失败只打日志，不影响业务。
 *
 * 生产注意：高并发场景应该走 BullMQ 队列异步落库，见第 11 章。
 */

import { Pool, PoolConfig } from 'pg';

export interface AuditLogEntry {
  tenantId: string;
  sessionId?: string;
  provider: string;
  model: string;
  /** 完整请求体（messages + tools + system），合规场景必须保留 */
  requestBody: unknown;
  /** 完整响应体；失败时可为 null */
  responseBody: unknown;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
}

export class AuditLogger {
  private pool: Pool;

  constructor(poolConfig: PoolConfig | string) {
    this.pool =
      typeof poolConfig === 'string'
        ? new Pool({ connectionString: poolConfig })
        : new Pool(poolConfig);
  }

  /**
   * 写一条审计日志。
   * tenantId 必须是 tenants 表已存在的 UUID，否则会因外键失败。
   */
  async record(entry: AuditLogEntry): Promise<void> {
    const sql = `
      INSERT INTO llm_audit_logs (
        tenant_id, session_id, provider, model,
        request_body, response_body,
        input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens,
        latency_ms, success, error_code
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6,
        $7, $8,
        $9, $10,
        $11, $12, $13
      )
    `;

    try {
      await this.pool.query(sql, [
        entry.tenantId,
        entry.sessionId ?? null,
        entry.provider,
        entry.model,
        JSON.stringify(entry.requestBody),
        entry.responseBody === null ? null : JSON.stringify(entry.responseBody),
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheCreationTokens,
        entry.cacheReadTokens,
        entry.latencyMs,
        entry.success,
        entry.errorCode ?? null,
      ]);
    } catch (err) {
      // 审计写失败不抛出，避免污染业务流程；只打日志
      console.error('[AuditLogger] 写入审计日志失败:', (err as Error).message);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
