/**
 * SemanticCache：语义相似度缓存
 *
 * 对相似（但不完全相同）的问题，返回已缓存的答案，避免重复 LLM 调用。
 * 实现依赖 Redis Stack（含 RediSearch 向量搜索模块）。
 *
 * 生产注意：需要 Redis Stack 而非标准 Redis。
 * 本地开发：docker run -d -p 6379:6379 redis/redis-stack:latest
 * 标准 Redis 不支持 FT.SEARCH，调用会抛错，SemanticCache 会自动降级（跳过缓存）。
 */

import OpenAI from 'openai';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import type { CachedResponse, LLMResponse } from './types.js';

// ─── 配置常量 ─────────────────────────────────────────────────────────────────

/** 语义相似度阈值（0-1），超过此值视为"足够相似"可返回缓存 */
const SIMILARITY_THRESHOLD = 0.92;
/** 缓存默认 TTL（秒），过期后自动删除 */
const DEFAULT_TTL_SECONDS = 3600;
/** 嵌入向量维度：全书统一 1024（voyage-3 默认输出）。
 *  如果换 OpenAI text-embedding-3-small，可传 dimensions: 1024 截断，或改成 1536。 */
const EMBEDDING_DIMENSION = 1024;
/** Redis 向量搜索索引名前缀 */
const INDEX_PREFIX = 'idx:semantic-cache';
/** Redis hash key 前缀 */
const CACHE_KEY_PREFIX = 'semantic-cache';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 将 Float32Array 转换为 Redis 向量搜索所需的 Buffer 格式
 * Redis Stack 的 VECTOR 类型期望 IEEE 754 float32 little-endian 字节序列
 */
function vectorToBuffer(vector: number[]): Buffer {
  const floatArray = new Float32Array(vector);
  return Buffer.from(floatArray.buffer);
}

// ─── SemanticCache ────────────────────────────────────────────────────────────

/**
 * 语义缓存
 *
 * 架构说明：
 * - 嵌入向量通过 voyage-3 生成（1024 维，全书默认；亦可改用 OpenAI text-embedding-3-small + dimensions: 1024）
 * - 向量和响应存储在 Redis Hash 中（每个 key 对应一条缓存）
 * - 搜索通过 Redis Stack 的 FT.SEARCH KNN 算法（近似最近邻）
 * - 按租户隔离：不同租户的缓存使用不同的索引
 *
 * 局限性：
 * - 只适用于答案不依赖实时数据的"知识类"问题
 * - 需要 Redis Stack（不是标准 Redis）
 * - 嵌入向量生成本身有延迟（约 50-100ms），对于极低延迟场景需要权衡
 */
export class SemanticCache {
  private openai: OpenAI;
  /** 记录已创建的索引，避免重复创建 */
  private initializedTenants: Set<string> = new Set();

  constructor(
    private redis: Redis,
    openaiApiKey: string
  ) {
    this.openai = new OpenAI({ apiKey: openaiApiKey });
  }

  /**
   * 查询语义缓存
   * 返回 null 表示未命中（需要调用 LLM）
   */
  async get(
    query: string,
    tenantId: string
  ): Promise<CachedResponse | null> {
    try {
      // 确保该租户的向量索引已创建
      await this.ensureIndex(tenantId);

      // 将 query 向量化（约 50-100ms，是语义缓存主要的额外开销）
      const queryVector = await this.embed(query);
      const vectorBuffer = vectorToBuffer(queryVector);

      // 使用 Redis Stack KNN 搜索最近邻（K=1，只取最相似的一条）
      const indexName = `${INDEX_PREFIX}:${tenantId}`;
      const results = await this.redis.call(
        'FT.SEARCH',
        indexName,
        '*=>[KNN 1 @vector $vec AS __score]',
        'PARAMS', '2', 'vec', vectorBuffer,
        'SORTBY', '__score', 'ASC',
        'RETURN', '2', 'response', '__score',
        'DIALECT', '2'
      ) as unknown[];

      // results 格式：[total_count, key1, [field, value, ...], key2, ...]
      const totalCount = results[0] as number;
      if (totalCount === 0 || results.length < 3) {
        return null; // 没有任何缓存条目
      }

      const fields = results[2] as string[];
      const responseIdx = fields.indexOf('response');
      const scoreIdx = fields.indexOf('__score');

      if (responseIdx === -1 || scoreIdx === -1) return null;

      // Redis KNN 返回的是向量距离（越小越相似）
      // 对于余弦相似度，distance = 1 - cosine_similarity
      const distance = parseFloat(fields[scoreIdx + 1]);
      const similarity = 1 - distance;

      if (similarity < SIMILARITY_THRESHOLD) {
        // 找到最近邻但相似度不够，不返回缓存
        return null;
      }

      const cachedResponse = JSON.parse(fields[responseIdx + 1]) as CachedResponse;
      return cachedResponse;

    } catch (err) {
      // 降级处理：Redis Stack 不可用时，语义缓存静默失败，不阻塞正常流程
      // 常见场景：使用了标准 Redis 而非 Redis Stack（缺少 RediSearch 模块）
      const errorMsg = (err as Error).message;
      if (errorMsg.includes('unknown command') || errorMsg.includes('ERR unknown')) {
        // 只在首次遇到时打印警告，避免日志刷屏
        if (!this.initializedTenants.has(`warned:${tenantId}`)) {
          console.warn(
            '[SemanticCache] Redis Stack 不可用（FT.SEARCH 命令未找到），语义缓存已降级。' +
            '请使用 redis/redis-stack Docker 镜像。'
          );
          this.initializedTenants.add(`warned:${tenantId}`);
        }
      } else {
        console.error('[SemanticCache] get failed', { error: errorMsg, tenantId });
      }
      return null;
    }
  }

