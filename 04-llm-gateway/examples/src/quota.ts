/**
 * QuotaManager：按租户的 Token Budget 控制
 *
 * 使用 Redis Lua 脚本保证"检查 + 扣减"的原子性。
 * 避免高并发下两个请求同时通过检查、合计超出预算的竞态条件。
 *
 * 生产注意：
 * - Lua 脚本在单个 Redis 节点上是原子的
 * - Redis Cluster 模式下，同一 key 的所有操作必须路由到同一节点（通过 hash tag）
 *   例如：quota:{tenantId}:daily:{date}（{tenantId} 作为 hash tag）
 * - 本示例已按此格式设计 key，单机 Redis 直接可用，集群时无需改动 key
 */

import { Redis } from 'ioredis';
import type { TenantQuota, TokenUsage } from './types.js';
import { QuotaExceededError } from './types.js';

// ─── 模拟租户配额数据库（生产中从 DB 读取） ──────────────────────────────────────

/**
 * 租户配额配置（生产中存储在数据库，这里用内存 Map 模拟）
 * key: tenantId, value: TenantQuota
 */
const TENANT_QUOTAS: Map<string, TenantQuota> = new Map([
  [
    'tenant-ecommerce',
    {
      tenantId: 'tenant-ecommerce',
      dailyTokenLimit: 10_000_000,   // 每日 1000 万 tokens（电商大客户）
      monthlyTokenLimit: 200_000_000, // 每月 2 亿 tokens
      requestsPerMinute: 200,
      burstAllowance: 1.5,
    },
  ],
  [
    'tenant-saas',
    {
      tenantId: 'tenant-saas',
      dailyTokenLimit: 2_000_000,    // 每日 200 万 tokens
      monthlyTokenLimit: 40_000_000,
      requestsPerMinute: 60,
      burstAllowance: 1.5,
    },
  ],
  [
    'tenant-finance',
    {
      tenantId: 'tenant-finance',
      dailyTokenLimit: 1_000_000,    // 每日 100 万 tokens（金融客户，合规严格）
      monthlyTokenLimit: 20_000_000,
      requestsPerMinute: 30,
      burstAllowance: 1.0,           // 金融客户不允许超发（burstAllowance = 1.0）
    },
  ],
]);

/** 默认配额（未配置的租户） */
const DEFAULT_QUOTA: TenantQuota = {
  tenantId: 'default',
  dailyTokenLimit: 500_000,
  monthlyTokenLimit: 10_000_000,
  requestsPerMinute: 20,
  burstAllowance: 1.2,
};

/** 获取租户配额配置（生产中从 DB 或 Redis 缓存读取） */
async function getTenantQuota(tenantId: string): Promise<TenantQuota> {
  return TENANT_QUOTAS.get(tenantId) ?? { ...DEFAULT_QUOTA, tenantId };
}

// ─── Redis Lua 脚本 ────────────────────────────────────────────────────────────

/**
 * 原子检查并扣减 Token Budget 的 Lua 脚本
 *
 * KEYS[1]: 配额 key（格式：quota:{tenantId}:daily:{date}）
 * ARGV[1]: 配额上限（dailyTokenLimit）
 * ARGV[2]: 本次预估消耗（estimatedTokens）
 * ARGV[3]: key 的 TTL（秒），首次写入时设置，通常为到明天 00:00 的剩余秒数
 *
 * 返回：[allowed, remaining]
 *   allowed: 1 表示允许（未超限），0 表示拒绝（超限）
 *   remaining: 剩余可用 tokens 数量
 */
const CHECK_AND_CONSUME_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local estimated = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

-- 读取当前已用量（key 不存在时默认 0）
local current = tonumber(redis.call('GET', key) or '0')
local remaining = limit - current

-- 检查预估消耗是否会超出上限
if current + estimated > limit then
  return {0, remaining}
end

-- 原子扣减（INCRBY 返回更新后的值）
local new_value = redis.call('INCRBY', key, estimated)

-- 仅在首次写入时设置 TTL（新 key 的 new_value 等于 estimated）
-- 若 key 已存在，TTL 已经设置，不覆盖
if new_value == estimated then
  redis.call('EXPIRE', key, ttl)
end

