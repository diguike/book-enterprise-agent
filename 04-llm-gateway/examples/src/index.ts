/**
 * 运行示例：LLM Gateway 端到端测试
 *
 * 这个脚本模拟一个电商租户的客服会话，演示：
 * 1. 第一次请求：建立 Prompt Cache（cache_creation_input_tokens > 0）
 * 2. 第二次相同前缀的请求：Prompt Cache 命中（cache_read_input_tokens > 0）
 * 3. 语义相似请求：语义缓存命中（不调用 LLM）
 * 4. Token 配额统计：查看当日已用量
 *
 * 运行前准备：
 * 1. 复制 .env.example 为 .env，填入 API Key
 * 2. 启动 Redis Stack：docker run -d -p 6379:6379 redis/redis-stack:latest
 * 3. （可选）启动 PostgreSQL：docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
 * 4. npm install && npm start
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Redis as RedisClient } from 'ioredis';
import { createGatewayFromEnv } from './gateway.js';
import { PromptCacheBuilder } from './prompt-cache.js';
import { calculateCost } from './cost-tracker.js';
import type { LLMGatewayRequest, TokenUsage } from './types.js';

// ─── 加载 .env 文件 ────────────────────────────────────────────────────────────

/**
 * 简单的 .env 文件解析（无需安装 dotenv 包）
 * 生产服务建议用 dotenv 包，这里为了减少依赖手动实现
 */
