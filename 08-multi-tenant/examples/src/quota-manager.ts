/**
 * 第8章：租户配额管理
 *
 * 职责：
 *   1. 速率限流（requests/min）：滑动窗口算法
 *   2. 总量配额（日/月 token）：原子计数器 + TTL
 *   3. 异常用量检测：与历史均值比较
 *
 * 所有状态都存 Redis，不放进程内——这样保证多 Worker 看到一致视图。
 *
 * 单机 vs 生产差距：
 *   - 单机用单节点 Redis，所有 key 加 {tenantId} hash tag 保持兼容性
 *   - 生产用 Redis Cluster，hash tag 保证同租户 key 落同一 slot，
 *     可以在 Lua 脚本里原子地读 + 比较 + 自增
 */

import type { Redis } from 'ioredis';
import type {
  QuotaCheckResult,
  RateLimitResult,
  TenantQuota,
  TokenUsage,
} from './types.js';

// ─── Redis Key 命名规范 ───────────────────────────────────────────────────────
//
// hash tag {tenantId} 把同租户的所有 key 锁定到同一个 slot
// 限流用滑动窗口的两个相邻分钟桶：ratelimit:{tenantId}:<minuteEpoch>
// 总量用日/月计数器：tokens:daily:{tenantId}:YYYY-MM-DD

const RATELIMIT_PREFIX = 'ratelimit';
const TOKEN_DAILY_PREFIX = 'tokens:daily';
const TOKEN_MONTHLY_PREFIX = 'tokens:monthly';
const REQUEST_DAILY_PREFIX = 'requests:daily';

// 异常用量检测的历史窗口
const USAGE_HISTORY_PREFIX = 'usage:history';
const ANOMALY_THRESHOLD_RATIO = 3;             // 15 分钟用量超过 7 日均值 3 倍即告警
const ANOMALY_WINDOW_MINUTES = 15;
const SINGLE_REQUEST_TOKEN_LIMIT = 100_000;    // 单次请求 token 上限

// ─── 滑动窗口限流的 Lua 脚本 ──────────────────────────────────────────────────
//
// 取当前分钟和上一分钟的计数，按时间加权得到"过去 60 秒"的近似计数
// 这是经典的 Token Bucket 替代方案，精度足够限流场景
const SLIDING_WINDOW_SCRIPT = `
local current_key = KEYS[1]
local previous_key = KEYS[2]
local limit = tonumber(ARGV[1])
local elapsed_ratio = tonumber(ARGV[2])   -- 当前分钟已过比例（0-1）

local current = tonumber(redis.call('GET', current_key) or '0')
local previous = tonumber(redis.call('GET', previous_key) or '0')

-- 滑动窗口估算：上一分钟剩余权重 + 当前分钟实际值
local estimated = math.floor(previous * (1 - elapsed_ratio)) + current

if estimated >= limit then
  return {0, estimated}
end

redis.call('INCR', current_key)
redis.call('EXPIRE', current_key, 120)
return {1, estimated + 1}
`;

export class QuotaManager {
  constructor(private readonly redis: Redis) {}

  // ─── 速率限流：每分钟请求数 ─────────────────────────────────────────────────

  /**
   * 检查并扣减请求速率配额
   *
   * 使用滑动窗口算法（不是固定窗口）：把当前分钟和上一分钟的计数按时间比例加权，
   * 避免"窗口边界"被突发流量打穿（固定窗口允许 2x 限额在边界附近通过）。
   */
  async checkRateLimit(tenantId: string, limitPerMinute: number): Promise<RateLimitResult> {
    const nowMs = Date.now();
    const currentMinute = Math.floor(nowMs / 60_000);
    const elapsedRatio = (nowMs % 60_000) / 60_000;

    const currentKey = `${RATELIMIT_PREFIX}:{${tenantId}}:${currentMinute}`;
    const previousKey = `${RATELIMIT_PREFIX}:{${tenantId}}:${currentMinute - 1}`;

    const result = (await this.redis.eval(
      SLIDING_WINDOW_SCRIPT,
      2,
      currentKey,
      previousKey,
      limitPerMinute.toString(),
      elapsedRatio.toString(),
    )) as [number, number];

    const [allowed, estimated] = result;

    if (allowed === 1) {
      return { allowed: true, limit: limitPerMinute };
    }

    // 推算需要等待多久才会有 1 个名额可用
    // 简化：等到下一分钟 + 一些缓冲
    const retryAfter = Math.ceil(60 * (1 - elapsedRatio)) + 1;
    return {
      allowed: false,
      limit: limitPerMinute,
      retryAfter,
    };
  }

