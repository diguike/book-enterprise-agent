/**
 * 第8章：多租户隔离演示
 *
 * 场景：模拟三租户并发请求，演示限流、配额、隔离的实际效果
 *
 *   租户 A（pro）   ：正常流量，应该全部通过
 *   租户 B（starter）：突发批量请求，应该被速率限流挡住一部分
 *   租户 C（enterprise）：单次大请求 + 持续耗 token，应该触发总量配额拒绝
 *
 * 关键观察点：
 *   1. 租户 B 的限流不会影响租户 A 的请求通过
 *   2. 租户 C 耗尽 token 后被拒绝，但租户 A、B 的 token 池独立
 *   3. 所有计数都在 Redis 中按 {tenantId} 隔离
 *
 * 运行：
 *   先启动 Redis（docker run -p 6379:6379 redis:7-alpine）
 *   然后：npm run start
 */

import Redis from 'ioredis';
import { QuotaManager } from './quota-manager.js';
import {
  PLAN_QUOTAS,
  TenantPlan,
  TenantQuota,
  TokenUsage,
} from './types.js';

// ─── 测试租户定义 ────────────────────────────────────────────────────────────

const TENANTS: Array<{ id: string; name: string; plan: TenantPlan }> = [
  { id: 'tenant-a-uuid-0000-0000-000000000001', name: '电商公司 A', plan: 'pro' },
  { id: 'tenant-b-uuid-0000-0000-000000000002', name: 'SaaS 公司 B', plan: 'starter' },
  { id: 'tenant-c-uuid-0000-0000-000000000003', name: '金融机构 C', plan: 'enterprise' },
];

// 演示用：把 starter 的 RPM 降到 5，方便快速看到限流效果
const DEMO_QUOTAS: Record<string, TenantQuota> = Object.fromEntries(
  TENANTS.map((t) => {
    const base = PLAN_QUOTAS[t.plan];
    const quota: TenantQuota = {
      tenantId: t.id,
      plan: t.plan,
      ...base,
      // 演示用：缩小 starter 配额，便于看到拒绝效果
      ...(t.plan === 'starter' ? { requestsPerMinute: 5, dailyTokenLimit: 50_000 } : {}),
      // 演示用：把 C 的日 token 降低到 100k，快速触发上限
      ...(t.plan === 'enterprise' ? { dailyTokenLimit: 100_000 } : {}),
    };
    return [t.id, quota];
  }),
);

// ─── 演示场景 ────────────────────────────────────────────────────────────────

interface DemoResult {
  tenant: string;
  scenario: string;
  passed: number;
  blockedByRate: number;
  blockedByQuota: number;
  totalTokens: number;
}

/**
 * 单租户的请求模拟
 *
 * @param burstSize        一次性发起的请求数
 * @param tokensPerRequest 每次请求消耗的 token 数
 */
async function simulateTenantWorkload(
  quotaManager: QuotaManager,
  tenant: { id: string; name: string; plan: TenantPlan },
  burstSize: number,
  tokensPerRequest: number,
): Promise<DemoResult> {
  const quota = DEMO_QUOTAS[tenant.id]!;

  let passed = 0;
  let blockedByRate = 0;
  let blockedByQuota = 0;
  let totalTokens = 0;

  // 并发发起 burstSize 个请求
  const promises = Array.from({ length: burstSize }, async (_, i) => {
    // 1. 速率限流检查
    const rateResult = await quotaManager.checkRateLimit(quota.tenantId, quota.requestsPerMinute);
    if (!rateResult.allowed) {
      blockedByRate += 1;
      return;
    }

    // 2. 总量配额检查
    const quotaResult = await quotaManager.checkTokenQuota(quota);
    if (!quotaResult.allowed) {
      blockedByQuota += 1;
      return;
    }

    // 3. 单次请求 token 防滥用检查
    if (quotaManager.isSingleRequestExcessive(tokensPerRequest)) {
      blockedByQuota += 1;
      return;
    }

    // 模拟 LLM 调用耗时（也让限流的滑动窗口推进）
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 50));

    // 4. 请求完成后记录实际用量
    const usage: TokenUsage = {
      inputTokens: Math.floor(tokensPerRequest * 0.7),
      outputTokens: Math.floor(tokensPerRequest * 0.3),
      cacheHitTokens: 0,
      model: 'claude-sonnet-4-5',
    };
    await quotaManager.recordUsage(quota.tenantId, usage);

    passed += 1;
    totalTokens += tokensPerRequest;
    void i;
  });

  await Promise.all(promises);

  return {
    tenant: tenant.name,
    scenario: `burst=${burstSize}, tokens/req=${tokensPerRequest}`,
    passed,
    blockedByRate,
    blockedByQuota,
    totalTokens,
  };
}

