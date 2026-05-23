/**
 * 向量化模块
 * 封装 Anthropic claude-3 embedding（通过 voyage API）或 OpenAI text-embedding-3-small
 * 包含批量处理、速率限制、错误重试逻辑
 */

import type { BatchEmbedOptions, EmbedResponse } from './types.js';

// ─────────────────────────────────────────────
// Embedding 提供商接口
// ─────────────────────────────────────────────

/** 向量化提供商的统一接口 */
export interface EmbeddingProvider {
  /** 向量维度 */
  dimensions: number;
  /** 单次批量 embed 若干文本 */
  embed(texts: string[]): Promise<EmbedResponse>;
}

// ─────────────────────────────────────────────
// Mock Provider（演示用，不需要 API Key）
// ─────────────────────────────────────────────

/**
 * Mock embedding 提供商
 * 生成随机向量，用于演示流程，不需要真实 API Key
 * 实际部署时替换为 AnthropicEmbeddingProvider 或 OpenAIEmbeddingProvider
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  // voyage-3 默认 1024 维；切换为 text-embedding-3-small 时改为 1536
  dimensions = 1024;

  async embed(texts: string[]): Promise<EmbedResponse> {
    // 模拟 API 延迟（50-150ms）
    await new Promise((resolve) =>
      setTimeout(resolve, 50 + Math.random() * 100)
    );

    // 生成确定性的随机向量（相同文本生成相同向量，便于测试）
    const embeddings = texts.map((text) => {
      // 简单哈希：基于文本内容生成伪随机种子
      let seed = 0;
      for (let i = 0; i < text.length; i++) {
        seed = (seed * 31 + text.charCodeAt(i)) & 0x7fffffff;
      }

      // 用线性同余生成器生成向量（维度由 this.dimensions 决定），然后 L2 归一化
      const vec: number[] = [];
      let state = seed;
      for (let i = 0; i < this.dimensions; i++) {
        // LCG 参数（Numerical Recipes 推荐值）
        state = (1664525 * state + 1013904223) & 0x7fffffff;
        vec.push(state / 0x7fffffff - 0.5);
      }

      // L2 归一化（使向量模长为 1，余弦相似度等于点积）
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return vec.map((v) => v / norm);
    });

    // 估算 token 数（中文约 1.5 字/token）
    const totalTokens = texts.reduce(
      (sum, t) => sum + Math.ceil(t.length / 1.5),
      0
    );

    return { embeddings, totalTokens };
  }
}

// ─────────────────────────────────────────────
// Anthropic Voyage Provider（生产用）
// ─────────────────────────────────────────────

/**
 * Anthropic Voyage embedding（生产推荐）
 * 使用 voyage-3 模型，默认 1024 维
 * voyage-3 通过独立的 Voyage AI API 调用，不经过 Anthropic Messages API
 *
 * 需要安装：npm install voyageai
 * 需要设置：VOYAGE_API_KEY 环境变量（在 https://dash.voyageai.com 获取）
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  dimensions = 1024;
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env['VOYAGE_API_KEY'] ?? '';
    if (!this.apiKey) {
      throw new Error('缺少 VOYAGE_API_KEY 环境变量');
    }
  }

  async embed(texts: string[]): Promise<EmbedResponse> {
    // 实际调用 Voyage API（需安装 voyageai 包）：
    //
    // import VoyageAIClient from 'voyageai';
    // const client = new VoyageAIClient({ apiKey: this.apiKey });
    // const response = await client.embed({
    //   input: texts,
    //   model: 'voyage-3',
    // });
    //
    // return {
    //   embeddings: response.data.map(d => d.embedding),
    //   totalTokens: response.usage?.totalTokens ?? 0,
    // };

    throw new Error(
      'VoyageEmbeddingProvider 需要安装 voyageai 包并设置 VOYAGE_API_KEY'
    );
  }
}

// ─────────────────────────────────────────────
// OpenAI Provider（生产用，备选）
// ─────────────────────────────────────────────

/**
 * OpenAI text-embedding-3-small（备选方案）
 * 1536 维，性价比高，速率限制较宽松
 *
 * 需要安装：npm install openai
 * 需要设置：OPENAI_API_KEY 环境变量
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  dimensions = 1536;
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    if (!this.apiKey) {
      throw new Error('缺少 OPENAI_API_KEY 环境变量');
    }
  }

  async embed(texts: string[]): Promise<EmbedResponse> {
    // 实际调用 OpenAI API（需安装 openai 包）：
    //
    // import OpenAI from 'openai';
    // const client = new OpenAI({ apiKey: this.apiKey });
    // const response = await client.embeddings.create({
    //   model: 'text-embedding-3-small',
    //   input: texts,
    //   dimensions: 1536,
    // });
    //
    // return {
    //   embeddings: response.data.map(d => d.embedding),
    //   totalTokens: response.usage.total_tokens,
    // };

    throw new Error(
      'OpenAIEmbeddingProvider 需要安装 openai 包并设置 OPENAI_API_KEY'
    );
  }
}

// ─────────────────────────────────────────────
// 批量向量化（含速率限制）
// ─────────────────────────────────────────────

/**
 * 批量向量化文本列表
 * 按 batchSize 分批调用 API，批次间等待 delayMs 避免触发速率限制
 *
 * 生产注意：
 * - delayMs 是简单的固定等待，生产应使用令牌桶算法做精确限流
 * - 对 429 错误需要指数退避重试（建议最多 5 次，初始 1s，上限 60s）
 * - BullMQ 的 Job backoff 机制可以处理重试逻辑
 */
export async function batchEmbed(
  texts: string[],
  provider: EmbeddingProvider,
  options: BatchEmbedOptions = { batchSize: 20, delayMs: 100 }
): Promise<number[][]> {
  const { batchSize, delayMs } = options;
  const allEmbeddings: number[][] = [];
  let totalTokens = 0;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(texts.length / batchSize);

    console.log(
      `[Embedder] 向量化批次 ${batchNum}/${totalBatches}（${batch.length} 条）...`
    );

    try {
      const response = await provider.embed(batch);
      allEmbeddings.push(...response.embeddings);
      totalTokens += response.totalTokens;
    } catch (error) {
      // 简单重试一次（生产应使用指数退避）
      console.warn(`[Embedder] 批次 ${batchNum} 失败，1 秒后重试...`, error);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const retryResponse = await provider.embed(batch);
      allEmbeddings.push(...retryResponse.embeddings);
      totalTokens += retryResponse.totalTokens;
    }

    // 批次间等待，避免触发速率限制
    if (i + batchSize < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.log(
    `[Embedder] 向量化完成 | 总文本数: ${texts.length} | 消耗 token: ${totalTokens}`
  );

  return allEmbeddings;
}

/**
 * 单条文本向量化（用于查询时）
 */
export async function embedSingleText(
  text: string,
  provider: EmbeddingProvider
): Promise<number[]> {
  const response = await provider.embed([text]);
  return response.embeddings[0]!;
}
