/**
 * Redis Circuit Breaker（断路器）
 *
 * 状态机：
 *   Closed   ── 失败次数超阈值 ──>  Open
 *   Open     ── 冷却时间到     ──>  Half-Open
 *   Half-Open── 试探成功 N 次  ──>  Closed
 *   Half-Open── 试探失败       ──>  Open
 *
 * 关键设计：
 *   - 状态保存在 Redis，多 Pod 共享。如果每个 Pod 各自在内存里维护断路器，
 *     单机视角看是 closed，整体却已经把下游打爆——等于没装。
 *   - Half-Open 状态下用 SET NX 抢占"探测名额"，限制同时只有少数请求探测，
 *     不会一窝蜂全冲过去再次把下游打挂。
 *   - 所有读改写都走 Lua 脚本，保证原子性。
 */

import Redis from 'ioredis';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Closed 状态下连续失败多少次进入 Open */
  failureThreshold: number;
  /** Half-Open 状态下连续成功多少次回到 Closed */
  successThreshold: number;
  /** Open 状态持续时间（毫秒），到点后进入 Half-Open */
  openMs: number;
  /** Half-Open 状态下最多同时多少个探测请求 */
  halfOpenProbes: number;
  /** 失败计数窗口（毫秒），超出窗口的失败不计 */
  windowMs: number;
}

/**
 * Lua 脚本：尝试获取一次执行许可
 *
 * KEYS[1] = state key（hash）
 * KEYS[2] = probe counter key（string，TTL）
 * ARGV   = now, failureThreshold, successThreshold, openMs, halfOpenProbes, windowMs
 *
 * Hash 字段：
 *   state          - 'closed' | 'open' | 'half-open'
 *   failures       - 当前窗口内累计失败数
 *   firstFailureAt - 窗口起点时间戳
 *   openedAt       - 进入 Open 状态的时间戳
 *   halfSuccess    - Half-Open 阶段累计成功数
 *
 * 返回数组：[allowed, state]
 *   allowed: 1 允许执行，0 拒绝
 */
const ACQUIRE_SCRIPT = `
  local stateKey = KEYS[1]
  local probeKey = KEYS[2]
  local now = tonumber(ARGV[1])
  local openMs = tonumber(ARGV[4])
  local halfOpenProbes = tonumber(ARGV[5])

  local state = redis.call('HGET', stateKey, 'state') or 'closed'

  if state == 'closed' then
    return {1, 'closed'}
  end

  if state == 'open' then
    local openedAt = tonumber(redis.call('HGET', stateKey, 'openedAt') or '0')
    if now - openedAt >= openMs then
      -- 冷却到期，转入 half-open
      redis.call('HMSET', stateKey, 'state', 'half-open', 'halfSuccess', 0)
      redis.call('DEL', probeKey)
      state = 'half-open'
    else
      return {0, 'open'}
    end
  end

  -- half-open：抢占探测名额
  local probes = tonumber(redis.call('INCR', probeKey))
  if probes == 1 then
    -- 探测计数器自带 TTL，防止泄漏
    redis.call('PEXPIRE', probeKey, openMs)
  end
  if probes > halfOpenProbes then
    return {0, 'half-open'}
  end
  return {1, 'half-open'}
`;

/**
 * Lua 脚本：记录一次成功
 *
 * Closed：重置失败计数
 * Half-Open：累计成功，达到阈值回到 Closed
 */
const SUCCESS_SCRIPT = `
  local stateKey = KEYS[1]
  local probeKey = KEYS[2]
  local successThreshold = tonumber(ARGV[1])

  local state = redis.call('HGET', stateKey, 'state') or 'closed'

  if state == 'half-open' then
    local count = tonumber(redis.call('HINCRBY', stateKey, 'halfSuccess', 1))
    if count >= successThreshold then
      -- 回到 closed 时同步把窗口起点和失败计数清掉，避免上一轮 open 前的陈年统计影响下一轮
      redis.call('HMSET', stateKey, 'state', 'closed',
        'failures', 0, 'halfSuccess', 0, 'firstFailureAt', 0, 'openedAt', 0)
      redis.call('DEL', probeKey)
      return 'closed'
    end
    return 'half-open'
  end

  if state == 'closed' then
    -- closed 下的偶发成功不必清窗口，只把当前累计失败回零
    redis.call('HSET', stateKey, 'failures', 0)
    return 'closed'
  end

  return state
`;

/**
 * Lua 脚本：记录一次失败
 *
 * Closed：窗口内失败次数 +1，超阈值则 Open
 * Half-Open：任意一次失败直接 Open
 */
