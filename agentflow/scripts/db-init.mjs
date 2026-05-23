#!/usr/bin/env node
/**
 * 在已运行的 Postgres 容器上重跑 init.sql。
 * 用法：npm run db:init
 *
 * 当容器是空目录第一次启动时，init.sql 会被自动执行，无需手动跑这个脚本；
 * 但如果你修改了 init.sql、想直接 apply 到已有数据库（不删数据），用这个。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://agentflow:agentflow_dev_password@localhost:5432/agentflow';

const sqlPath = join(__dirname, 'init.sql');
const sql = readFileSync(sqlPath, 'utf-8');

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  console.log('[db:init] 连接成功，执行 init.sql ...');
  await client.query(sql);
  console.log('[db:init] 完成');
} catch (err) {
  console.error('[db:init] 失败：', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
