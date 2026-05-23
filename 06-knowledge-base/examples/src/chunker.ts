/**
 * 文本分块模块
 * 实现三种分块策略：固定大小、语义（句子边界）、Markdown 标题
 */

import type { Chunk, ChunkOptions, ChunkMetadata } from './types.js';

// ─────────────────────────────────────────────
// 固定大小分块
// ─────────────────────────────────────────────

/**
 * 固定大小分块（Naive Chunking）
 * 按字符数切割，简单但可能在句子中间截断
 *
 * 适用场景：纯散文、新闻文章等无明显结构的文本
 * 参数建议：chunkSize=400，overlap=80
 */
export function fixedSizeChunk(
  text: string,
  options: Pick<ChunkOptions, 'chunkSize' | 'overlap'>
): Chunk[] {
  const { chunkSize, overlap } = options;

  if (chunkSize <= overlap) {
    throw new Error(`chunkSize (${chunkSize}) 必须大于 overlap (${overlap})`);
  }

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const content = text.slice(start, end);

    chunks.push({
      content,
      index: chunks.length,
      metadata: {
        charCount: content.length,
      },
    });

    // 步进 = chunkSize - overlap，保证相邻块有 overlap 个字符重叠
    start += chunkSize - overlap;
  }

  return chunks;
}

// ─────────────────────────────────────────────
// 语义分块（句子边界）
// ─────────────────────────────────────────────

/**
 * 在句子边界处切割文本
 * 保证每个 chunk 都以完整句子结尾，不截断语义
 *
 * 适用场景：合同、条款、密集正文
 * 参数建议：chunkSize=512，overlap=1（保留上一个 chunk 的最后一句）
 */
export function semanticChunk(
  text: string,
  options: Pick<ChunkOptions, 'chunkSize' | 'overlap'>
): Chunk[] {
  const { chunkSize, overlap } = options;

  // 按中文和英文句末标点分割句子，同时按双换行符分割段落
  // (?<=[。！？\n]) 是后向断言，在标点后切割但不消耗标点
  const sentences = text
    .split(/(?<=[。！？\n\r])\s*|\n\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const chunks: Chunk[] = [];
  let currentContent = '';
  // 用于 overlap：保留上一个 chunk 的最后 N 句
  const lastSentences: string[] = [];

  for (const sentence of sentences) {
    // 如果加上当前句子会超过 chunkSize，先保存当前 chunk
    if (
      currentContent.length + sentence.length > chunkSize &&
      currentContent.trim().length > 0
    ) {
      chunks.push({
        content: currentContent.trim(),
        index: chunks.length,
        metadata: { charCount: currentContent.trim().length },
      });

      // 用 overlap 句作为新 chunk 的开头
      const overlapContent =
        overlap > 0 && lastSentences.length > 0
          ? lastSentences.slice(-overlap).join('') + '\n'
          : '';

      currentContent = overlapContent;
      lastSentences.length = 0; // 清空，从新 chunk 开始记录
    }

    lastSentences.push(sentence);
    currentContent += sentence + '\n';
  }

  // 处理最后一个 chunk（不足 chunkSize 的尾部内容）
  if (currentContent.trim().length > 0) {
    chunks.push({
      content: currentContent.trim(),
      index: chunks.length,
      metadata: { charCount: currentContent.trim().length },
    });
  }

  return chunks;
}

// ─────────────────────────────────────────────
// Markdown 标题分块
// ─────────────────────────────────────────────

/**
 * 按 Markdown 标题（#, ##, ###...）切割文本
 * 每个标题小节作为一个独立 chunk，语义最完整
 *
 * 当某个小节内容超过 maxMarkdownChunkSize 时，
 * 自动降级用 semanticChunk 做二次切分
 *
 * 适用场景：结构化文档（产品手册、FAQ、政策条款）
 */
export function markdownChunk(
  text: string,
  options: {
    maxChunkSize?: number;  // 单个标题块的最大大小，超出后用 semanticChunk 切分
    overlap?: number;        // semanticChunk 降级时的 overlap 参数
  } = {}
): Chunk[] {
  const { maxChunkSize = 1500, overlap = 1 } = options;

  const lines = text.split('\n');
  const chunks: Chunk[] = [];

  let currentLines: string[] = [];
  let currentHeading = '（文档开头）';
  let currentLevel = 0;

  /**
   * 将积累的内容保存为 chunk（或多个 chunk）
   */
  function flushCurrentSection() {
    const content = currentLines.join('\n').trim();
    if (content.length === 0) return;

    const baseMeta: Omit<ChunkMetadata, 'charCount'> = {
      heading: currentHeading,
      headingLevel: currentLevel,
    };

    if (content.length <= maxChunkSize) {
      // 小节内容在限制内，直接作为一个 chunk
      chunks.push({
        content,
        index: chunks.length,
        metadata: { ...baseMeta, charCount: content.length },
      });
    } else {
      // 内容过长，用语义分块二次切分
      const subChunks = semanticChunk(content, {
        chunkSize: maxChunkSize,
        overlap,
      });
      for (const sub of subChunks) {
        chunks.push({
          ...sub,
          index: chunks.length,
          metadata: { ...baseMeta, charCount: sub.content.length },
        });
      }
    }
  }

  for (const line of lines) {
    // 匹配 Markdown 标题行：# / ## / ### 等
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      // 遇到新标题时，先保存上一节的内容
      flushCurrentSection();

      currentHeading = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentLines = [line];  // 标题行本身也包含在 chunk 里
    } else {
      currentLines.push(line);
    }
  }

  // 处理最后一节
  flushCurrentSection();

  return chunks;
}

// ─────────────────────────────────────────────
// 统一入口
// ─────────────────────────────────────────────

/**
 * 根据 ChunkOptions 自动选择分块策略
 */
export function chunkText(text: string, options: ChunkOptions): Chunk[] {
  switch (options.strategy) {
    case 'fixed':
      return fixedSizeChunk(text, options);

    case 'semantic':
      return semanticChunk(text, options);

    case 'markdown':
      return markdownChunk(text, {
        maxChunkSize: options.maxMarkdownChunkSize ?? options.chunkSize,
        overlap: options.overlap,
      });

    default: {
      const exhaustive: never = options.strategy;
      throw new Error(`未知分块策略: ${exhaustive}`);
    }
  }
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/** 打印分块统计信息，便于调试 */
export function printChunkStats(chunks: Chunk[]): void {
  const sizes = chunks.map((c) => c.content.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  const avg = Math.round(total / chunks.length);
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);

  console.log(`[Chunker] 分块统计`);
  console.log(`  总块数: ${chunks.length}`);
  console.log(`  总字符数: ${total}`);
  console.log(`  平均块大小: ${avg} 字符`);
  console.log(`  最小块: ${min} 字符 | 最大块: ${max} 字符`);
}
