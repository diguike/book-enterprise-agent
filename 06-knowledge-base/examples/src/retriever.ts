/**
 * 混合检索模块
 * 实现向量检索 + BM25 全文检索 + RRF 融合
 * 支持多租户隔离和租户内容优先级提升
 */

import type {
  KnowledgeSearchOptions,
  SearchResult,
  ChunkMetadata,
} from './types.js';

// ─────────────────────────────────────────────
// 内存存储（演示用）
// ─────────────────────────────────────────────

/**
 * 内存中的 chunk 存储结构（演示用，替代真实数据库）
 * 生产环境使用 pgvector + Drizzle ORM
 */
interface StoredChunk {
  id: string;
  tenantId: string | null;
  documentId: string;
  content: string;
  embedding: number[];
  metadata: ChunkMetadata;
  isDeleted: boolean;
}

// 内存存储，供演示使用
const chunkStore: StoredChunk[] = [];

/** 向内存存储写入 chunk（演示用） */
export function storeChunkInMemory(chunk: StoredChunk): void {
  chunkStore.push(chunk);
}

/** 清空内存存储（测试用） */
export function clearChunkStore(): void {
  chunkStore.length = 0;
}

// ─────────────────────────────────────────────
// 向量检索
// ─────────────────────────────────────────────

/**
 * 余弦相似度计算
 * 两个已归一化向量的余弦相似度等于点积
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度不匹配: ${a.length} vs ${b.length}`);
  }
  // 点积（假设向量已归一化）
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

/**
 * 纯向量检索
 * 在内存中遍历所有 chunk，计算余弦相似度后排序
 *
 * 生产实现对应的 SQL：
 * SELECT id, content, metadata, document_id, tenant_id,
 *        1 - (embedding <=> $1::vector) AS similarity
 * FROM knowledge_chunks
 * WHERE (tenant_id = $2 OR tenant_id IS NULL)
 *   AND is_deleted = FALSE
 * ORDER BY embedding <=> $1::vector
 * LIMIT $3
 */
function vectorSearch(
  queryEmbedding: number[],
  tenantId: string,
  includeBuiltin: boolean,
  limit: number
): Array<{ chunk: StoredChunk; similarity: number; rank: number }> {
  const candidates = chunkStore.filter((c) => {
    if (c.isDeleted) return false;
    if (c.tenantId === tenantId) return true;
    if (includeBuiltin && c.tenantId === null) return true;
    return false;
  });

  const scored = candidates
    .map((chunk) => ({
      chunk,
      similarity: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored.map((item, index) => ({ ...item, rank: index + 1 }));
}

// ─────────────────────────────────────────────
// BM25 全文检索（简化实现）
// ─────────────────────────────────────────────

/**
 * 简化版 BM25 实现（演示用）
 * 生产环境用 PostgreSQL 全文搜索（tsvector + tsquery + GIN 索引）
 *
 * 生产实现对应的 SQL 见正文 6.6 节
 */

/**
 * 将查询文本分词（简单按空格和标点切分）
 * 生产环境应使用 jieba（Node.js）或 zhparser（PostgreSQL 扩展）
 */
function tokenize(text: string): string[] {
  return text
    .split(/[\s，。！？、：；""''【】（）\(\)\[\]\.,!?;:]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1);
}

/**
 * 计算 BM25 分数
 * k1 = 1.2，b = 0.75 是 BM25 的标准参数
 */
function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  avgDocLength: number,
  k1 = 1.2,
  b = 0.75
): number {
  const docLength = docTokens.length;
  const docTokenFreq = new Map<string, number>();

  for (const token of docTokens) {
    docTokenFreq.set(token, (docTokenFreq.get(token) ?? 0) + 1);
  }

  let score = 0;
  for (const token of queryTokens) {
    const tf = docTokenFreq.get(token) ?? 0;
    if (tf === 0) continue;

    // BM25 TF 归一化公式
    const normalizedTf =
      (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));

    // 简化 IDF（假设查询词都在语料中出现过）
    const idf = 1;
    score += idf * normalizedTf;
  }

  return score;
}

function bm25Search(
  query: string,
  tenantId: string,
  includeBuiltin: boolean,
  limit: number
): Array<{ chunk: StoredChunk; bm25Score: number; rank: number }> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const candidates = chunkStore.filter((c) => {
    if (c.isDeleted) return false;
    if (c.tenantId === tenantId) return true;
    if (includeBuiltin && c.tenantId === null) return true;
    return false;
  });

  if (candidates.length === 0) return [];

  // 计算平均文档长度（供 BM25 归一化使用）
  const allTokenCounts = candidates.map((c) => tokenize(c.content).length);
  const avgDocLength =
    allTokenCounts.reduce((a, b) => a + b, 0) / allTokenCounts.length;

  const scored = candidates
    .map((chunk) => {
      const docTokens = tokenize(chunk.content);
      return {
        chunk,
        bm25Score: bm25Score(queryTokens, docTokens, avgDocLength),
      };
    })
    .filter((item) => item.bm25Score > 0)  // 过滤无关文档
    .sort((a, b) => b.bm25Score - a.bm25Score)
    .slice(0, limit);

  return scored.map((item, index) => ({ ...item, rank: index + 1 }));
}

