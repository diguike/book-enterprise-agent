/**
 * PromptCacheBuilder：构造带 Anthropic Prompt Caching 标记的消息
 *
 * 核心原则：静态内容在前，动态内容在后。
 * cache_control 标记了"缓存断点"，断点之前的所有内容都会被缓存。
 *
 * 多租户分层策略：
 *   层 1（平台基础 prompt）→ cache_control  （所有租户共用，缓存命中率最高）
 *   层 2（租户定制 prompt）→ cache_control  （按租户缓存）
 *   层 3（对话历史）       → 无缓存标记     （动态内容，每次不同）
 *   层 4（当前消息）       → 无缓存标记     （动态内容，每次不同）
 */

import type { Message, TextContentBlock } from './types.js';

// ─── 缓存配置 ──────────────────────────────────────────────────────────────────

/**
 * Anthropic Prompt Caching 的最小 token 数要求
 * 短于此长度的内容块，cache_control 标记会被忽略
 */
const MIN_CACHEABLE_TOKENS = 1024;
/**
 * 字符数到 token 数的粗略换算系数（保守估计）
 * 英文约 4 字符/token，中文约 1.5-2 字符/token
 * 这里用 1.5 作为混合场景的保守估计
 */
const CHARS_PER_TOKEN_ESTIMATE = 1.5;

/** 判断一段文本是否足够长以触发 Prompt Caching */
function isCacheable(text: string): boolean {
  const estimatedTokens = text.length / CHARS_PER_TOKEN_ESTIMATE;
  return estimatedTokens >= MIN_CACHEABLE_TOKENS;
}

// ─── 平台基础 Prompt ───────────────────────────────────────────────────────────

/**
 * 平台基础系统 prompt
 * 所有租户共用，放在最前面作为第一个缓存断点
 * 修改此内容会让所有租户的缓存失效，需谨慎
 */
const PLATFORM_BASE_PROMPT = `你是 AgentFlow 平台上的企业智能客服助手。

## 核心行为准则

1. **准确性优先**：只回答你确定的信息，不确定时明确说明并建议用户联系人工客服。
2. **边界清晰**：仅处理业务相关问题，拒绝回答与业务无关的问题。
3. **隐私保护**：不主动询问用户的敏感信息（如完整身份证号、银行卡号）。
4. **礼貌简洁**：回答简明扼要，避免不必要的寒暄。

## 工具使用规则

- 查询订单状态、物流信息等实时数据时，必须调用相应工具，不能凭记忆回答。
- 工具调用失败时，告知用户稍后重试，不要猜测结果。
- 单次对话最多调用 5 次工具，超过后建议用户联系人工客服。

## 响应格式

- 优先使用自然语言，仅在用户明确要求或内容适合时使用列表/表格。
- 不在回复中暴露内部系统信息（工具名称、数据库字段等）。
- 中文回复，除非用户用其他语言提问。`;

// ─── PromptCacheBuilder ────────────────────────────────────────────────────────

/** 构建缓存优化 prompt 所需的输入 */
export interface PromptCacheInput {
  /** 租户定制系统 prompt（层 2，按租户不同） */
  tenantSystemPrompt: string;
  /** 对话历史（层 3，不缓存） */
  conversationHistory: Message[];
  /** 当前用户消息（层 4，不缓存） */
  currentMessage: string;
}

/**
 * 构造带 Prompt Caching 标记的消息列表
 *
 * 输出的消息结构：
 * ```
 * user: [
 *   { text: PLATFORM_BASE_PROMPT, cache_control: ephemeral },  // 层 1
 *   { text: tenantSystemPrompt,   cache_control: ephemeral },  // 层 2
 *   { text: "历史对话..." },                                   // 层 3
 *   { text: currentMessage },                                  // 层 4
 * ]
 * ```
 */
export function buildCachedMessages(input: PromptCacheInput): Message[] {
  const contentBlocks: TextContentBlock[] = [];

  // 层 1：平台基础 prompt（所有租户共用）
  // 始终尝试缓存，平台 prompt 长度通常满足要求
  contentBlocks.push({
    type: 'text',
    text: PLATFORM_BASE_PROMPT,
    cache_control: { type: 'ephemeral' },
  });

  // 层 2：租户定制 prompt
  // 只有在足够长时才设置 cache_control，否则浪费 cache creation 费用
  if (input.tenantSystemPrompt.trim()) {
    const block: TextContentBlock = {
      type: 'text',
      text: input.tenantSystemPrompt,
    };
    if (isCacheable(input.tenantSystemPrompt)) {
      block.cache_control = { type: 'ephemeral' };
    }
    contentBlocks.push(block);
  }

  // 层 3：对话历史（不缓存，内容每次都不同）
  if (input.conversationHistory.length > 0) {
    const historyText = input.conversationHistory
      .map(m => {
        const text = typeof m.content === 'string'
          ? m.content
          : m.content.map(b => b.text).join('');
        return `${m.role === 'user' ? '用户' : '助手'}：${text}`;
      })
      .join('\n\n');

    contentBlocks.push({
      type: 'text',
      text: `\n\n## 历史对话记录\n\n${historyText}`,
    });
  }

  // 层 4：当前用户消息（不缓存）
  contentBlocks.push({
    type: 'text',
    text: input.currentMessage,
  });

  // 组装成单条 user 消息
  // 注意：Anthropic 要求 cache_control 只能放在 user 消息的 content block 上
  return [
    {
      role: 'user',
      content: contentBlocks,
    },
  ];
}

/**
 * PromptCacheBuilder 类
 * 封装缓存构造逻辑，支持从 LLMGatewayRequest 直接转换
 */
export class PromptCacheBuilder {
  /**
   * 从租户配置和请求中构建带缓存优化的消息列表
   *
   * @param tenantSystemPrompt 租户定制的系统 prompt（从租户配置中读取）
   * @param messages 原始消息列表（来自 LLMGatewayRequest）
   * @returns 带 cache_control 标记的新消息列表
   */
  build(tenantSystemPrompt: string, messages: Message[]): Message[] {
    if (messages.length === 0) return messages;

    // 提取最后一条 user 消息作为当前消息
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMessage) return messages;

    const currentMessageText = typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : lastUserMessage.content.map(b => b.text).join('');

    // 去掉最后一条 user 消息，其余作为历史
    const historyMessages = messages.slice(0, -1);

    return buildCachedMessages({
      tenantSystemPrompt,
      conversationHistory: historyMessages,
      currentMessage: currentMessageText,
    });
  }

  /**
   * 验证响应的 token usage，判断缓存是否命中
   * 返回缓存状态的描述，用于日志和监控
   */
  static describeCacheStatus(usage: {
    inputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }): string {
    const creation = usage.cacheCreationTokens ?? 0;
    const read = usage.cacheReadTokens ?? 0;

    if (read > 0) {
      const savings = ((read / (read + usage.inputTokens)) * 90).toFixed(1);
      return `缓存命中 ${read} tokens（节省约 ${savings}% 费用）`;
    }
    if (creation > 0) {
      return `首次建立缓存 ${creation} tokens（下次请求可命中）`;
    }
    return '未触发 Prompt Caching（内容可能不足 1024 tokens）';
  }
}
