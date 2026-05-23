/**
 * Redis 会话存储（MVP 简化版）
 *
 * Key 命名遵循全书统一规则：用 hash tag 保证未来 Redis Cluster 下落同槽：
 *   session:{sessionId}              → 完整 SessionState（JSON）
 *
 * MVP 只保留单 key 存全部状态，足够"查订单"场景使用；
 * 第 7 章会拆分为 messages list、metadata hash 等多 key 结构。
 */

import { Redis } from 'ioredis';

/** 会话内的一条消息（与 LLM Gateway 的格式对齐） */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 创建时间（Unix 毫秒） */
  timestamp: number;
}

/** Redis 中保存的会话状态 */
export interface SessionState {
  sessionId: string;
  tenantId: string;
  userId: string;
  messages: ConversationMessage[];
  createdAt: number;
  lastActiveAt: number;
}

/** 会话存储构造参数 */
export interface RedisSessionStoreOptions {
  /** Session 滑动过期时间（秒），默认 30 分钟 */
  ttlSeconds?: number;
  /** 单 session 保留的消息条数上限，防止 key 过大；默认 50 */
  maxMessages?: number;
}

const DEFAULT_TTL_SECONDS = 1800;
const DEFAULT_MAX_MESSAGES = 50;

export class RedisSessionStore {
  private readonly ttlSeconds: number;
  private readonly maxMessages: number;

  constructor(
    private readonly redis: Redis,
    options: RedisSessionStoreOptions = {}
  ) {
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  }

  /** 构造 Redis key，hash tag 包住 sessionId 以便 Cluster 模式下落同槽 */
  private key(sessionId: string): string {
    return `session:{${sessionId}}`;
  }

  /**
   * 读取会话；每次读取都会刷新 TTL（滑动过期）。
   * 找不到或解析失败返回 null，调用方负责创建新 session。
   */
  async get(sessionId: string): Promise<SessionState | null> {
    const raw = await this.redis.get(this.key(sessionId));
    if (!raw) return null;

    // 滑动过期：读到了就续期
    await this.redis.expire(this.key(sessionId), this.ttlSeconds);

    try {
      return JSON.parse(raw) as SessionState;
    } catch (err) {
      // 数据损坏时不抛错，返回 null 让调用方重建 session
      console.error(`[RedisSessionStore] 解析 session 失败 ${sessionId}:`, err);
      return null;
    }
  }

  /** 创建一个新会话并立即写入 Redis */
  async create(params: {
    sessionId: string;
    tenantId: string;
    userId: string;
  }): Promise<SessionState> {
    const now = Date.now();
    const state: SessionState = {
      sessionId: params.sessionId,
      tenantId: params.tenantId,
      userId: params.userId,
      messages: [],
      createdAt: now,
      lastActiveAt: now,
    };
    await this.save(state);
    return state;
  }

  /** 覆盖式保存整个 SessionState（小数据量场景 OK） */
  async save(state: SessionState): Promise<void> {
    state.lastActiveAt = Date.now();

    // 超过 maxMessages 时，按时间截断保留最新的 N 条
    // 注意：生产环境会做摘要压缩而非简单丢弃，见第 7 章
    if (state.messages.length > this.maxMessages) {
      state.messages = state.messages.slice(-this.maxMessages);
    }

    await this.redis.set(
      this.key(state.sessionId),
      JSON.stringify(state),
      'EX',
      this.ttlSeconds
    );
  }

  /** 追加一条消息（读 → 改 → 写，简单实现，MVP 够用） */
  async appendMessage(
    sessionId: string,
    message: ConversationMessage
  ): Promise<SessionState | null> {
    const state = await this.get(sessionId);
    if (!state) return null;
    state.messages.push(message);
    await this.save(state);
    return state;
  }

  /** 删除会话（用户主动结束或测试清理时调用） */
  async delete(sessionId: string): Promise<void> {
    await this.redis.del(this.key(sessionId));
  }
}
