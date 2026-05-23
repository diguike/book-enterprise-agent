/**
 * 第6章知识库系统核心类型定义
 * 覆盖文档、分块、检索选项等核心数据结构
 */

// ─────────────────────────────────────────────
// 文档相关类型
// ─────────────────────────────────────────────

/** 支持的文件格式 */
export type DocumentFileType = 'pdf' | 'docx' | 'md' | 'txt';

/**
 * 文档处理状态机
 * 合法转换：uploaded → parsing → chunking → embedding → indexed
 * 任何阶段都可以转到 failed
 */
export type DocumentStatus =
  | 'uploaded'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'indexed'
  | 'failed';

/** 文档元数据，对应 documents 表 */
export interface Document {
  id: string;
  tenantId: string;
  name: string;
  status: DocumentStatus;
  filePath: string | null;
  fileType: DocumentFileType;
  version: number;
  chunkCount: number;
  errorMsg: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─────────────────────────────────────────────
// 分块相关类型
// ─────────────────────────────────────────────

/** 分块策略 */
export type ChunkStrategy = 'fixed' | 'semantic' | 'markdown';

/** 分块配置 */
export interface ChunkOptions {
  strategy: ChunkStrategy;
  /** 块的目标大小（字符数） */
  chunkSize: number;
  /** 相邻块的重叠大小（fixed 策略下是字符数，semantic 策略下是句子数） */
  overlap: number;
  /** markdown 策略下单个标题块的最大大小，超出后再用 semantic 切分 */
  maxMarkdownChunkSize?: number;
}

/** 分块结果 */
export interface Chunk {
  /** 块内容 */
  content: string;
  /** 在文档中的顺序索引，从 0 开始 */
  index: number;
  /** 附加元数据，写入数据库 metadata 列 */
  metadata: ChunkMetadata;
}

/** 块元数据，存入数据库 JSONB 列 */
export interface ChunkMetadata {
  /** 来自的 Markdown 标题（markdown 策略时填充） */
  heading?: string;
  /** 标题层级（1-6） */
  headingLevel?: number;
  /** PDF 页码（解析时填充） */
  pageNumber?: number;
  /** 字符数 */
  charCount: number;
}

/** 带向量的完整分块，写入数据库时使用 */
export interface ChunkWithEmbedding extends Chunk {
  documentId: string;
  tenantId: string | null;
  /** 浮点向量，全书默认 voyage-3（1024 维）；切到 text-embedding-3-small 时为 1536 维 */
  embedding: number[];
}

// ─────────────────────────────────────────────
// 入库 Pipeline 相关类型
// ─────────────────────────────────────────────

/** BullMQ Job 数据结构 */
export interface IngestionJobData {
  documentId: string;
  tenantId: string;
  filePath: string;
  fileType: DocumentFileType;
}

/** Pipeline 每阶段的执行结果 */
export interface PipelineResult {
  documentId: string;
  totalChunks: number;
  durationMs: number;
  stages: {
    parse: number;    // 解析耗时 ms
    chunk: number;    // 分块耗时 ms
    embed: number;    // 向量化耗时 ms
    store: number;    // 存储耗时 ms
  };
}

// ─────────────────────────────────────────────
// 检索相关类型
// ─────────────────────────────────────────────

/** 检索策略 */
export type SearchStrategy = 'vector' | 'bm25' | 'hybrid';

/** 知识库检索配置 */
export interface KnowledgeSearchOptions {
  tenantId: string;
  /** 用户原始问题 */
  query: string;
  /** 用户问题的向量化结果 */
  queryEmbedding: number[];
  /** 是否包含平台内置知识库（tenant_id IS NULL 的内容） */
  includeBuiltin: boolean;
  /**
   * 租户内容相对于平台内置内容的排名提升系数
   * 默认 1.2，表示同等 RRF 分数时租户内容优先
   */
  tenantContentBoost: number;
  /** 返回条数上限 */
  limit: number;
  /** 检索策略 */
  strategy: SearchStrategy;
}

/** 单条检索结果 */
export interface SearchResult {
  id: string;
  content: string;
  metadata: ChunkMetadata;
  documentId: string;
  /** null 表示平台内置知识库的内容 */
  tenantId: string | null;
  /** RRF 融合分数（hybrid 策略）或余弦相似度（vector 策略） */
  score: number;
  /** 向量相似度，范围 [0, 1] */
  similarity?: number;
  /** BM25 排名，1 表示最相关 */
  bm25Rank?: number;
}

// ─────────────────────────────────────────────
// 向量化相关类型
// ─────────────────────────────────────────────

/** Embedding API 的请求/响应 */
export interface EmbedRequest {
  texts: string[];
  model?: string;
}

export interface EmbedResponse {
  embeddings: number[][];
  /** 消耗的 token 数，用于监控 API 用量 */
  totalTokens: number;
}

/** 批量 Embedding 配置 */
export interface BatchEmbedOptions {
  /** 每批次发送的文本数量，根据 API 限制调整 */
  batchSize: number;
  /** 批次间等待时间（ms），避免触发速率限制 */
  delayMs: number;
}