  // ─── 总量配额：日/月 token ─────────────────────────────────────────────────

  /**
   * 请求开始前的总量配额检查
   *
   * 注意这里只读不扣——实际扣减发生在请求结束后的 recordUsage()。
   * 理由：LLM 请求的实际 token 消耗只有响应回来才知道，预估扣减会导致
   * 大量"假扣减"和回滚，影响计数准确性。
   *
   * 缺点：高并发下可能轻微超额（多个请求同时通过预检查）。
   * 缓解：预检查留 10% buffer。
   */
  async checkTokenQuota(quota: TenantQuota): Promise<QuotaCheckResult> {
    const dailyKey = this.dailyTokenKey(quota.tenantId);
    const monthlyKey = this.monthlyTokenKey(quota.tenantId);
    const requestsDailyKey = this.dailyRequestsKey(quota.tenantId);

    // 用 MGET 一次拿三个值
    const values = await this.redis.mget(dailyKey, monthlyKey, requestsDailyKey);
    const usedDailyTokens = parseInt(values[0] ?? '0', 10);
    const usedMonthlyTokens = parseInt(values[1] ?? '0', 10);
    const usedDailyRequests = parseInt(values[2] ?? '0', 10);

    // 预留 10% buffer，避免高并发下因预检查通过但实际超额
    const dailyBuffer = Math.floor(quota.dailyTokenLimit * 0.9);
    const monthlyBuffer = Math.floor(quota.monthlyTokenLimit * 0.9);

    if (usedDailyTokens >= dailyBuffer) {
      return {
        allowed: false,
        used: usedDailyTokens,
        limit: quota.dailyTokenLimit,
        remaining: 0,
        reason: 'daily_token_limit_exceeded',
        resetAt: this.nextMidnight(),
      };
    }

    if (usedMonthlyTokens >= monthlyBuffer) {
      return {
        allowed: false,
        used: usedMonthlyTokens,
        limit: quota.monthlyTokenLimit,
        remaining: 0,
        reason: 'monthly_token_limit_exceeded',
        resetAt: this.nextMonthStart(),
      };
    }

    if (usedDailyRequests >= quota.requestsPerDay) {
      return {
        allowed: false,
        used: usedDailyRequests,
        limit: quota.requestsPerDay,
        remaining: 0,
        reason: 'daily_request_limit_exceeded',
        resetAt: this.nextMidnight(),
      };
    }

    return {
      allowed: true,
      used: usedDailyTokens,
      limit: quota.dailyTokenLimit,
      remaining: quota.dailyTokenLimit - usedDailyTokens,
    };
  }

  /**
   * 单次请求 token 超限检查（防滥用）
   * 通常请求几千 token，超过 10 万说明 prompt 异常，直接拒绝
   */
  isSingleRequestExcessive(estimatedTokens: number): boolean {
    return estimatedTokens > SINGLE_REQUEST_TOKEN_LIMIT;
  }

  /**
   * 请求完成后的实际用量记录
   *
   * 在这里原子地：
   *   1. 累加日/月 token 计数
   *   2. 累加日请求数计数
   *   3. 写入 15 分钟用量直方图（用于异常检测）
   */
  async recordUsage(tenantId: string, usage: TokenUsage): Promise<void> {
    const totalTokens = usage.inputTokens + usage.outputTokens;
    const dailyKey = this.dailyTokenKey(tenantId);
    const monthlyKey = this.monthlyTokenKey(tenantId);
    const requestsDailyKey = this.dailyRequestsKey(tenantId);
    const usageHistoryKey = this.usageHistoryKey(tenantId);

    // pipeline 减少 RTT
    // 注意：所有 key 共享 {tenantId} hash tag，cluster 模式下属于同一 slot，
    // pipeline 不会跨 slot
    const pipeline = this.redis.pipeline();

    pipeline.incrby(dailyKey, totalTokens);
    pipeline.expire(dailyKey, 60 * 60 * 25);     // 25 小时，跨自然日有缓冲

    pipeline.incrby(monthlyKey, totalTokens);
    pipeline.expire(monthlyKey, 60 * 60 * 24 * 32);  // 32 天

    pipeline.incr(requestsDailyKey);
    pipeline.expire(requestsDailyKey, 60 * 60 * 25);

    // 写入 1 分钟粒度的使用桶，保留 7 天用于异常检测
    const minuteBucket = Math.floor(Date.now() / 60_000);
    pipeline.hincrby(usageHistoryKey, minuteBucket.toString(), totalTokens);
    pipeline.expire(usageHistoryKey, 60 * 60 * 24 * 7);

    await pipeline.exec();
  }

