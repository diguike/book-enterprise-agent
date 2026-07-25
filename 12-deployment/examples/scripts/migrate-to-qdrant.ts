/**
 * pgvector → Qdrant 双写迁移脚本
 *
 * 用途：在双写阶段（步骤 3）把 pgvector 历史数据回填到 Qdrant，
 *      或者在双写过程中跑 reconcile，补齐丢失记录。
 *
 * 运行：
 *   npm run script -- migrate-to-qdrant.ts \
 *     --batch 500 \
 *     --collection knowledge_chunks \
 *     --mode backfill
 *
 * 关键设计：
 * - 按主键游标分页，避免 OFFSET 性能塌方
 * - 批量 upsert 到 Qdrant，减少网络往返
 * - 中断可恢复：把 last_id 保存到本地 checkpoint 文件
 * - 限流：每秒不超过 N 个批次，避免压垮源/目标库
 */

import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 运行模式 */
type Mode = 'backfill' | 'reconcile';

interface MigrationOptions {
  /** 每批从 Postgres 拉多少条 */
  batchSize: number;
  /** Qdrant collection 名 */
  collection: string;
  /** 运行模式：backfill = 全量回填；reconcile = 只补 Qdrant 缺失的 */
  mode: Mode;
  /** 限流：每秒最多多少批 */
  batchesPerSecond: number;
  /** checkpoint 文件路径，保存进度 */
  checkpointFile: string;
}

/** 知识库 chunk 在 Postgres 里的表结构（与第 6 章对齐） */
interface ChunkRow {
  id: string;
  tenant_id: string;
  document_id: string;
  content: string;
  /** pgvector 列：在 SDK 里是 number[] */
  embedding: number[];
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** 进度检查点 */
interface Checkpoint {
  lastId: string | null;
  processedCount: number;
  failedCount: number;
  updatedAt: string;
}

/**
 * 主流程
 */
async function main(): Promise<void> {
  const options = parseArgs();

  // 初始化客户端
  const pg = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  });
  const qdrant = new QdrantClient({
    url: process.env.QDRANT_URL ?? 'http://qdrant:6333',
    apiKey: process.env.QDRANT_API_KEY,
  });

  // 确保 collection 存在
  await ensureCollection(qdrant, options.collection);

  // 读取上次进度
  const checkpoint = await loadCheckpoint(options.checkpointFile);
  console.log(`[migrate] 从 lastId=${checkpoint.lastId ?? '<开始>'} 继续`);

  const limiter = createRateLimiter(options.batchesPerSecond);

  // 按主键游标分页
  let lastId = checkpoint.lastId;
  let totalProcessed = checkpoint.processedCount;
  let totalFailed = checkpoint.failedCount;

  while (true) {
    await limiter();

    const rows = await fetchBatch(pg, lastId, options.batchSize);
    if (rows.length === 0) {
      console.log('[migrate] 全部处理完毕');
      break;
    }

    // reconcile 模式：只处理 Qdrant 里缺失的
    let toUpsert: ChunkRow[] = rows;
    if (options.mode === 'reconcile') {
      toUpsert = await filterMissing(qdrant, options.collection, rows);
      if (toUpsert.length > 0) {
        console.log(
          `[reconcile] batch=${rows.length}, missing=${toUpsert.length}`,
        );
      }
    }

    if (toUpsert.length > 0) {
      try {
        await upsertBatch(qdrant, options.collection, toUpsert);
        totalProcessed += toUpsert.length;
      } catch (err) {
        totalFailed += toUpsert.length;
        console.error(
          `[migrate] 批次失败 lastId=${lastId}, error=${(err as Error).message}`,
        );
        // 失败不中断，继续下一批
      }
    }

    // 更新游标和 checkpoint
    lastId = rows[rows.length - 1].id;
    await saveCheckpoint(options.checkpointFile, {
      lastId,
      processedCount: totalProcessed,
      failedCount: totalFailed,
      updatedAt: new Date().toISOString(),
    });

    if (totalProcessed % 10_000 === 0) {
      console.log(
        `[migrate] 进度：处理 ${totalProcessed}，失败 ${totalFailed}`,
      );
    }
  }

  await pg.end();
  console.log(
    `[migrate] 完成。总处理 ${totalProcessed}，总失败 ${totalFailed}`,
  );
}

/**
 * 命令行参数解析（极简实现，生产建议用 commander）
 */
