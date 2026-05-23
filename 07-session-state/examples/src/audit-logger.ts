/**
 * 会话审计日志
 *
 * 面向金融租户（租户 C）的合规要求：
 *   - 每次 LLM 调用、Skill 执行、session 起止都必须有日志
 *   - 日志保留至少 7 年
 *   - 不丢、不篡改、可查
 *
 * 设计要点：
 *   1. 同步写入：异步写入在崩溃时会丢失日志，违反合规
 *   2. 不阻塞主流程：写入设 500ms 超时，超时降级到本地文件 + 告警
 *   3. PII 脱敏：手机号、身份证号、银行卡号在写入前必须脱敏
 *   4. 不可篡改：表层只允许 INSERT，定期归档到对象存储
 */

import { Pool } from 'pg';
import { promises as fs } from 'fs';
import { join } from 'path';

// ==================== 类型定义 ====================

export type AuditEventType =
  | 'llm_call'
  | 'skill_execution'
  | 'session_start'
  | 'session_end'
  | 'tool_invocation';

/**
 * 审计日志条目
 * payload 字段按 eventType 不同而不同，结构详见 README
 */
export interface AuditLog {
  tenantId: string;
  sessionId: string;
  eventType: AuditEventType;
  actor: string;
  payload: Record<string, unknown>;
}

/**
 * llm_call 事件的 payload schema
 */
export interface LlmCallPayload {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  skillsUsed: string[];
  promptSummary: string;
  responseStatus: 'success' | 'error' | 'timeout';
  errorCode?: string;
}

// ==================== 常量 ====================

// 数据库写入超时（毫秒）：超过此时间走降级路径
const WRITE_TIMEOUT_MS = 500;
// 降级写入的本地文件路径
const FALLBACK_LOG_PATH = process.env.AUDIT_FALLBACK_PATH ?? '/tmp/audit-fallback.log';

// ==================== PII 脱敏 ====================

/**
 * 对文本做 PII 脱敏
 *
 * 覆盖三类常见敏感信息：
 *   - 身份证号（18 位）：保留前 6 位 + 后 4 位
 *   - 银行卡号（13-19 位）：只保留后 4 位
 *   - 手机号（11 位，中国大陆）：保留前 3 位 + 后 4 位
 *
 * 正则顺序非常关键：必须从最具体（最长且最严格）到最宽松，
 * 否则 18 位身份证号会被 13-19 位的银行卡正则先吞掉。
 * 顺序约定：身份证 → 银行卡 → 手机号。
 *
 * 生产注意：正则脱敏不是万能的，金融场景应配合专门的数据脱敏服务，
 * 还需要处理姓名、地址等更复杂的 PII。
 */
export function sanitizePii(text: string): string {
  if (!text) return text;

  return (
    text
      // 1. 身份证号：18 位（前 17 位数字 + 末位 0-9 或 X）
      //    最先匹配，避免被后续银行卡正则（13-19 位）误吞
      //    保留前 6 位（行政区划码）和后 4 位
      .replace(/\b(\d{6})\d{8}(\d{3}[\dXx])\b/g, '$1********$2')
      // 2. 银行卡号：13-19 位连续数字，匹配 12~15 位前缀 + 后 4 位
      .replace(/\b\d{12,15}(\d{4})\b/g, '****$1')
      // 3. 手机号：11 位（中国大陆，以 1 开头）
      .replace(/\b(1\d{2})\d{4}(\d{4})\b/g, '$1****$2')
  );
}

/**
 * 递归对 payload 对象的所有 string 字段做脱敏
 * 仅对 string 类型处理，number/boolean 保持原值
 */