function loadEnvFile(): void {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.join(__dirname, '..', '.env');

    if (!fs.existsSync(envPath)) {
      console.warn('未找到 .env 文件，使用系统环境变量');
      return;
    }

    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key && !process.env[key]) {
        // 只设置未被环境变量覆盖的值
        process.env[key] = value;
      }
    }
  } catch {
    // 静默忽略，使用系统环境变量
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 格式化 token 数量（带千位分隔符） */
function formatTokens(n: number): string {
  return n.toLocaleString('zh-CN');
}

/** 格式化成本（美元，保留6位小数） */
function formatCost(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

/** 打印一次 LLM 调用的结果摘要 */
function printResult(
  label: string,
  response: {
    content: string;
    model: string;
    provider: string;
    usage: TokenUsage;
    cached: boolean;
    latencyMs: number;
  }
): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📌 ${label}`);
  console.log(`${'─'.repeat(60)}`);

  if (response.cached) {
    console.log('✅ 语义缓存命中，未调用 LLM');
    console.log(`⏱  延迟：${response.latencyMs}ms`);
    console.log(`💬 回复：${response.content.slice(0, 100)}${response.content.length > 100 ? '...' : ''}`);
    return;
  }

  console.log(`🤖 模型：${response.model} (${response.provider})`);
  console.log(`⏱  延迟：${response.latencyMs}ms`);

  const usage = response.usage;
  console.log('\n📊 Token 消耗明细：');
  console.log(`   普通输入     : ${formatTokens(usage.inputTokens)} tokens`);
  console.log(`   缓存写入     : ${formatTokens(usage.cacheCreationTokens ?? 0)} tokens`);
  console.log(`   缓存命中     : ${formatTokens(usage.cacheReadTokens ?? 0)} tokens`);
  console.log(`   输出         : ${formatTokens(usage.outputTokens)} tokens`);

  // 缓存状态说明
  const cacheStatus = PromptCacheBuilder.describeCacheStatus({
    inputTokens: usage.inputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
  });
  const cacheIcon = (usage.cacheReadTokens ?? 0) > 0 ? '🎯' :
    (usage.cacheCreationTokens ?? 0) > 0 ? '🏗 ' : '⚠️ ';
  console.log(`\n${cacheIcon} ${cacheStatus}`);

  const cost = calculateCost(response.model, usage);
  console.log(`\n💰 本次估算成本：${formatCost(cost)}`);
  console.log(`\n💬 回复（前200字）：\n${response.content.slice(0, 200)}`);
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnvFile();

  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('❌ 缺少 ANTHROPIC_API_KEY，请在 .env 文件中设置');
    process.exit(1);
  }

  console.log('🚀 启动 LLM Gateway 示例...\n');

  const gateway = createGatewayFromEnv();

  try {
    await gateway.init();
    console.log('✅ Gateway 初始化完成\n');

    const tenantId = 'tenant-ecommerce';
    const sessionId = `session-${Date.now()}`;

    // ── 测试 1：首次请求（建立 Prompt Cache） ─────────────────────────────────
    const request1: LLMGatewayRequest = {
      tenantId,
      sessionId,
      complexity: 'moderate',
      requiresRealtimeData: false,
      messages: [
        {
          role: 'user',
          content: '你们的退换货政策是什么？退款需要多长时间到账？',
        },
      ],
    };

    console.log('📤 发送请求 1（首次请求，预期建立 Prompt Cache）...');
    const response1 = await gateway.complete(request1);
    printResult('请求 1：首次请求', response1);

    // 等待 1 秒，确保缓存写入完成
    await new Promise<void>(r => setTimeout(r, 1000));

    // ── 测试 2：相同系统 prompt 前缀（预期 Prompt Cache 命中） ────────────────
    const request2: LLMGatewayRequest = {
      tenantId,
      sessionId,
      complexity: 'simple',
      requiresRealtimeData: false,
      messages: [
        {
          role: 'user',
          content: '下单后多久可以申请退款？退款金额退到哪里？',
        },
      ],
    };

    console.log('\n📤 发送请求 2（相同租户，预期 Prompt Cache 命中）...');
    const response2 = await gateway.complete(request2);
    printResult('请求 2：Prompt Cache 命中验证', response2);

    // ── 测试 3：语义相似请求（预期语义缓存命中）──────────────────────────────
    // 注意：仅当语义缓存初始化成功（需要 OpenAI API Key + Redis Stack）且之前的请求已缓存时才会命中
    await new Promise<void>(r => setTimeout(r, 500));

    const request3: LLMGatewayRequest = {
      tenantId,
      sessionId: `${sessionId}-2`, // 不同 sessionId，但问题语义相似
      complexity: 'simple',
      requiresRealtimeData: false,
      messages: [
        {
          role: 'user',
          // 语义上等同于请求 1 的问题，措辞不同
          content: '买东西不想要了可以退吗？退货流程是怎么样的？',
        },
      ],
    };

    console.log('\n📤 发送请求 3（语义相似问题，测试语义缓存）...');
    const response3 = await gateway.complete(request3);
    printResult('请求 3：语义缓存测试', response3);

    // ── 查询配额使用情况 ────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log('📈 配额使用情况');
    console.log(`${'─'.repeat(60)}`);

    // 直接查 Redis 获取今日已用量（演示 key 格式）
    const redis = new RedisClient(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
    const today = new Date().toISOString().slice(0, 10);
    const quotaKey = `quota:{${tenantId}}:daily:${today}`;
    const usedTokens = parseInt((await redis.get(quotaKey)) ?? '0');
    await redis.quit();

    console.log(`租户：${tenantId}`);
    console.log(`今日已用：${formatTokens(usedTokens)} tokens`);
    console.log(`每日上限：${formatTokens(10_000_000)} tokens`);
    console.log(`使用率：${((usedTokens / 10_000_000) * 100).toFixed(4)}%`);

    // 统计本次运行的总成本
    const totalCost = [response1, response2, response3]
      .filter(r => !r.cached)
      .reduce((sum, r) => sum + calculateCost(r.model, r.usage), 0);

    console.log(`\n💰 本次运行总成本（非缓存请求）：${formatCost(totalCost)}`);

    console.log(`\n${'─'.repeat(60)}`);
    console.log('✅ 示例运行完成');
    console.log(`${'─'.repeat(60)}\n`);

  } finally {
    await gateway.close();
  }
}

// 顶层 async 调用（Node.js ESM 支持顶层 await，但用 .catch 更清晰）
main().catch(err => {
  console.error('❌ 运行失败:', err);
  process.exit(1);
});
