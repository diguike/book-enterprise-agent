/**
 * 文档入库 Pipeline
 * 完整流程：解析 → 分块 → 向量化 → 存储
 * 生产中作为 BullMQ Worker 的处理函数
 */

import { randomUUID } from 'crypto';
import { parseDocument } from './parser.js';
import { chunkText, printChunkStats } from './chunker.js';
import { batchEmbed, MockEmbeddingProvider } from './embedder.js';
import { storeChunkInMemory, clearChunkStore } from './retriever.js';
import type {
  IngestionJobData,
  PipelineResult,
  DocumentStatus,
  ChunkOptions,
  DocumentFileType,
} from './types.js';

// ─────────────────────────────────────────────
// 文档状态管理（内存模拟，生产用数据库）
// ─────────────────────────────────────────────

interface DocumentRecord {
  id: string;
  tenantId: string;
  name: string;
  status: DocumentStatus;
  chunkCount: number;
  errorMsg: string | null;
}

// 内存文档记录（演示用）
const documentStore = new Map<string, DocumentRecord>();

/**
 * 更新文档状态
 * 生产对应：UPDATE documents SET status = $1 WHERE id = $2
 */
function updateDocumentStatus(
  documentId: string,
  status: DocumentStatus,
  errorMsg?: string
): void {
  const doc = documentStore.get(documentId);
  if (!doc) {
    throw new Error(`文档不存在: ${documentId}`);
  }
  doc.status = status;
  if (errorMsg) doc.errorMsg = errorMsg;
  console.log(`[Pipeline] 文档状态更新: ${documentId} → ${status}`);
}

/**
 * 创建文档记录
 */
export function createDocument(
  tenantId: string,
  name: string,
  fileType: DocumentFileType
): string {
  const id = randomUUID();
  documentStore.set(id, {
    id,
    tenantId,
    name,
    status: 'uploaded',
    chunkCount: 0,
    errorMsg: null,
  });
  console.log(`[Pipeline] 创建文档: ${id} (${name}, ${fileType})`);
  return id;
}

/**
 * 获取文档记录
 */
export function getDocument(documentId: string): DocumentRecord | undefined {
  return documentStore.get(documentId);
}

// ─────────────────────────────────────────────
// 选择分块策略
// ─────────────────────────────────────────────

/**
 * 根据文件类型自动选择分块策略
 * 也可以由用户在上传时手动指定
 */
function selectChunkOptions(fileType: DocumentFileType): ChunkOptions {
  switch (fileType) {
    case 'md':
      // Markdown 文件按标题分块，保留文档结构
      return {
        strategy: 'markdown',
        chunkSize: 1500,
        overlap: 1,
        maxMarkdownChunkSize: 1500,
      };
    case 'pdf':
    case 'docx':
      // PDF 和 DOCX 转为文本后，用语义分块
      return {
        strategy: 'semantic',
        chunkSize: 512,
        overlap: 1,
      };
    case 'txt':
      // 纯文本用固定大小分块
      return {
        strategy: 'fixed',
        chunkSize: 400,
        overlap: 80,
      };
  }
}

// ─────────────────────────────────────────────
// 主入库 Pipeline
// ─────────────────────────────────────────────

/**
 * 执行文档入库流水线
 *
 * 生产中这个函数是 BullMQ Worker 的处理函数：
 *
 *   const worker = new Worker<IngestionJobData>(
 *     'knowledge:ingestion',
 *     async (job) => runIngestionPipeline(job.data),
 *     { connection: redisConnection, concurrency: 3 }
 *   );
 *
 * BullMQ 会在失败时自动重试（按配置的 backoff 策略）
 */
