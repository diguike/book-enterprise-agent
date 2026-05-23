/**
 * AgentFlow 环境验证 Demo
 *
 * 执行四步验证：
 *   1. 连接 PostgreSQL，查询 tenants 表并验证 pgvector 扩展
 *   2. 连接 Redis，写入并读取一个 key（遵循 tenant_id:resource:id 命名规范）
 *   3. 调用 Anthropic API，发送一条消息并取得响应
 *   4. 把对话记录写入 PostgreSQL llm_audit_logs 表
 *
 * 运行前提：
 *   - docker compose up -d 已启动所有服务
 *   - 设置环境变量 ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import { Redis } from 'ioredis';
import pg from 'pg';

const { Pool } = pg;

// ── 环境变量 ───────────────────────────────────────────────────────────────

// ANTHROPIC_API_KEY 必须通过环境变量注入，禁止硬编码
const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY'];
if (!ANTHROPIC_API_KEY) {
  console.error('错误：缺少环境变量 ANTHROPIC_API_KEY');
  console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
  process.exit(1);
}

const PG_CONNECTION_STRING =
  process.env['DATABASE_URL'] ??
  'postgresql://agentflow:agentflow_dev_password@localhost:5432/agentflow';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

// ── 类型定义 ───────────────────────────────────────────────────────────────

interface Tenant {
  id: string;
  slug: string;
  name: string;
  config: Record<string, unknown>;
  status: string;
}

interface ConversationRecord {
  tenantId: string;
  userId: string;
  userMessage: string;
  assistantMessage: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// ── Step 1：PostgreSQL 连接验证 ────────────────────────────────────────────

async function verifyPostgres(pool: pg.Pool): Promise<Tenant[]> {
  console.log('\n[Step 1] 验证 PostgreSQL 连接...');

  // 测试基本连接
  const { rows: versionRows } = await pool.query<{ version: string }>(
    'SELECT version()'
  );
  console.log(
    '  PostgreSQL 版本：',
    versionRows[0]?.version?.split(' ').slice(0, 2).join(' ')
  );

  // 验证 pgvector 扩展已安装
  const { rows: extRows } = await pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname = 'vector'`
  );
  if (extRows.length === 0) {
    throw new Error('pgvector 扩展未安装，请检查 init.sql 是否执行成功');
  }
  console.log('  pgvector 扩展：已安装');

  // 查询初始化的测试租户
  const { rows: tenants } = await pool.query<Tenant>(
    'SELECT id, slug, name, config, status FROM tenants ORDER BY name'
  );
  console.log(`  已加载租户：${tenants.map((t) => t.slug).join(', ')}`);

  return tenants;
}

// ── Step 2：Redis 连接验证 ─────────────────────────────────────────────────

async function verifyRedis(redis: Redis, tenant: Tenant): Promise<void> {
  console.log('\n[Step 2] 验证 Redis 连接...');

  // 测试基本 PING
  const pong = await redis.ping();
  console.log('  Redis PING：', pong);

  // ─────────────────────────────────────────────────────────────────────────
  // 重要：key 命名遵循 {tenant_id}:{resource_type}:{id} 格式
  //
  // 正确示例：tenant-ecommerce:session:abc123
  // 错误示例：session:abc123（没有 tenant_id 前缀）
  //
  // 生产注意：Redis Cluster 按 key 的 hash slot 分片。
  //   如果 key 没有统一前缀，同一个租户的数据会散落在不同 slot，
  //   无法用 MGET/pipeline 批量获取，也无法做租户级 SCAN。
  //   迁移到 Cluster 时改 key 命名是一项很大的破坏性变更。
  // ─────────────────────────────────────────────────────────────────────────
  const sessionKey = `${tenant.slug}:session:demo-session-001`;
  const sessionData = {
    userId: 'user-demo-001',
    startedAt: new Date().toISOString(),
    status: 'active',
  };

  // 写入 session 数据，TTL 1 小时
  await redis.set(sessionKey, JSON.stringify(sessionData), 'EX', 3600);
  console.log(`  写入 key：${sessionKey}`);

  // 读回并验证
  const raw = await redis.get(sessionKey);
  if (!raw) {
    throw new Error(`Redis key ${sessionKey} 写入后读取失败`);
  }
  const parsed = JSON.parse(raw) as typeof sessionData;
  console.log(`  读取成功：userId = ${parsed.userId}`);

  // ─────────────────────────────────────────────────────────────────────────
  // 演示：circuit breaker 状态也必须存 Redis，不能存内存
  //
  // 错误做法（单机 demo 能跑，两个 Pod 就失效）：
  //   let failureCount = 0;  // 内存变量
  //
  // 正确做法：用 Redis 原子计数器
  // ─────────────────────────────────────────────────────────────────────────
  const circuitKey = `${tenant.slug}:circuit-breaker:anthropic-api`;
  await redis.set(circuitKey, '0', 'EX', 60); // 60 秒窗口
  console.log(`  Circuit breaker 状态写入 Redis：${circuitKey}`);
}

// ── Step 3：Anthropic API 调用 ─────────────────────────────────────────────

async function callAnthropicApi(
  tenant: Tenant
): Promise<{ userMessage: string; assistantMessage: string; usage: Anthropic.Usage; model: string }> {
  console.log('\n[Step 3] 调用 Anthropic API...');

  // 直接使用 Anthropic SDK，不经过中间层
  // 生产注意：第4章会引入 LLM Gateway 做路由和缓存，
  //   但底层仍然是这个 SDK，此处直接调用便于理解
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const userMessage = '用一句话介绍你自己，不超过30个字。';
  console.log(`  用户消息：${userMessage}`);

  const response = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 256,
    system: `你是 AgentFlow 智能客服平台的助手，服务于租户"${tenant.name}"。回答简洁、专业，不要有多余的客套话。`,
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  });

  // 提取文本响应（response.content 是 ContentBlock 数组，过滤出 text 类型）
  const assistantMessage = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  console.log(`  助手响应：${assistantMessage}`);
  console.log(
    `  Token 用量：输入 ${response.usage.input_tokens}，输出 ${response.usage.output_tokens}`
  );

  return {
    userMessage,
    assistantMessage,
    usage: response.usage,
    model: response.model,
  };
}

// ── Step 4：持久化对话记录 ─────────────────────────────────────────────────

async function persistConversation(
  pool: pg.Pool,
  record: ConversationRecord
): Promise<void> {
  console.log('\n[Step 4] 写入对话记录到 PostgreSQL...');

  // 先创建一条 session 记录
  const { rows: sessionRows } = await pool.query<{ id: string }>(
    `INSERT INTO sessions (tenant_id, user_id, status, messages)
     VALUES ($1, $2, 'completed', $3)
     RETURNING id`,
    [
      record.tenantId,
      record.userId,
      JSON.stringify([
        { role: 'user', content: record.userMessage },
        { role: 'assistant', content: record.assistantMessage },
      ]),
    ]
  );

  const sessionId = sessionRows[0]?.id;
  if (!sessionId) {
    throw new Error('创建 session 失败，请检查 tenants 表是否有对应数据');
  }

  // 写入 LLM 审计日志
  // 对应租户 C（金融机构）的合规要求，此处所有租户统一记录
  await pool.query(
    `INSERT INTO llm_audit_logs
       (tenant_id, session_id, provider, model, request_body, response_body, input_tokens, output_tokens)
     VALUES ($1, $2, 'anthropic', $3, $4, $5, $6, $7)`,
    [
      record.tenantId,
      sessionId,
      record.model,
      JSON.stringify({
        messages: [{ role: 'user', content: record.userMessage }],
      }),
      JSON.stringify({ content: record.assistantMessage }),
      record.inputTokens,
      record.outputTokens,
    ]
  );

  console.log(`  session_id：${sessionId}`);
  console.log('  对话记录已写入 llm_audit_logs 表');
}

// ── 主函数 ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('AgentFlow 本地环境验证 Demo');
  console.log('='.repeat(50));

  // 初始化 PostgreSQL 连接池（单机开发环境，最大 10 个连接已足够）
  const pool = new Pool({
    connectionString: PG_CONNECTION_STRING,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  // Redis 单节点连接
  // 生产注意：生产环境使用 new Redis.Cluster([...nodes])
  //   Cluster 模式下 ioredis 会自动路由命令到对应 slot
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  try {
    await redis.connect();

    // Step 1：验证 PostgreSQL
    const tenants = await verifyPostgres(pool);

    // 取第一个租户（电商租户 A）做演示
    const demoTenant = tenants[0];
    if (!demoTenant) {
      throw new Error('没有找到测试租户，请检查 init.sql 是否执行成功');
    }

    // Step 2：验证 Redis
    await verifyRedis(redis, demoTenant);

    // Step 3：调用 Anthropic API
    const { userMessage, assistantMessage, usage, model } =
      await callAnthropicApi(demoTenant);

    // Step 4：持久化到 PostgreSQL
    await persistConversation(pool, {
      tenantId: demoTenant.id,
      userId: 'demo-user-001',
      userMessage,
      assistantMessage,
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    });

    console.log('\n' + '='.repeat(50));
    console.log('所有验证通过，本地开发环境配置正确。');
    console.log('\n可以访问以下地址：');
    console.log('  Langfuse:     http://localhost:3000');
    console.log('  Temporal UI:  http://localhost:8080');
    console.log('  MailHog:      http://localhost:8025');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\n验证失败：', message);

    // 打印排查提示
    if (message.includes('ECONNREFUSED')) {
      console.error('\n排查提示：');
      console.error('  1. 确认 docker compose up -d 已执行');
      console.error('  2. 检查端口是否被占用：lsof -i :5432 / lsof -i :6379');
      console.error('  3. 查看容器状态：docker compose ps');
    }

    process.exit(1);
  } finally {
    await redis.quit();
    await pool.end();
  }
}

main();