  /**
   * 将 query + response 写入语义缓存
   * 失败时静默忽略（不阻塞正常响应流程）
   */
  async set(
    query: string,
    response: LLMResponse,
    tenantId: string,
    ttl: number = DEFAULT_TTL_SECONDS
  ): Promise<void> {
    try {
      await this.ensureIndex(tenantId);

      const queryVector = await this.embed(query);
      const vectorBuffer = vectorToBuffer(queryVector);

      // 每条缓存用唯一 key 存储（避免相同 query 重复写入导致 key 碰撞）
      const cacheKey = `${CACHE_KEY_PREFIX}:${tenantId}:${randomUUID()}`;

      // 存储查询向量和响应内容（只存需要的字段，不存完整 LLMResponse）
      const cachedResponse: CachedResponse = {
        content: response.content,
        model: response.model,
        provider: response.provider,
        usage: response.usage,
      };

      await this.redis.hset(cacheKey, {
        query,
        response: JSON.stringify(cachedResponse),
        // vector 字段存储原始字节（Redis Stack 向量搜索需要）
        vector: vectorBuffer,
        tenantId,
      });

      // 设置过期时间（TTL 到期后 Redis 自动删除）
      await this.redis.expire(cacheKey, ttl);

    } catch (err) {
      // 缓存写入失败不影响主流程，静默忽略
      console.error('[SemanticCache] set failed', {
        error: (err as Error).message,
        tenantId,
      });
    }
  }

  /**
   * 确保该租户的 Redis 向量索引已创建
   * 使用内存 Set 记录已初始化的租户，避免每次都发 FT.CREATE 命令
   */
  private async ensureIndex(tenantId: string): Promise<void> {
    const indexName = `${INDEX_PREFIX}:${tenantId}`;

    if (this.initializedTenants.has(tenantId)) return;

    try {
      // FT.CREATE：创建向量搜索索引
      // ON HASH：索引 Hash 类型的 key
      // PREFIX：只索引匹配前缀的 key（按租户隔离）
      // SCHEMA：定义索引字段，vector 字段使用 HNSW 算法（近似最近邻）
      await this.redis.call(
        'FT.CREATE',
        indexName,
        'ON', 'HASH',
        'PREFIX', '1', `${CACHE_KEY_PREFIX}:${tenantId}:`,
        'SCHEMA',
        'vector', 'VECTOR', 'HNSW', '6',
        'TYPE', 'FLOAT32',
        'DIM', EMBEDDING_DIMENSION.toString(),
        'DISTANCE_METRIC', 'COSINE',
        'response', 'TEXT',  // 存储响应内容（供 RETURN 字段使用）
      );

      this.initializedTenants.add(tenantId);
    } catch (err) {
      const message = (err as Error).message;
      // "Index already exists" 是正常情况（多进程启动时可能并发创建）
      if (message.includes('Index already exists')) {
        this.initializedTenants.add(tenantId);
        return;
      }
      // 其他错误（如 Redis Stack 不可用）直接抛出，由上层 get/set 的 try-catch 处理
      throw err;
    }
  }

  /**
   * 生成文本的嵌入向量
   * 全书默认使用 voyage-3（1024 维）。这里用 OpenAI SDK 调用并传 dimensions: 1024
   * 截断输出，保持与第 6 章 knowledge_chunks（vector(1024)）维度一致。
   * 想换成原生 voyage-3，把这段替换成 voyageai 客户端调用即可。
   */
  private async embed(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
      dimensions: EMBEDDING_DIMENSION,
    });
    return response.data[0]!.embedding;
  }
}