export async function runIngestionPipeline(
  jobData: IngestionJobData
): Promise<PipelineResult> {
  const { documentId, tenantId, filePath, fileType } = jobData;
  const startTime = Date.now();
  const stageTimes = { parse: 0, chunk: 0, embed: 0, store: 0 };

  try {
    // ── 阶段 1：文档解析 ──
    updateDocumentStatus(documentId, 'parsing');
    const parseStart = Date.now();
    const parseResult = await parseDocument(filePath, fileType);
    stageTimes.parse = Date.now() - parseStart;
    console.log(
      `[Pipeline] 解析完成: ${parseResult.text.length} 字符（${stageTimes.parse}ms）`
    );

    // ── 阶段 2：文本分块 ──
    updateDocumentStatus(documentId, 'chunking');
    const chunkStart = Date.now();
    const chunkOptions = selectChunkOptions(fileType);
    const chunks = chunkText(parseResult.text, chunkOptions);
    stageTimes.chunk = Date.now() - chunkStart;
    printChunkStats(chunks);

    // ── 阶段 3：批量向量化 ──
    updateDocumentStatus(documentId, 'embedding');
    const embedStart = Date.now();
    const provider = new MockEmbeddingProvider();
    const embeddings = await batchEmbed(
      chunks.map((c) => c.content),
      provider,
      { batchSize: 20, delayMs: 50 }
    );
    stageTimes.embed = Date.now() - embedStart;

    // ── 阶段 4：持久化存储 ──
    const storeStart = Date.now();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const embedding = embeddings[i]!;

      // 写入内存存储（生产：写入 PostgreSQL knowledge_chunks 表）
      storeChunkInMemory({
        id: randomUUID(),
        tenantId,
        documentId,
        content: chunk.content,
        embedding,
        metadata: chunk.metadata,
        isDeleted: false,
      });
    }
    stageTimes.store = Date.now() - storeStart;

    // 更新文档记录
    const doc = documentStore.get(documentId);
    if (doc) {
      doc.chunkCount = chunks.length;
    }

    // ── 完成 ──
    updateDocumentStatus(documentId, 'indexed');
    const totalDuration = Date.now() - startTime;

    console.log(
      `[Pipeline] 入库完成 | 文档: ${documentId} | chunks: ${chunks.length} | 总耗时: ${totalDuration}ms`
    );

    return {
      documentId,
      totalChunks: chunks.length,
      durationMs: totalDuration,
      stages: stageTimes,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    updateDocumentStatus(documentId, 'failed', errorMsg);
    console.error(`[Pipeline] 入库失败: ${documentId}`, error);
    throw error;  // 重新抛出，让 BullMQ 触发重试
  }
}

// ─────────────────────────────────────────────
// 文档更新（增量索引）
// ─────────────────────────────────────────────

/**
 * 更新文档内容（增量索引）
 * 策略：写入新 chunks → 软删除旧 chunks（原子操作）
 *
 * 生产实现使用数据库事务（原子性保证）：
 *   BEGIN;
 *     INSERT INTO knowledge_chunks (...) VALUES (...);  -- 先写新 chunks
 *     UPDATE knowledge_chunks SET is_deleted = TRUE     -- 再软删除旧 chunks
 *       WHERE document_id = $1 AND id != ALL($newIds::uuid[]);
 *     UPDATE documents SET version = version + 1 WHERE id = $1;
 *   COMMIT;
 *
 * 这样即使在写入过程中宕机，也不会出现空窗期（旧 chunks 在事务提交前仍可检索）
 * 或脏数据（事务未提交则全部回滚）。
 *
 * 演示版本注意：内存存储没有事务机制，无法完整模拟原子性。
 * 这里只演示入库流程；软删除的原子切换逻辑参考正文 6.8 节的 SQL 示例。
 */
export async function updateDocumentContent(
  documentId: string,
  tenantId: string,
  filePath: string,
  fileType: DocumentFileType
): Promise<PipelineResult> {
  // 执行新内容的完整入库流程（演示版：跳过软删除步骤）
  // 生产实现需要将此函数体替换为包含事务的数据库操作（见上方注释）
  return runIngestionPipeline({
    documentId,
    tenantId,
    filePath,
    fileType,
  });
}

// ─────────────────────────────────────────────
// 内置知识库（平台级，tenant_id = null）
// ─────────────────────────────────────────────

/**
 * 上传平台内置知识库内容（所有租户可访问）
 * 在内存中用 tenantId = '__builtin__' 标识，检索时映射到 null
 */
export async function ingestBuiltinContent(
  name: string,
  content: string
): Promise<PipelineResult> {
  // 平台内置内容用特殊 tenantId 标识（null 是 PostgreSQL NULL）
  const BUILTIN_TENANT_ID = '__builtin__';
  const documentId = randomUUID();

  documentStore.set(documentId, {
    id: documentId,
    tenantId: BUILTIN_TENANT_ID,
    name,
    status: 'uploaded',
    chunkCount: 0,
    errorMsg: null,
  });

  // 将内容写入临时文件（演示：直接用内存内容）
  const chunks = chunkText(content, {
    strategy: 'markdown',
    chunkSize: 1500,
    overlap: 1,
  });

  const provider = new MockEmbeddingProvider();
  const embeddings = await batchEmbed(
    chunks.map((c) => c.content),
    provider,
    { batchSize: 20, delayMs: 0 }
  );

  for (let i = 0; i < chunks.length; i++) {
    storeChunkInMemory({
      id: randomUUID(),
      tenantId: null,  // null 表示平台内置，所有租户可访问
      documentId,
      content: chunks[i]!.content,
      embedding: embeddings[i]!,
      metadata: chunks[i]!.metadata,
      isDeleted: false,
    });
  }

  const doc = documentStore.get(documentId)!;
  doc.status = 'indexed';
  doc.chunkCount = chunks.length;

  return {
    documentId,
    totalChunks: chunks.length,
    durationMs: 0,
    stages: { parse: 0, chunk: 0, embed: 0, store: 0 },
  };
}

/** 暴露清理函数供演示重置状态使用 */
export function resetPipelineStore(): void {
  documentStore.clear();
  clearChunkStore();
}