export function sanitizePayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      result[key] = sanitizePii(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'string' ? sanitizePii(item) : item
      );
    } else if (value && typeof value === 'object') {
      result[key] = sanitizePayload(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ==================== AuditLogger ====================

export class AuditLogger {
  constructor(private readonly pgPool: Pool) {}

  /**
   * 同步写入审计日志
   *
   * 行为约定：
   *   - 写入成功：返回 void
   *   - 写入失败/超时：降级到本地文件 + 触发告警，不抛异常
   *     （审计写入失败不能阻塞主请求，否则单点故障会击穿整个服务）
   */
  async write(log: AuditLog): Promise<void> {
    // 写入前对 payload 做 PII 脱敏
    const sanitized: AuditLog = {
      ...log,
      payload: sanitizePayload(log.payload),
    };

    // 用 Promise.race 实现写入超时控制
    const writePromise = this.insertToDb(sanitized);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`审计日志写入超时（${WRITE_TIMEOUT_MS}ms）`)),
        WRITE_TIMEOUT_MS
      )
    );

    try {
      await Promise.race([writePromise, timeoutPromise]);
    } catch (err) {
      // 超时或写入失败：降级到本地文件
      await this.appendToFallback(sanitized, err);
      // 触发告警（这里只打日志，生产环境应该接 PagerDuty / 飞书机器人）
      console.error('[AuditLogger] 审计日志写入失败，已降级到本地文件', {
        error: err instanceof Error ? err.message : String(err),
        tenantId: sanitized.tenantId,
        eventType: sanitized.eventType,
      });
    }
  }

  /**
   * 真正的数据库 INSERT
   * 显式只允许 INSERT，不暴露 UPDATE/DELETE 接口
   */
  private async insertToDb(log: AuditLog): Promise<void> {
    await this.pgPool.query(
      `INSERT INTO audit_logs
         (tenant_id, session_id, event_type, actor, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        log.tenantId,
        log.sessionId,
        log.eventType,
        log.actor,
        JSON.stringify(log.payload),
      ]
    );
  }

  /**
   * 降级写入：把日志追加到本地文件
   * 由独立的后台任务定期把本地文件回放到数据库
   *
   * 生产注意：本地文件路径必须挂载到持久化卷，否则容器重启后日志丢失
   */
  private async appendToFallback(log: AuditLog, originalError: unknown): Promise<void> {
    const record = {
      ...log,
      _fallbackTimestamp: new Date().toISOString(),
      _originalError: originalError instanceof Error ? originalError.message : String(originalError),
    };

    try {
      await fs.appendFile(FALLBACK_LOG_PATH, JSON.stringify(record) + '\n', 'utf-8');
    } catch (writeErr) {
      // 连本地文件都写不进去（磁盘满？权限？）：只能打 stderr
      console.error('[AuditLogger] 本地降级文件写入也失败', writeErr);
    }
  }

  /**
   * 按租户查询审计日志（合规审计场景）
   * 用 idx_audit_tenant_time 索引，避免全表扫描
   */
  async queryByTenant(
    tenantId: string,
    options: { startTime?: Date; endTime?: Date; limit?: number } = {}
  ): Promise<AuditLog[]> {
    const { startTime, endTime, limit = 100 } = options;
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];

    if (startTime) {
      params.push(startTime);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (endTime) {
      params.push(endTime);
      conditions.push(`created_at <= $${params.length}`);
    }
    params.push(limit);

    const sql = `
      SELECT tenant_id, session_id, event_type, actor, payload, created_at
      FROM audit_logs
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}
    `;

    const { rows } = await this.pgPool.query(sql, params);
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      sessionId: row.session_id,
      eventType: row.event_type as AuditEventType,
      actor: row.actor,
      payload: row.payload,
    }));
  }
}

// ==================== 批量写入版本 ====================

/**
 * 批量审计日志写入器（用于非金融租户的高吞吐场景）
 *
 * 在内存里缓冲一个窗口期的日志，定期批量 INSERT。
 * 性能更好，但崩溃时窗口内的日志会丢，仅适用于非合规场景。
 */
export class BatchAuditLogger {
  private buffer: AuditLog[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pgPool: Pool,
    // 缓冲窗口大小（毫秒）：超过此时间或缓冲条数达到 maxBatchSize 触发 flush
    private readonly flushIntervalMs: number = 100,
    private readonly maxBatchSize: number = 200
  ) {}

  /**
   * 加入缓冲区（异步，不等待写入）
   */
  enqueue(log: AuditLog): void {
    this.buffer.push({
      ...log,
      payload: sanitizePayload(log.payload),
    });

    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
    }
  }

  /**
   * 把缓冲区里的日志一次性 INSERT
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    // 取出当前缓冲并立即清空，避免并发 flush 写两次
    const batch = this.buffer;
    this.buffer = [];

    // 构造批量 INSERT 的 VALUES 子句
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const log of batch) {
      valuesSql.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
      );
      params.push(
        log.tenantId,
        log.sessionId,
        log.eventType,
        log.actor,
        JSON.stringify(log.payload)
      );
    }

    try {
      await this.pgPool.query(
        `INSERT INTO audit_logs (tenant_id, session_id, event_type, actor, payload)
         VALUES ${valuesSql.join(', ')}`,
        params
      );
    } catch (err) {
      console.error('[BatchAuditLogger] 批量写入失败', err);
      // 失败的批次回写本地文件，避免丢失
      for (const log of batch) {
        await fs.appendFile(
          FALLBACK_LOG_PATH,
          JSON.stringify({ ...log, _failedAt: new Date().toISOString() }) + '\n'
        ).catch(() => undefined);
      }
    }
  }

  /**
   * 优雅关闭：进程退出前必须调用，把缓冲区里剩余的日志刷出去
   */
  async close(): Promise<void> {
    await this.flush();
  }
}

// ==================== 工厂函数 ====================

export function createAuditLogger(pgConnectionString: string): AuditLogger {
  const pool = new Pool({
    connectionString: pgConnectionString,
    // 审计日志连接池独立于主业务，避免主业务把连接占满
    max: 5,
    // 连接获取超时：超过此值视为审计写入失败
    connectionTimeoutMillis: 200,
  });
  return new AuditLogger(pool);
}