function parseArgs(): MigrationOptions {
  const args = process.argv.slice(2);
  const get = (key: string, def?: string): string => {
    const idx = args.indexOf(`--${key}`);
    if (idx < 0) {
      if (def !== undefined) return def;
      throw new Error(`缺少参数 --${key}`);
    }
    return args[idx + 1];
  };
  return {
    batchSize: Number(get('batch', '500')),
    collection: get('collection', 'knowledge_chunks'),
    mode: get('mode', 'backfill') as Mode,
    batchesPerSecond: Number(get('rate', '5')),
    checkpointFile: get('checkpoint', '.migrate-checkpoint.json'),
  };
}

/**
 * 从 Postgres 按主键游标拉一批
 */
async function fetchBatch(
  pg: Pool,
  lastId: string | null,
  batchSize: number,
): Promise<ChunkRow[]> {
  // 注意：用主键游标 (id > $1) 而不是 OFFSET，避免数据量大时性能崩塌
  const sql = lastId
    ? `SELECT id, tenant_id, document_id, content, embedding, metadata, created_at
       FROM knowledge_chunks
       WHERE id > $1
       ORDER BY id ASC
       LIMIT $2`
    : `SELECT id, tenant_id, document_id, content, embedding, metadata, created_at
       FROM knowledge_chunks
       ORDER BY id ASC
       LIMIT $1`;
  const params = lastId ? [lastId, batchSize] : [batchSize];
  const result = await pg.query<ChunkRow>(sql, params);
  return result.rows;
}

/**
 * reconcile 模式：检查 Qdrant 中是否已有这些 id，过滤出缺失的
 */
async function filterMissing(
  qdrant: QdrantClient,
  collection: string,
  rows: ChunkRow[],
): Promise<ChunkRow[]> {
  const ids = rows.map((r) => r.id);
  const existing = await qdrant.retrieve(collection, {
    ids,
    with_payload: false,
    with_vector: false,
  });
  const existingSet = new Set(existing.map((p) => String(p.id)));
  return rows.filter((r) => !existingSet.has(r.id));
}

/**
 * 批量 upsert 到 Qdrant
 */
async function upsertBatch(
  qdrant: QdrantClient,
  collection: string,
  rows: ChunkRow[],
): Promise<void> {
  // wait: false 让 Qdrant 异步落盘，回填吞吐更高
  // reconcile 模式会扫差异补漏，丢一两批可以追回
  await qdrant.upsert(collection, {
    wait: false,
    points: rows.map((r) => ({
      id: r.id,
      vector: r.embedding,
      // payload 与 Postgres 字段保持对齐，便于后续应用层一致
      payload: {
        tenant_id: r.tenant_id,
        document_id: r.document_id,
        content: r.content,
        metadata: r.metadata,
        created_at: r.created_at.toISOString(),
      },
    })),
  });
}

/**
 * 确保 collection 存在，不存在则按 pgvector 的维度创建
 */
async function ensureCollection(
  qdrant: QdrantClient,
  collection: string,
): Promise<void> {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === collection);
  if (exists) return;

  console.log(`[migrate] 创建 collection: ${collection}`);
  await qdrant.createCollection(collection, {
    vectors: {
      // 与第 6 章默认 embedding 模型 voyage-3 对齐：1024 维，余弦距离
      // 切到 OpenAI text-embedding-3-small 时改为 1536
      size: 1024,
      distance: 'Cosine',
    },
    // payload 留在内存里，单次查询延迟更低；超大数据集再切到 true
    on_disk_payload: false,
  });

  // 给 tenant_id 加 payload index，加速 filter
  await qdrant.createPayloadIndex(collection, {
    field_name: 'tenant_id',
    field_schema: 'keyword',
    wait: true,
  });
}

/**
 * checkpoint：从文件加载上次进度
 */
async function loadCheckpoint(file: string): Promise<Checkpoint> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return {
      lastId: null,
      processedCount: 0,
      failedCount: 0,
      updatedAt: new Date().toISOString(),
    };
  }
}

async function saveCheckpoint(
  file: string,
  ckpt: Checkpoint,
): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(ckpt, null, 2), 'utf-8');
}

/**
 * 简单限流：保证每秒不超过 N 次调用
 */
function createRateLimiter(perSecond: number): () => Promise<void> {
  const intervalMs = 1000 / perSecond;
  let last = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, last + intervalMs - now);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    last = Date.now();
  };
}

// 入口
main().catch((err: unknown) => {
  console.error('[migrate] 致命错误:', err);
  process.exit(1);
});
