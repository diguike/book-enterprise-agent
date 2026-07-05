/**
 * 第8章：RLS + withTenantContext() 可运行验证
 *
 * 8.2 节反复出现的 withTenantContext()（BEGIN + SET LOCAL app.current_tenant_id +
 * 回调 + COMMIT/ROLLBACK）在这里给出最小可运行实现，并用两个租户互相查询来证明
 * RLS 隔离真的生效：
 *
 *   1. 租户 A、B 各插入一行 session
 *   2. 租户 A 视角查询：只能看到自己的行，显式按 B 的 tenant_id 过滤也查不到
 *   3. 租户 A 视角尝试写入 tenant_id=B 的行：被 WITH CHECK 拒绝
 *   4. 不设置租户上下文直接查询：直接报错（预期行为，见 8.2 节"忘记 SET LOCAL"）
 *
 * 前置条件（需要本地 Postgres，schema 用的 knowledge_chunks 依赖 pgvector）：
 *
 *   # 1. 启动带 pgvector 的 Postgres
 *   docker run -d --name agentflow-pg -p 5432:5432 \
 *     -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16
 *
 *   # 2. 初始化 schema（本目录的 rls-setup.sql）
 *   docker exec agentflow-pg psql -U postgres -c 'CREATE EXTENSION IF NOT EXISTS vector'
 *   docker exec -i agentflow-pg psql -U postgres -v ON_ERROR_STOP=1 < src/rls-setup.sql
 *
 *   # 3. 创建 demo 登录用户：继承 agentflow_app 的表权限，受 RLS 约束
 *   #    （rls-setup.sql 里的 agentflow_app 是 NOLOGIN 角色，不能直接连接）
 *   docker exec agentflow-pg psql -U postgres \
 *     -c "CREATE ROLE agentflow_demo LOGIN PASSWORD 'demo' IN ROLE agentflow_app"
 *
 *   # 4. 运行本 demo
 *   npm run demo:rls
 *
 * 环境变量（默认值对应上面的 docker 命令）：
 *   ADMIN_DATABASE_URL  超级用户连接，只用于准备/清理测试租户
 *                       默认 postgres://postgres:postgres@localhost:5432/postgres
 *   APP_DATABASE_URL    业务连接（受 RLS 约束），所有业务读写都走它
 *                       默认 postgres://agentflow_demo:demo@localhost:5432/postgres
 *
 * 注意不能用超级用户跑业务查询——superuser 天然绕过 RLS，看不出隔离效果。
 * 这也是 8.2 节强调业务路径和平台路径必须用两个连接池的原因。
 */

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

// ─── 最小 withTenantContext 实现（与 8.2 节正文一致） ────────────────────────

/**
 * 在一个事务内注入租户上下文并执行回调。
 *
 * SET LOCAL 的作用域是当前事务，事务结束（COMMIT/ROLLBACK）后自动清除，
 * 连接归还池后不会把上一个请求的 tenant_id 带给下一个请求。
 * 这里用 set_config(key, value, is_local=true)，语义等价于 SET LOCAL，
 * 但支持参数绑定（SET LOCAL 语法不接受 $1 占位符，字符串拼接有注入风险）。
 */
async function withTenantContext<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── 验证流程 ────────────────────────────────────────────────────────────────

const DEMO_TENANTS = ['RLS Demo 租户 A', 'RLS Demo 租户 B'];

function assert(cond: boolean, label: string): void {
  if (!cond) {
    throw new Error(`验证失败：${label}`);
  }
  console.log(`  [通过] ${label}`);
}

async function main(): Promise<void> {
  const adminPool = new pg.Pool({
    connectionString:
      process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
  });
  const appPool = new pg.Pool({
    connectionString:
      process.env.APP_DATABASE_URL ?? 'postgres://agentflow_demo:demo@localhost:5432/postgres',
  });

  // 准备：清掉上次运行残留，插入两个测试租户（tenants 表无 RLS，走 admin 连接）
  await adminPool.query('DELETE FROM tenants WHERE name = ANY($1)', [DEMO_TENANTS]);
  const inserted = await adminPool.query(
    `INSERT INTO tenants (name, plan, api_key_hash)
     VALUES ($1, 'pro', 'demo-hash-a'), ($2, 'starter', 'demo-hash-b')
     RETURNING id`,
    DEMO_TENANTS,
  );
  const [tenantA, tenantB] = inserted.rows.map((r: { id: string }) => r.id) as [string, string];
  console.log(`租户 A: ${tenantA}\n租户 B: ${tenantB}\n`);

  // 1. 两个租户各写一行 session（都走受 RLS 约束的 app 连接）
  await withTenantContext(appPool, tenantA, (c) =>
    c.query('INSERT INTO sessions (tenant_id, user_id) VALUES ($1, $2)', [tenantA, 'user-a']),
  );
  await withTenantContext(appPool, tenantB, (c) =>
    c.query('INSERT INTO sessions (tenant_id, user_id) VALUES ($1, $2)', [tenantB, 'user-b']),
  );
  console.log('两个租户各插入 1 行 session\n');

  // 2. 租户 A 视角：只能看到自己的行
  const seenByA = await withTenantContext(appPool, tenantA, async (c) => {
    const all = await c.query('SELECT tenant_id, user_id FROM sessions');
    const crossQuery = await c.query('SELECT COUNT(*)::int AS n FROM sessions WHERE tenant_id = $1', [
      tenantB,
    ]);
    return { rows: all.rows, crossCount: crossQuery.rows[0].n as number };
  });
  assert(
    seenByA.rows.every((r: { tenant_id: string }) => r.tenant_id === tenantA),
    '租户 A 的 SELECT 只返回自己的行（RLS USING 生效）',
  );
  assert(seenByA.crossCount === 0, '租户 A 显式按 B 的 tenant_id 过滤，查到 0 行');

  // 3. 租户 B 视角对称验证
  const seenByB = await withTenantContext(appPool, tenantB, (c) =>
    c.query('SELECT tenant_id, user_id FROM sessions'),
  );
  assert(
    seenByB.rows.length > 0 &&
      seenByB.rows.every((r: { tenant_id: string }) => r.tenant_id === tenantB),
    '租户 B 的 SELECT 只返回自己的行',
  );

  // 4. 租户 A 视角写入 tenant_id=B 的行：应被 WITH CHECK 拒绝
  let crossInsertBlocked = false;
  try {
    await withTenantContext(appPool, tenantA, (c) =>
      c.query('INSERT INTO sessions (tenant_id, user_id) VALUES ($1, $2)', [tenantB, 'intruder']),
    );
  } catch (err) {
    crossInsertBlocked = (err as { code?: string }).code === '42501'; // RLS 策略违规
  }
  assert(crossInsertBlocked, '租户 A 冒写 B 的 tenant_id 被 WITH CHECK 拒绝（错误码 42501）');

  // 5. 不设置租户上下文直接查询：应报错而不是放行所有数据
  let noContextFails = false;
  try {
    await appPool.query('SELECT * FROM sessions');
  } catch {
    noContextFails = true; // unrecognized configuration parameter
  }
  assert(noContextFails, '未注入租户上下文的查询直接报错（宁可失败，不能全量放行）');

  // 清理并退出
  await adminPool.query('DELETE FROM tenants WHERE name = ANY($1)', [DEMO_TENANTS]);
  await appPool.end();
  await adminPool.end();
  console.log('\nRLS 隔离验证全部通过');
}

main().catch((err) => {
  console.error('验证失败：', err);
  process.exit(1);
});
