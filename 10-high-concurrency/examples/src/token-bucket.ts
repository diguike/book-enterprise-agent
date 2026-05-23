/**
 * 令牌桶算法（Token Bucket）
 *
 * 工作原理：
 *   - 桶有最大容量 capacity
 *   - 以固定速率 refillRate 往桶里补充 token
 *   - 每次请求消耗若干 token，桶里没有就拒绝
 *   - 桶满后多出的 token 丢弃
 *
 * 适用场景：允许短时突发，但长期速率受限。例如 AgentFlow 单租户 LLM 调用频率，
 * 桶容量给到 60、补充速率 10/s，意味着平时最高 10 QPS，但允许瞬间冲到 60。
 *
 * 单机演示版本，状态在内存里。生产中多 Pod 部署必须放到 Redis，用 Lua 脚本
 * 保证 refill + consume 的原子性，本章 10.2 节有完整 Redis 版本。
 */

import Redis from 'ioredis';

/** 内存版令牌桶，仅用于单进程演示 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    /** 桶容量，决定最大突发量 */
    private readonly capacity: number,
    /** 每秒补充的 token 数 */
    private readonly refillRate: number,
  ) {
    if (capacity <= 0 || refillRate <= 0) {
      throw new Error('capacity 和 refillRate 必须为正数');
    }
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * 尝试消费 count 个 token
   * @returns 成功返回 true，桶里 token 不够返回 false
   */
  tryConsume(count: number = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** 当前剩余 token 数，调试用 */
  get currentTokens(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    // 按经过的秒数补充 token，上限是 capacity
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRate);
    this.lastRefill = now;
  }
}

/**
 * Redis 版令牌桶，多 Pod 共享状态
 *
 * 用 Lua 脚本把 refill + consume 做成原子操作，避免两次 GET/SET 之间被其他
 * Pod 抢走 token 导致超发。
 */
export class RedisTokenBucket {
  // Lua 脚本：参数依次是 capacity、refillRate（每秒）、now（毫秒）、需要消费的 count
  // 返回 1 表示成功，0 表示失败
  private static readonly SCRIPT = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local count = tonumber(ARGV[4])

    local data = redis.call('HMGET', key, 'tokens', 'ts')
    local tokens = tonumber(data[1])
    local ts = tonumber(data[2])

    if tokens == nil then
      tokens = capacity
      ts = now
    end

    -- 按时间差补充 token
    local elapsed = math.max(0, now - ts) / 1000
    tokens = math.min(capacity, tokens + elapsed * rate)

    local allowed = 0
    if tokens >= count then
      tokens = tokens - count
      allowed = 1
    end

    redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
    -- 设置 TTL，长时间不用的 key 自动回收
    redis.call('PEXPIRE', key, math.ceil(capacity / rate * 1000) + 10000)

    return allowed
  `;

  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
    private readonly capacity: number,
    private readonly refillRate: number,
  ) {}

  async tryConsume(scope: string, count: number = 1): Promise<boolean> {
    const key = `${this.keyPrefix}:${scope}`;
    const result = (await this.redis.eval(
      RedisTokenBucket.SCRIPT,
      1,
      key,
      this.capacity,
      this.refillRate,
      Date.now(),
      count,
    )) as number;
    return result === 1;
  }
}

// --- 演示 ---
async function demo(): Promise<void> {
  console.log('=== 内存版令牌桶演示 ===');
  // 桶容量 5，每秒补 2 个
  const bucket = new TokenBucket(5, 2);

  // 立即连续消费 7 次，前 5 次成功后 2 次失败
  for (let i = 1; i <= 7; i++) {
    const ok = bucket.tryConsume();
    console.log(`第 ${i} 次请求：${ok ? '通过' : '拒绝'}，剩余 ${bucket.currentTokens.toFixed(2)}`);
  }

  // 等 1.5 秒，应该补 3 个 token
  console.log('等待 1.5 秒...');
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`恢复后剩余：${bucket.currentTokens.toFixed(2)}`);

  for (let i = 1; i <= 4; i++) {
    const ok = bucket.tryConsume();
    console.log(`恢复后第 ${i} 次请求：${ok ? '通过' : '拒绝'}`);
  }
}

// 直接 tsx 运行时启动演示
if (import.meta.url === `file://${process.argv[1]}`) {
  demo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