const FAILURE_SCRIPT = `
  local stateKey = KEYS[1]
  local probeKey = KEYS[2]
  local now = tonumber(ARGV[1])
  local failureThreshold = tonumber(ARGV[2])
  local windowMs = tonumber(ARGV[3])

  local state = redis.call('HGET', stateKey, 'state') or 'closed'

  if state == 'half-open' then
    redis.call('HMSET', stateKey, 'state', 'open', 'openedAt', now, 'halfSuccess', 0)
    redis.call('DEL', probeKey)
    return 'open'
  end

  -- closed 状态：判断窗口，超窗的话计数重置
  local firstAt = tonumber(redis.call('HGET', stateKey, 'firstFailureAt') or '0')
  local failures = tonumber(redis.call('HGET', stateKey, 'failures') or '0')
  if firstAt == 0 or now - firstAt > windowMs then
    failures = 0
    firstAt = now
  end
  failures = failures + 1
  redis.call('HMSET', stateKey, 'failures', failures, 'firstFailureAt', firstAt)

  if failures >= failureThreshold then
    redis.call('HMSET', stateKey, 'state', 'open', 'openedAt', now)
    return 'open'
  end
  return 'closed'
`;

export class CircuitBreakerOpenError extends Error {
  constructor(service: string) {
    super(`circuit breaker open: ${service}`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class RedisCircuitBreaker {
  constructor(
    private readonly redis: Redis,
    /** 服务名，用于命名 key，例如 'anthropic-api' */
    private readonly serviceName: string,
    private readonly options: CircuitBreakerOptions,
  ) {}

  private get stateKey(): string {
    return `cb:${this.serviceName}:state`;
  }

  private get probeKey(): string {
    return `cb:${this.serviceName}:probe`;
  }

  /** 是否允许执行一次下游调用 */
  async canExecute(): Promise<{ allowed: boolean; state: CircuitState }> {
    const result = (await this.redis.eval(
      ACQUIRE_SCRIPT,
      2,
      this.stateKey,
      this.probeKey,
      Date.now(),
      this.options.failureThreshold,
      this.options.successThreshold,
      this.options.openMs,
      this.options.halfOpenProbes,
      this.options.windowMs,
    )) as [number, CircuitState];
    return { allowed: result[0] === 1, state: result[1] };
  }

  async recordSuccess(): Promise<CircuitState> {
    return (await this.redis.eval(
      SUCCESS_SCRIPT,
      2,
      this.stateKey,
      this.probeKey,
      this.options.successThreshold,
    )) as CircuitState;
  }

  async recordFailure(): Promise<CircuitState> {
    return (await this.redis.eval(
      FAILURE_SCRIPT,
      2,
      this.stateKey,
      this.probeKey,
      Date.now(),
      this.options.failureThreshold,
      this.options.windowMs,
    )) as CircuitState;
  }

  /**
   * 包装一次调用：自动 canExecute + recordSuccess/recordFailure
   *
   * 注意：fallback 只在断路打开时触发，调用本身抛错不会走 fallback，
   * 因为那种情况通常需要让调用方感知错误。
   */
  async execute<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    const { allowed } = await this.canExecute();
    if (!allowed) {
      if (fallback) return fallback();
      throw new CircuitBreakerOpenError(this.serviceName);
    }
    try {
      const result = await fn();
      await this.recordSuccess();
      return result;
    } catch (err) {
      await this.recordFailure();
      throw err;
    }
  }

  /** 调试用：当前状态 */
  async getState(): Promise<CircuitState> {
    return ((await this.redis.hget(this.stateKey, 'state')) as CircuitState | null) ?? 'closed';
  }

  /** 测试用：清空状态 */
  async reset(): Promise<void> {
    await this.redis.del(this.stateKey, this.probeKey);
  }
}

// --- 演示：模拟一个不稳定的下游 ---
async function demo(): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  });

  const breaker = new RedisCircuitBreaker(redis, 'demo-llm', {
    failureThreshold: 3,
    successThreshold: 2,
    openMs: 2000,
    halfOpenProbes: 1,
    windowMs: 10_000,
  });

  await breaker.reset();

  // 模拟下游：前 3 次失败把断路器打 open，之后全部成功，
  // 用来演示 closed → open → half-open → closed 的完整闭环
  let callCount = 0;
  const flakyCall = async (): Promise<string> => {
    callCount++;
    if (callCount <= 3) throw new Error('下游 503');
    return 'OK';
  };

  for (let i = 1; i <= 12; i++) {
    try {
      const r = await breaker.execute(flakyCall);
      console.log(`第 ${i} 次：成功，返回 ${r}，状态 ${await breaker.getState()}`);
    } catch (err) {
      const msg = (err as Error).message;
      console.log(`第 ${i} 次：失败 (${msg})，状态 ${await breaker.getState()}`);
    }
    // 第 3 次失败后断路器进入 open，等冷却（openMs=2s）让它转 half-open
    if (i === 3 || i === 7) {
      console.log('等待 2.1 秒，让断路器从 Open 进入 Half-Open...');
      await new Promise((r) => setTimeout(r, 2100));
    }
  }

  await redis.quit();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