// ─── Redis 清理 ─────────────────────────────────────────────────────────────

async function resetTenantState(redis: Redis, tenantId: string): Promise<void> {
  // 演示开始前清空该租户在 Redis 中的所有状态
  // 生产中绝对不要这么干——这里只是为了演示重复运行
  const stream = redis.scanStream({ match: `*{${tenantId}}*`, count: 100 });
  for await (const keys of stream) {
    if (keys.length > 0) {
      await redis.del(...(keys as string[]));
    }
  }
}

// ─── 主程序 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    lazyConnect: false,
  });

  redis.on('error', (err) => console.error('[Redis] error:', err.message));

  const quotaManager = new QuotaManager(redis);

  console.log('━━━ AgentFlow 多租户隔离演示 ━━━\n');

  // 演示前清空旧状态
  for (const t of TENANTS) {
    await resetTenantState(redis, t.id);
  }

  console.log('场景 1：三租户并发发起常规流量');
  console.log('  租户 A：8 个请求，每次 2000 token');
  console.log('  租户 B：8 个请求，每次 2000 token（starter 限 5 RPM，会被限流）');
  console.log('  租户 C：8 个请求，每次 2000 token\n');

  // 关键：三个租户并发执行，不串行
  // 这样能真正看出限流是按租户隔离的
  const results1 = await Promise.all([
    simulateTenantWorkload(quotaManager, TENANTS[0]!, 8, 2000),
    simulateTenantWorkload(quotaManager, TENANTS[1]!, 8, 2000),
    simulateTenantWorkload(quotaManager, TENANTS[2]!, 8, 2000),
  ]);

  printResults(results1);

  console.log('\n场景 2：租户 C 单次请求 token 超限（防滥用）');
  const abuseResult = await simulateTenantWorkload(quotaManager, TENANTS[2]!, 3, 200_000);
  printResults([abuseResult]);

  console.log('\n场景 3：租户 C 持续消耗，触发日 token 上限');
  // 演示配额：C 的 dailyTokenLimit 被设为 100k，10 次 12k 的请求会触碰 90% buffer
  const consumeResult = await simulateTenantWorkload(quotaManager, TENANTS[2]!, 10, 12_000);
  printResults([consumeResult]);

  // 异常检测
  console.log('\n场景 4：异常用量检测（租户 C）');
  const anomaly = await quotaManager.detectAnomaly(TENANTS[2]!.id);
  console.log(
    `  最近 15 分钟：${anomaly.recent} tokens | 基线：${anomaly.baseline} tokens | ` +
    `${anomaly.anomaly ? '异常告警' : '正常'}`,
  );

  await redis.quit();
}

function printResults(results: DemoResult[]): void {
  const sep = '─'.repeat(70);
  console.log(sep);
  for (const r of results) {
    console.log(`  ${r.tenant} [${r.scenario}]`);
    console.log(
      `    通过=${r.passed}  限流拒绝=${r.blockedByRate}  配额拒绝=${r.blockedByQuota}  ` +
      `总消耗=${r.totalTokens} tokens`,
    );
  }
  console.log(sep);
}

main().catch((err) => {
  console.error('演示失败：', err);
  process.exit(1);
});