// ─────────────────────────────────────────────
// RRF 融合
// ─────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion（RRF）
 * 将多个排名列表融合为一个综合排名
 *
 * 公式：score(d) = Σ 1/(k + rank_i(d))
 * k = 60 是业界标准默认值，平滑低排名结果的影响
 *
 * 原论文：Cormack et al. "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods"
 */
function rrfFusion(
  vectorResults: Map<string, number>,   // chunkId → vector rank
  bm25Results: Map<string, number>,     // chunkId → bm25 rank
  k: number = 60
): Map<string, number> {
  const scores = new Map<string, number>();

  // 合并所有出现过的 chunk ID
  const allIds = new Set([...vectorResults.keys(), ...bm25Results.keys()]);

  for (const id of allIds) {
    const vectorRank = vectorResults.get(id);
    const bm25Rank = bm25Results.get(id);

    let score = 0;
    if (vectorRank !== undefined) score += 1 / (k + vectorRank);
    if (bm25Rank !== undefined) score += 1 / (k + bm25Rank);

    scores.set(id, score);
  }

  return scores;
}

// ─────────────────────────────────────────────
// 统一检索入口
// ─────────────────────────────────────────────

/**
 * 混合检索：向量检索 + BM25 + RRF 融合
 * 支持三种策略：vector / bm25 / hybrid
 */
export async function hybridSearch(
  options: KnowledgeSearchOptions
): Promise<SearchResult[]> {
  const {
    tenantId,
    query,
    queryEmbedding,
    includeBuiltin,
    tenantContentBoost,
    limit,
    strategy,
  } = options;

  // 候选集大小（取比 limit 多一些，融合后再截断）
  const candidateLimit = limit * 4;

  // ── 向量检索 ──
  const vectorHits =
    strategy !== 'bm25'
      ? vectorSearch(queryEmbedding, tenantId, includeBuiltin, candidateLimit)
      : [];

  // ── BM25 检索 ──
  const bm25Hits =
    strategy !== 'vector'
      ? bm25Search(query, tenantId, includeBuiltin, candidateLimit)
      : [];

  // ── 构建 ID → chunk 映射 ──
  const chunkById = new Map<string, StoredChunk>();
  for (const hit of vectorHits) chunkById.set(hit.chunk.id, hit.chunk);
  for (const hit of bm25Hits) chunkById.set(hit.chunk.id, hit.chunk);

  // ── 计算最终分数 ──
  let results: SearchResult[];

  if (strategy === 'vector') {
    // 纯向量检索：直接用余弦相似度排序
    results = vectorHits.map((hit) => ({
      id: hit.chunk.id,
      content: hit.chunk.content,
      metadata: hit.chunk.metadata,
      documentId: hit.chunk.documentId,
      tenantId: hit.chunk.tenantId,
      score: hit.similarity,
      similarity: hit.similarity,
    }));
  } else if (strategy === 'bm25') {
    // 纯 BM25 检索
    results = bm25Hits.map((hit) => ({
      id: hit.chunk.id,
      content: hit.chunk.content,
      metadata: hit.chunk.metadata,
      documentId: hit.chunk.documentId,
      tenantId: hit.chunk.tenantId,
      score: hit.bm25Score,
      bm25Rank: hit.rank,
    }));
  } else {
    // 混合检索：RRF 融合两路结果
    const vectorRankMap = new Map(vectorHits.map((h) => [h.chunk.id, h.rank]));
    const bm25RankMap = new Map(bm25Hits.map((h) => [h.chunk.id, h.rank]));
    const rrfScores = rrfFusion(vectorRankMap, bm25RankMap);

    results = Array.from(rrfScores.entries())
      .map(([id, score]) => {
        const chunk = chunkById.get(id)!;
        const vectorHit = vectorHits.find((h) => h.chunk.id === id);
        const bm25Hit = bm25Hits.find((h) => h.chunk.id === id);
        return {
          id,
          content: chunk.content,
          metadata: chunk.metadata,
          documentId: chunk.documentId,
          tenantId: chunk.tenantId,
          score,
          similarity: vectorHit?.similarity,
          bm25Rank: bm25Hit?.rank,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  // ── 租户内容优先级提升 ──
  const boostedResults = results.map((r) => ({
    ...r,
    score: r.tenantId === tenantId ? r.score * tenantContentBoost : r.score,
  }));

  // 重排后截断到 limit
  return boostedResults
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─────────────────────────────────────────────
// BM25 查询关键词提取（供 PostgreSQL 全文搜索使用）
// ─────────────────────────────────────────────

/**
 * 将自然语言查询转换为 PostgreSQL tsquery 格式
 * 适用于生产环境的 PostgreSQL 全文搜索
 *
 * 示例：
 *   "双十一退货政策" → "双十一 | 退货 | 政策"（OR 连接，保证召回）
 *
 * 生产注意：
 * 中文分词需要 zhparser 或 pg_jieba 扩展。
 * 这里返回的是 simple 配置（按空格分词）下可用的 tsquery 格式，
 * 仅供演示逻辑，实际中文效果有限。
 */
export function buildTsquery(text: string): string {
  const tokens = tokenize(text);
  if (tokens.length === 0) return '';
  // OR 连接：提高召回率，再用 RRF 做重排
  // 注意：to_tsquery 对特殊字符（& | ! : 等）会报 SQL 语法错误。
  // 生产中应使用 plainto_tsquery($config, $text) 代替手工拼接。
  return tokens.join(' | ');
}