return {1, limit - new_value}
`;

/**
 * 修正实际消耗量的 Lua 脚本（多退少补）
 *
 * 调用前预扣了估算量，调用后按实际量修正（adjustment = actual - estimated，可能为负数）
 *
 * KEYS[1]: 配额 key
 * ARGV[1]: 调整量（可正可负）
 */
const ADJUST_QUOTA_SCRIPT = `
local key = KEYS[1]
local adjustment = tonumber(ARGV[1])

-- key 不存在时（极少数情况，如 Redis 重启）不做调整
local exists = redis.call('EXISTS', key)
if exists == 0 then
  return 0
end

redis.call('INCRBY', key, adjustment)
return 1
`;

// ─── QuotaManager ─────────────────────────────────────────────────────────────

/**
 * Token Budget 管理器
 *
 * 调用流程：
 * 1. checkAndConsume(tenantId, estimatedTokens) — 调用 LLM 前，预扣估算量
 * 2. adjust(tenantId, actualUsage, estimatedTokens) — 调用后，按实际量修正
 */
export class QuotaManager {
  constructor(private redis: Redis) {}

  /**
   * 原子检查并预扣 Token Budget
   * 如果预算不足，抛出 QuotaExceededError
   *
   * @param tenantId 租户 ID
   * @param estimatedTokens 预估消耗量（输入 token 数 × 1.5 的保守估计）
   */
  async checkAndConsume(
    tenantId: string,
    estimatedTokens: number
  ): Promise<{ allowed: boolean; remaining: number }> {
    const quota = await getTenantQuota(tenantId);
    const key = this.dailyKey(tenantId);
    const ttl = this.secondsUntilMidnight();

    const result = await this.redis.eval(
      CHECK_AND_CONSUME_SCRIPT,
      1,       // 1 个 KEYS
      key,     // KEYS[1]
      quota.dailyTokenLimit.toString(),   // ARGV[1]
      estimatedTokens.toString(),         // ARGV[2]
      ttl.toString()                      // ARGV[3]
    ) as [number, number];

    const allowed = result[0] === 1;
    const remaining = result[1];

    if (!allowed) {
      throw new QuotaExceededError(tenantId, remaining);
    }

    return { allowed, remaining };
  }

  /**
   * 按实际 token 消耗调整预扣量（多退少补）
   *
   * 例如：预扣了 1500 tokens，实际消耗 1200 tokens，则 adjustment = -300（退回 300）
   *
   * @param tenantId 租户 ID
   * @param actualUsage 实际 token 消耗（来自 LLM 响应的 usage 字段）
   * @param estimatedTokens 之前预扣的估算量
   */
  async adjust(
    tenantId: string,
    actualUsage: TokenUsage,
    estimatedTokens: number
  ): Promise<void> {
    const actualTotal = actualUsage.inputTokens + actualUsage.outputTokens;
    const adjustment = actualTotal - estimatedTokens;

    // 差距在 ±10% 以内时跳过（避免频繁小幅调整，减少 Redis 写入）
    if (Math.abs(adjustment) < estimatedTokens * 0.1) return;

    const key = this.dailyKey(tenantId);

    await this.redis.eval(
      ADJUST_QUOTA_SCRIPT,
      1,
      key,
      adjustment.toString()
    );
  }

  /**
   * 查询租户当日已用量和剩余量（用于监控和告警）
   */
  async getUsage(tenantId: string): Promise<{
    used: number;
    remaining: number;
    limit: number;
    percentUsed: number;
  }> {
    const quota = await getTenantQuota(tenantId);
    const key = this.dailyKey(tenantId);
    const usedStr = await this.redis.get(key);
    const used = parseInt(usedStr ?? '0');
    const remaining = Math.max(0, quota.dailyTokenLimit - used);

    return {
      used,
      remaining,
      limit: quota.dailyTokenLimit,
      percentUsed: (used / quota.dailyTokenLimit) * 100,
    };
  }

  /**
   * 生成当日配额 key
   * 格式：quota:{tenantId}:daily:{YYYY-MM-DD}
   * 注意：{tenantId} 用花括号包裹，作为 Redis Cluster 的 hash tag，
   * 保证同一租户的所有 quota key 路由到同一节点
   */
  private dailyKey(tenantId: string): string {
    const today = new Date().toISOString().slice(0, 10); // "2024-11-11"
    return `quota:{${tenantId}}:daily:${today}`;
  }

  /**
   * 计算到明天 00:00:00 的剩余秒数（作为 key 的 TTL）
   * 确保配额 key 在次日自动清零，不需要手动维护
   */
  private secondsUntilMidnight(): number {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);
  }
}