  // ─── 异常用量检测 ────────────────────────────────────────────────────────────

  /**
   * 检查最近 15 分钟用量是否异常飙升
   *
   * 规则：最近 15 分钟用量 > 过去 7 天同时段平均用量 * 3 → 告警
   * 这里只做检测，触发动作（告警/熔断）由调用方决定
   */
  async detectAnomaly(tenantId: string): Promise<{ anomaly: boolean; recent: number; baseline: number }> {
    const usageHistoryKey = this.usageHistoryKey(tenantId);
    const now = Math.floor(Date.now() / 60_000);

    // 取最近 15 分钟桶
    const recentBuckets = Array.from({ length: ANOMALY_WINDOW_MINUTES }, (_, i) => (now - i).toString());
    const recentValues = await this.redis.hmget(usageHistoryKey, ...recentBuckets);
    const recent = recentValues.reduce((sum, v) => sum + parseInt(v ?? '0', 10), 0);

    // 基线：过去 7 天的"每 15 分钟平均用量"，作为本次 15 分钟窗口的预期值
    //
    // 注意不能用 (historyTotal / historyMinutes) * 15：
    //   historyMinutes 是 hash 里"有记录的分钟数"，而非"实际经过的分钟数"。
    //   对于稀疏使用的租户（每天只用几分钟），这个比值会严重偏高，导致基线虚高，
    //   反而漏报真正的异常。
    //
    // 正确做法是除以"过去 7 天的实际经过分钟数"——也就是 oldest bucket 到 now 的跨度，
    // 上限取 7*24*60。
    const allHistory = await this.redis.hgetall(usageHistoryKey);
    const historyTotal = Object.values(allHistory).reduce((sum, v) => sum + parseInt(v, 10), 0);
    const bucketMinutes = Object.keys(allHistory).map((k) => parseInt(k, 10));
    let baseline = 0;
    if (bucketMinutes.length > 0) {
      const oldest = Math.min(...bucketMinutes);
      const elapsedMinutes = Math.max(1, Math.min(now - oldest + 1, 7 * 24 * 60));
      baseline = (historyTotal / elapsedMinutes) * ANOMALY_WINDOW_MINUTES;
    }

    return {
      anomaly: baseline > 0 && recent > baseline * ANOMALY_THRESHOLD_RATIO,
      recent,
      baseline: Math.floor(baseline),
    };
  }

  // ─── 内部工具方法 ────────────────────────────────────────────────────────────

  private dailyTokenKey(tenantId: string): string {
    const day = new Date().toISOString().slice(0, 10);
    return `${TOKEN_DAILY_PREFIX}:{${tenantId}}:${day}`;
  }

  private monthlyTokenKey(tenantId: string): string {
    const month = new Date().toISOString().slice(0, 7);
    return `${TOKEN_MONTHLY_PREFIX}:{${tenantId}}:${month}`;
  }

  private dailyRequestsKey(tenantId: string): string {
    const day = new Date().toISOString().slice(0, 10);
    return `${REQUEST_DAILY_PREFIX}:{${tenantId}}:${day}`;
  }

  private usageHistoryKey(tenantId: string): string {
    return `${USAGE_HISTORY_PREFIX}:{${tenantId}}`;
  }

  private nextMidnight(): Date {
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0);
    return next;
  }

  private nextMonthStart(): Date {
    const next = new Date();
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
    next.setUTCHours(0, 0, 0, 0);
    return next;
  }
}
