/**
 * AgentFlow API 服务入口
 *
 * 启动顺序：
 *   1. 加载配置（.env）
 *   2. 初始化外部依赖（Redis、Postgres、LLM Gateway）
 *   3. 装配 Fastify：JWT 认证插件 → 路由
 *   4. 监听端口；接收 SIGTERM 优雅关闭
 */

import 'dotenv/config';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { authPlugin } from './auth.js';
import { chatRoutes } from './routes/chat.js';
import { devRoutes } from './routes/dev.js';
import { LLMGateway } from '@agentflow/llm-gateway';
import { RedisSessionStore, AuditLogger } from '@agentflow/session';

async function main(): Promise<void> {
  const config = loadConfig();

  // ── 1. 外部依赖 ──────────────────────────────────────────────────────────
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });

  // 主业务连接池（读租户配置时用）
  const pgPool = new Pool({ connectionString: config.databaseUrl });

  const gateway = new LLMGateway({
    apiKey: config.anthropicApiKey,
    maxRetries: 3,
  });

  const sessionStore = new RedisSessionStore(redis, {
    ttlSeconds: 1800,
    maxMessages: 50,
  });

  // AuditLogger 自己持有一个独立的 Pool（写日志和读业务数据彼此不抢连接）
  const auditLogger = new AuditLogger(config.databaseUrl);

  // 读电商租户的 system_prompt（init.sql 已插入）
  const tenantSystemPrompt = await loadTenantSystemPrompt(
    pgPool,
    config.demoTenantId
  );

  // ── 2. Fastify 装配 ──────────────────────────────────────────────────────
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  await app.register(authPlugin, { jwtSecret: config.jwtSecret });

  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  await chatRoutes(app, {
    gateway,
    sessionStore,
    auditLogger,
    tenantSystemPrompt,
    defaultTenantId: config.demoTenantId,
    defaultTenantSlug: config.demoTenantSlug,
  });

  await devRoutes(app, {
    jwtSecret: config.jwtSecret,
    demoTenantId: config.demoTenantId,
    demoTenantSlug: config.demoTenantSlug,
  });

  // ── 3. 启动 ──────────────────────────────────────────────────────────────
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      { url: `http://localhost:${config.port}` },
      'AgentFlow API ready'
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ── 4. 优雅关闭 ──────────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，开始优雅关闭...`);
    try {
      await app.close();
      await redis.quit();
      await pgPool.end();
      await auditLogger.close();
    } catch (err) {
      app.log.error({ err }, '关闭过程出错');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * 从 tenants 表读租户定制 system prompt。
 * 找不到时回退到默认提示词，避免本地起服务被数据库状态卡住。
 */
async function loadTenantSystemPrompt(
  pool: Pool,
  tenantId: string
): Promise<string> {
  const fallback =
    '你是【优购电商】的客服助手，专门处理订单查询、退货、物流问题。回复简洁、不超过 150 字。';
  try {
    const result = await pool.query<{ config: { system_prompt?: string } }>(
      'SELECT config FROM tenants WHERE id = $1',
      [tenantId]
    );
    const prompt = result.rows[0]?.config?.system_prompt;
    return prompt && prompt.trim() ? prompt : fallback;
  } catch (err) {
    console.warn(
      '[startup] 读租户 prompt 失败，使用默认值。错误：',
      (err as Error).message
    );
    return fallback;
  }
}

main().catch((err) => {
  console.error('[startup] 致命错误：', err);
  process.exit(1);
});
