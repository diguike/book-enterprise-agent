/**
 * 长对话上下文管理
 *
 * 解决长对话场景下 LLM context window 的 token 超限问题。
 * 通过重要性评分对历史消息进行筛选，保留高价值内容，压缩或丢弃低价值内容。
 *
 * 压缩策略：
 * 1. 始终保留：system 消息、最近 KEEP_RECENT 条消息
 * 2. score < LOW_SCORE_THRESHOLD 的 assistant 消息：丢弃
 * 3. score 在 LOW-HIGH 之间的 assistant 消息：摘要化（截断到 MAX_SUMMARY_CHARS 字符）
 * 4. score >= HIGH_SCORE_THRESHOLD 的消息：保留原文
 * 5. 所有 user 消息：永远保留原文
 */

import type { ConversationMessage } from './session-store.js';

// ==================== 常量 ====================

// 始终保留最近 N 条消息，无论分数
const KEEP_RECENT = 20;
// 超过此 token 数触发压缩
const COMPRESS_THRESHOLD_TOKENS = 100_000;
// 超过此消息数触发压缩
const COMPRESS_THRESHOLD_MESSAGES = 50;
// 低于此分数的 assistant 消息直接丢弃
const LOW_SCORE_THRESHOLD = 0.3;
// 低于此分数的 assistant 消息摘要化（高于则保留原文）
const HIGH_SCORE_THRESHOLD = 0.6;
// 摘要化后的最大字符数
const MAX_SUMMARY_CHARS = 100;

// ==================== Token 估算 ====================

/**
 * 估算文本的 token 数（不调用真实的 tokenizer）
 * 中文字符约 1.5 tokens，英文词约 1.3 tokens
 *
 * 生产注意：精确计数应使用 Anthropic 的 Token Counting API：
 * client.beta.messages.countTokens()
 * 估算方法误差在 15% 以内，对于阈值判断够用
 */
export function estimateTokenCount(text: string): number {
  const chineseChars = (text.match(/[一-鿿㐀-䶿]/g) ?? [])
    .length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.3);
}

/**
 * 计算一组消息的总 token 估算值
 */
export function estimateMessagesTokens(
  messages: ConversationMessage[]
): number {
  return messages.reduce(
    (total, msg) => total + estimateTokenCount(msg.content),
    0
  );
}

// ==================== 重要性评分 ====================

export interface ImportanceScoringContext {
  // 当前最新的用户消息内容（用于计算相关性）
  latestUserMessage: string;
  // 消息在列表中的位置索引（0 = 最旧）
  index: number;
  // 消息总数
  total: number;
}

/**
 * 计算单条消息的重要性分数（0-1）
 *
 * score = relevance_to_current × 0.4
 *       + recency × 0.3
 *       + frequency_of_reference × 0.2
 *       + user_marked_important × 0.1
 */
export function calculateImportanceScore(
  message: ConversationMessage,
  ctx: ImportanceScoringContext,
  referenceCountMap: Map<string, number>
): number {
  // 已有预设分数则直接用（外部覆盖）
  if (message.importanceScore !== undefined) {
    return message.importanceScore;
  }

  // 1. 与当前消息的相关性（简化实现：关键词重叠率）
  const relevance = calculateKeywordOverlap(
    message.content,
    ctx.latestUserMessage
  );

  // 2. 时间衰减：越新越高
  // 最新消息分数为 1.0，每往前 5 条衰减 0.1，最低 0
  const recency = Math.max(0, 1.0 - Math.floor((ctx.total - 1 - ctx.index) / 5) * 0.1);

  // 3. 引用频率：该消息内容关键词在后续对话中出现的次数
  const refCount = referenceCountMap.get(extractKeyPhrase(message.content)) ?? 0;
  // 归一化到 0-1（超过 5 次视为满分）
  const frequency = Math.min(1.0, refCount / 5);

  // 4. 用户显式标记（检测是否包含"记住"、"重要"等关键词）
  const userMarked = detectUserMarkedImportant(message) ? 1.0 : 0.0;

  const score =
    relevance * 0.4 +
    recency * 0.3 +
    frequency * 0.2 +
    userMarked * 0.1;

  return Math.min(1.0, Math.max(0.0, score));
}

/**
 * 关键词重叠率（简化版语义相关性计算）
 * 生产场景可替换为向量余弦相似度
 */
function calculateKeywordOverlap(text: string, reference: string): number {
  if (!reference || !text) return 0;

  // 简单分词：中文按字符，英文按空格
  const textWords = new Set(tokenize(text));
  const refWords = new Set(tokenize(reference));

  if (refWords.size === 0) return 0;

  let overlap = 0;
  for (const word of refWords) {
    if (textWords.has(word)) overlap++;
  }

  return overlap / refWords.size;
}

/**
 * 简单分词（仅用于关键词匹配，不是语言学意义上的分词）
 */
