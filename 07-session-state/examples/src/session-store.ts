/**
 * Redis 会话存储
 *
 * 负责管理 AgentFlow 的会话状态，包括 session 数据的读写、
 * 消息追加、以及过期 session 的归档到 Postgres。
 *
 * Key 命名规范（按第2章单机规则，兼容 Redis Cluster hash tag）：
 *   session:{sessionId}          → 完整 SessionData（JSON）
 *   session:{sessionId}:messages → 最近消息列表（List，最多50条）
 *   tenant:{tenantId}:sessions   → 该租户的活跃 sessionId 集合（Set）
 */

import Redis from 'ioredis';
import { Pool } from 'pg';
import { z } from 'zod';

// ==================== 类型定义 ====================

export const ConversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.number(),
  // 用于上下文压缩的重要性分数（0-1）
  importanceScore: z.number().min(0).max(1).optional(),
  // tool_use 场景下的工具调用信息
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
});

export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const AgentConfigSchema = z.object({
  systemPrompt: z.string(),
  model: z.string(),
  maxTokens: z.number(),
  temperature: z.number(),
  enabledSkills: z.array(z.string()),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const SessionDataSchema = z.object({
  sessionId: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  messages: z.array(ConversationMessageSchema),
  agentConfig: AgentConfigSchema,
  activeSkills: z.array(z.string()),
  // 扩展字段，不同租户可定制（例如租户 C 存入合规相关标记）
  metadata: z.record(z.unknown()),
  createdAt: z.number(),
  lastActiveAt: z.number(),
});

export type SessionData = z.infer<typeof SessionDataSchema>;

// ==================== 常量 ====================

// Session 过期时间：30分钟无操作后自动过期
const SESSION_TTL_SECONDS = 1800;
// 单个 session 最多保留的消息条数（避免单 key 过大）
const MAX_MESSAGES_PER_SESSION = 50;

// ==================== RedisSessionStore ====================

export class RedisSessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly pgPool: Pool
  ) {}

  /**
   * 读取 session 数据
   * 每次读取都会重置 TTL（滑动过期策略）
   */
  async get(sessionId: string): Promise<SessionData | null> {
    const key = `session:{${sessionId}}`;
    const raw = await this.redis.get(key);

    if (!raw) {
      return null;
    }

    // 重置 TTL：每次访问都刷新过期时间
    await this.redis.expire(key, SESSION_TTL_SECONDS);

    try {
      const parsed = JSON.parse(raw) as unknown;
      return SessionDataSchema.parse(parsed);
    } catch {
      // 数据损坏时返回 null，调用方会重新创建 session
      console.error(`[SessionStore] session 数据解析失败: ${sessionId}`);
      return null;
    }
  }

  /**
   * 写入完整的 session 数据
   * 同时更新租户的活跃 session 集合
   */
  async set(sessionId: string, data: SessionData): Promise<void> {
    const sessionKey = `session:{${sessionId}}`;
    const tenantSessionsKey = `tenant:{${data.tenantId}}:sessions`;

    // 使用 pipeline 批量执行，减少网络往返
    // 生产注意：在 Redis Cluster 中，sessionKey 和 tenantSessionsKey 包含不同的 hash tag
    // 因此路由到不同节点，不能在同一个 pipeline 里保证原子性
    // 如果需要严格原子性，需要拆开执行或使用 Lua 脚本
    await this.redis.set(
      sessionKey,
      JSON.stringify(data),
      'EX',
      SESSION_TTL_SECONDS
    );
    await this.redis.sadd(tenantSessionsKey, sessionId);
  }

  /**
   * 追加消息到 session 的消息列表
   * 使用 List 结构，LPUSH（头部插入）+ LTRIM（保留最近50条）
   */
  async appendMessage(
    sessionId: string,
    message: ConversationMessage
  ): Promise<void> {
    const key = `session:{${sessionId}}:messages`;

    // pipeline 确保三个命令在同一 slot 上原子执行
    // 使用 hash tag {sessionId}，保证 session:{sessionId} 和
    // session:{sessionId}:messages 路由到同一个 Cluster 节点
    await this.redis
      .pipeline()
      .lpush(key, JSON.stringify(message))
      .ltrim(key, 0, MAX_MESSAGES_PER_SESSION - 1)
      .expire(key, SESSION_TTL_SECONDS)
      .exec();
  }

  /**
   * 从消息列表读取最近 N 条消息（按时间正序返回）
   */
  async getMessages(
    sessionId: string,
    limit: number = MAX_MESSAGES_PER_SESSION
  ): Promise<ConversationMessage[]> {
    const key = `session:{${sessionId}}:messages`;
    const rawMessages = await this.redis.lrange(key, 0, limit - 1);

    // List 是倒序存储（最新在前），翻转后返回正序
    return rawMessages
      .reverse()
      .map((raw) => {
        try {
          return ConversationMessageSchema.parse(JSON.parse(raw));
        } catch {
          return null;
        }
      })
      .filter((msg): msg is ConversationMessage => msg !== null);
  }

  /**
   * 将 session 数据归档到 Postgres，然后从 Redis 删除
   * 由 session 过期时的回调触发，也可以手动调用（用户主动退出时）
   */
  async archive(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) {
      // session 已经不在 Redis 里了，可能已被归档
      return;
    }

    // 读取完整消息历史（最多50条，实际场景里可能还有更早的消息已经归档过）
    const messages = await this.getMessages(sessionId);

    // 写入 Postgres（同步等待，确保归档成功再删除 Redis 数据）
    await this.pgPool.query(
      `INSERT INTO conversation_archives
         (session_id, tenant_id, user_id, messages, metadata, started_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
       ON CONFLICT (session_id) DO UPDATE
         SET messages = EXCLUDED.messages,
             metadata = EXCLUDED.metadata`,
      [
        session.sessionId,
        session.tenantId,
        session.userId,
        JSON.stringify(messages),
        JSON.stringify(session.metadata),
        session.createdAt,
      ]
    );

    // 归档成功后删除 Redis 数据
    const sessionKey = `session:{${sessionId}}`;
    const messagesKey = `session:{${sessionId}}:messages`;
    const tenantKey = `tenant:{${session.tenantId}}:sessions`;

    await this.redis.del(sessionKey, messagesKey);
    await this.redis.srem(tenantKey, sessionId);

    console.log(`[SessionStore] session 已归档: ${sessionId}`);
  }

  /**
   * 获取某租户的所有活跃 session ID
   */
  async getTenantActiveSessions(tenantId: string): Promise<string[]> {
    const key = `tenant:{${tenantId}}:sessions`;
    return this.redis.smembers(key);
  }

  /**
   * 删除 session（用户主动退出或管理员操作）
   * 会先归档再删除
   */
  async delete(sessionId: string): Promise<void> {
    await this.archive(sessionId);
  }
}

// ==================== 工厂函数 ====================

/**
 * 创建 RedisSessionStore 实例
 * 开发环境直接连接本地 Redis 和 Postgres
 */
export function createSessionStore(
  redisUrl: string,
  pgConnectionString: string
): RedisSessionStore {
  const redis = new Redis(redisUrl, {
    // 连接失败时自动重连
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    },
  });

  const pgPool = new Pool({ connectionString: pgConnectionString });

  return new RedisSessionStore(redis, pgPool);
}
