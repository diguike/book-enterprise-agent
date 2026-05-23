/**
 * 第8章：租户配置管理
 *
 * 职责：管理 tenant_configs 表的读写，提供高性能的配置读取路径。
 *
 * 配置读取在每次 Agent 请求中都会发生（热路径），不能每次都打 Postgres。
 * 这里用 Redis 做缓存层：
 *   - 读：Redis miss 时回源 Postgres，回填 Redis，TTL 5 分钟
 *   - 写：更新 Postgres 后，主动失效 Redis 缓存（通过 Pub/Sub 通知所有进程）
 *
 * 单机 vs 生产差距：
 *   - 单机：使用单节点 Redis
 *   - 生产：Redis Cluster，key 用 hash tag 保证同租户的所有 key 落到同一 slot
 */

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { TenantConfig } from './types.js';

// ─── Redis Key 命名规范 ───────────────────────────────────────────────────────
//
// 所有 Redis key 都包含 {tenantId}，配合 Redis Cluster 的 hash tag 机制。
// 同一租户的 config、quota、rate-limit 都会落到同一个 slot，方便事务/Lua 脚本。

const CONFIG_KEY_PREFIX = 'tenant:config:';   // tenant:config:{<uuid>}
const CONFIG_CHANNEL = 'tenant:config:invalidate';
const CONFIG_TTL_SECONDS = 300;               // 5 分钟，配合 Pub/Sub 主动失效

export class ConfigManager {
  // 进程内一级缓存：避免高频请求每次都打 Redis
  // 主动失效通过 Pub/Sub 同步给所有进程
  private localCache: Map<string, { config: TenantConfig; expireAt: number }> = new Map();
  private readonly localTtlMs = 30_000;       // 进程内缓存 30 秒

  constructor(
    private readonly redis: Redis,
    private readonly redisSub: Redis,         // 单独连接订阅失效通道
    private readonly pgPool: Pool,
  ) {
    // 订阅配置失效通道，收到失效消息后清掉本地缓存
    this.redisSub.subscribe(CONFIG_CHANNEL).catch((err) => {
      console.error('[ConfigManager] subscribe failed', err);
    });
    this.redisSub.on('message', (channel, message) => {
      if (channel === CONFIG_CHANNEL) {
        this.localCache.delete(message);
      }
    });
  }