function tokenize(text: string): string[] {
  // 中文字符单独作为 token，英文按空格和标点分割
  const tokens: string[] = [];
  const chinesePattern = /[一-鿿]/g;
  const cleaned = text.toLowerCase();

  // 提取中文字符
  const chineseMatches = cleaned.match(chinesePattern) ?? [];
  tokens.push(...chineseMatches);

  // 提取英文词（去除中文后按非字母数字分割）
  const englishPart = cleaned.replace(/[一-鿿]/g, ' ');
  const englishTokens = englishPart
    .split(/\s+|[^a-z0-9]+/)
    .filter((t) => t.length > 2); // 过滤太短的词
  tokens.push(...englishTokens);

  return tokens;
}

/**
 * 提取消息的关键短语（用于引用频率统计）
 * 简化实现：取消息的前10个字符作为标识
 */
function extractKeyPhrase(content: string): string {
  return content.slice(0, 10).trim();
}

/**
 * 检测消息是否被用户显式标记为重要
 */
function detectUserMarkedImportant(message: ConversationMessage): boolean {
  if (message.role !== 'user') return false;
  const importantKeywords = ['记住', '重要', '一定要记得', '牢记', 'remember', 'important'];
  const lower = message.content.toLowerCase();
  return importantKeywords.some((kw) => lower.includes(kw));
}

/**
 * 构建引用频率统计 Map
 * 统计每条早期消息的关键短语在后续消息中出现的次数
 */
function buildReferenceCountMap(messages: ConversationMessage[]): Map<string, number> {
  const countMap = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const phrase = extractKeyPhrase(messages[i].content);
    // 统计该短语在后续消息中出现的次数
    let count = 0;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].content.includes(phrase)) {
        count++;
      }
    }
    countMap.set(phrase, count);
  }

  return countMap;
}

// ==================== 上下文压缩 ====================

export interface CompressResult {
  messages: ConversationMessage[];
  // 压缩前的 token 估算
  originalTokens: number;
  // 压缩后的 token 估算
  compressedTokens: number;
  // 被丢弃的消息数
  droppedCount: number;
  // 被摘要化的消息数
  summarizedCount: number;
}

/**
 * 压缩对话上下文
 *
 * 当消息数超过阈值或 token 数超过阈值时，按重要性评分压缩历史消息。
 * 始终保留 system 消息和最近 KEEP_RECENT 条消息。
 */
export function compressContext(
  messages: ConversationMessage[],
  latestUserMessage: string
): CompressResult {
  const originalTokens = estimateMessagesTokens(messages);
  const needsCompression =
    messages.length > COMPRESS_THRESHOLD_MESSAGES ||
    originalTokens > COMPRESS_THRESHOLD_TOKENS;

  if (!needsCompression) {
    return {
      messages,
      originalTokens,
      compressedTokens: originalTokens,
      droppedCount: 0,
      summarizedCount: 0,
    };
  }

  // 分离 system 消息、"最近N条"保护区、中间消息
  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  // 最近 KEEP_RECENT 条消息无条件保留
  const recentMessages = nonSystemMessages.slice(-KEEP_RECENT);
  // 中间消息是待压缩区域
  const middleMessages = nonSystemMessages.slice(0, -KEEP_RECENT);

  if (middleMessages.length === 0) {
    // 没有可压缩的中间消息
    return {
      messages,
      originalTokens,
      compressedTokens: originalTokens,
      droppedCount: 0,
      summarizedCount: 0,
    };
  }

  // 构建引用频率统计
  const refCountMap = buildReferenceCountMap(messages);

  let droppedCount = 0;
  let summarizedCount = 0;

  // 对中间消息按重要性评分进行压缩
  const compressedMiddle: ConversationMessage[] = [];

  for (let i = 0; i < middleMessages.length; i++) {
    const msg = middleMessages[i];

    // user 消息永远保留原文
    if (msg.role === 'user') {
      compressedMiddle.push(msg);
      continue;
    }

    // 计算重要性分数
    const score = calculateImportanceScore(
      msg,
      {
        latestUserMessage,
        index: i,
        total: middleMessages.length,
      },
      refCountMap
    );

    if (score < LOW_SCORE_THRESHOLD) {
      // 低分 assistant 消息直接丢弃
      droppedCount++;
    } else if (score < HIGH_SCORE_THRESHOLD) {
      // 中等分数：摘要化（截断 + 标记）
      const summary = msg.content.slice(0, MAX_SUMMARY_CHARS);
      const suffix = msg.content.length > MAX_SUMMARY_CHARS ? '...[已压缩]' : '';
      compressedMiddle.push({
        ...msg,
        content: summary + suffix,
        importanceScore: score,
      });
      summarizedCount++;
    } else {
      // 高分消息保留原文
      compressedMiddle.push({ ...msg, importanceScore: score });
    }
  }

  const result: ConversationMessage[] = [
    ...systemMessages,
    ...compressedMiddle,
    ...recentMessages,
  ];

  return {
    messages: result,
    originalTokens,
    compressedTokens: estimateMessagesTokens(result),
    droppedCount,
    summarizedCount,
  };
}

/**
 * 判断是否需要触发压缩
 */
export function shouldCompress(messages: ConversationMessage[]): boolean {
  if (messages.length > COMPRESS_THRESHOLD_MESSAGES) return true;
  if (estimateMessagesTokens(messages) > COMPRESS_THRESHOLD_TOKENS) return true;
  return false;
}