  /**
   * 获取租户配置
   *
   * 读取顺序：进程内缓存 → Redis → Postgres
   * 任一层 hit 都会回填上层
   */
  async getTenantConfig(tenantId: string): Promise<TenantConfig | null> {
    // L1: 进程内缓存
    const local = this.localCache.get(tenantId);
    if (local && local.expireAt > Date.now()) {
      return local.config;
    }

    // L2: Redis 缓存
    const cacheKey = `${CONFIG_KEY_PREFIX}{${tenantId}}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const config = this.deserializeConfig(cached);
      this.setLocalCache(tenantId, config);
      return config;
    }

    // L3: Postgres 回源
    const config = await this.loadFromDatabase(tenantId);
    if (!config) {
      return null;
    }

    // 回填 Redis 和本地缓存
    await this.redis.setex(cacheKey, CONFIG_TTL_SECONDS, this.serializeConfig(config));
    this.setLocalCache(tenantId, config);

    return config;
  }

  /**
   * 更新租户配置
   *
   * 写 Postgres → 失效 Redis → Pub/Sub 通知所有进程清本地缓存
   * 注意顺序：先写库再失效缓存，避免缓存中读到旧值的窗口
   */
  async updateTenantConfig(tenantId: string, patch: Partial<TenantConfig>): Promise<void> {
    // 1. 写入 Postgres
    await this.writeToDatabase(tenantId, patch);

    // 2. 删除 Redis 缓存（next read 会回源 DB 重新填充）
    const cacheKey = `${CONFIG_KEY_PREFIX}{${tenantId}}`;
    await this.redis.del(cacheKey);

    // 3. Pub/Sub 通知所有进程清本地缓存
    // 单机 vs 生产：单机只有一个进程，Pub/Sub 是空跑；
    // 生产环境 N 个 Worker，必须通过 Pub/Sub 同步
    await this.redis.publish(CONFIG_CHANNEL, tenantId);

    // 当前进程也清掉
    this.localCache.delete(tenantId);
  }

  /**
   * 批量预热缓存（启动时调用，把活跃租户的配置先灌进 Redis）
   */
  async warmup(tenantIds: string[]): Promise<void> {
    await Promise.all(
      tenantIds.map(async (id) => {
        const config = await this.loadFromDatabase(id);
        if (config) {
          const cacheKey = `${CONFIG_KEY_PREFIX}{${id}}`;
          await this.redis.setex(cacheKey, CONFIG_TTL_SECONDS, this.serializeConfig(config));
        }
      }),
    );
  }

  // ─── 内部方法 ───────────────────────────────────────────────────────────────

  private setLocalCache(tenantId: string, config: TenantConfig): void {
    this.localCache.set(tenantId, {
      config,
      expireAt: Date.now() + this.localTtlMs,
    });
  }

  /**
   * 从 Postgres 加载配置
   *
   * 注意：这个查询不会被 RLS 过滤——ConfigManager 是平台级组件，
   * 用平台 DB 用户连接（绕过 RLS），因为它需要查任意租户的配置。
   * 业务请求路径上的查询则必须设置 app.current_tenant_id。
   */
  private async loadFromDatabase(tenantId: string): Promise<TenantConfig | null> {
    const result = await this.pgPool.query(
      `SELECT tenant_id, system_prompt, allowed_skill_ids, knowledge_base_ids,
              max_context_turns, enable_builtin_knowledge,
              preferred_model, fallback_model,
              require_audit_log, pii_masking_enabled, allowed_ip_ranges,
              updated_at
         FROM tenant_configs
        WHERE tenant_id = $1`,
      [tenantId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      tenantId: row.tenant_id,
      systemPrompt: row.system_prompt,
      allowedSkillIds: row.allowed_skill_ids,
      knowledgeBaseIds: row.knowledge_base_ids,
      maxContextTurns: row.max_context_turns,
      enableBuiltinKnowledge: row.enable_builtin_knowledge,
      preferredModel: row.preferred_model,
      fallbackModel: row.fallback_model,
      requireAuditLog: row.require_audit_log,
      piiMaskingEnabled: row.pii_masking_enabled,
      allowedIpRanges: row.allowed_ip_ranges,
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * 写入 Postgres（UPSERT 语义）
   */
  private async writeToDatabase(tenantId: string, patch: Partial<TenantConfig>): Promise<void> {
    // 把 camelCase 转 snake_case，构造 UPDATE 列
    // 演示用，生产推荐用 Drizzle 或类似 ORM 自动处理映射
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [tenantId];
    let idx = 2;

    const fieldMap: Record<string, string> = {
      systemPrompt: 'system_prompt',
      allowedSkillIds: 'allowed_skill_ids',
      knowledgeBaseIds: 'knowledge_base_ids',
      maxContextTurns: 'max_context_turns',
      enableBuiltinKnowledge: 'enable_builtin_knowledge',
      preferredModel: 'preferred_model',
      fallbackModel: 'fallback_model',
      requireAuditLog: 'require_audit_log',
      piiMaskingEnabled: 'pii_masking_enabled',
      allowedIpRanges: 'allowed_ip_ranges',
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value !== undefined) {
        setClauses.push(`${column} = $${idx}`);
        params.push(value);
        idx += 1;
      }
    }

    await this.pgPool.query(
      `UPDATE tenant_configs SET ${setClauses.join(', ')} WHERE tenant_id = $1`,
      params,
    );
  }

  private serializeConfig(config: TenantConfig): string {
    return JSON.stringify(config);
  }

  private deserializeConfig(raw: string): TenantConfig {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      updatedAt: new Date(parsed.updatedAt),
    };
  }
}
