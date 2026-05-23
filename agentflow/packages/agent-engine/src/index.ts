/**
 * AgentFlow Agent 引擎
 *
 * 这一层是 Mastra Agent 的薄封装，做三件事：
 *   1. 按租户创建 Agent 实例（agent name 带 tenantId 前缀，便于日志追踪）
 *   2. 注册可用工具（MVP 只挂 queryOrder）
 *   3. 暴露 buildThreadId 等会话上下文辅助函数
 *
 * 注意：Mastra 内部已经做了 tool schema → LLM tool 协议 的转换，
 * 但本 MVP 在 apps/api 中并不直接用 Mastra 的 streaming，
 * 而是自己组合 LLM Gateway + tool 执行，原因见 README 的"架构说明"。
 */

import { Agent } from '@mastra/core';
import { anthropic } from '@ai-sdk/anthropic';
import { queryOrderTool } from './tools/query-order.js';

export interface CreateAgentOptions {
  /** 租户 ID（数据库 UUID 或 slug 都行，仅用作 agent name 标识） */
  tenantId: string;
  /** 租户定制 system prompt（不含平台基础 prompt，那一层在 LLM Gateway 加） */
  systemPrompt: string;
  /** 使用的模型 ID，默认 claude-sonnet-4-5 */
  model?: string;
}

/**
 * 创建电商客服 Agent（MVP 唯一支持的 agent 类型）
 *
 * 生产注意：Mastra 实例和 Agent 实例都应作为应用级单例缓存，
 * 不要每次 HTTP 请求都重新 new Agent，避免重复加载 tool schema。
 */
export function createCustomerServiceAgent(options: CreateAgentOptions): Agent {
  const { tenantId, systemPrompt, model } = options;

  return new Agent({
    name: `customer-service-${tenantId}`,
    instructions: systemPrompt,
    model: anthropic(model ?? 'claude-sonnet-4-5'),
    tools: {
      // key 是 LLM tool calling 时看到的工具名，建议用驼峰
      queryOrder: queryOrderTool,
    },
  });
}

/**
 * 构造多租户隔离的 threadId
 * 格式：{tenantId}:{userId}:{sessionId}
 * Mastra 用 threadId 区分对话历史，加 tenantId 前缀防止跨租户串数据。
 */
export function buildThreadId(ctx: {
  tenantId: string;
  userId: string;
  sessionId: string;
}): string {
  return `${ctx.tenantId}:${ctx.userId}:${ctx.sessionId}`;
}

export { queryOrderTool, MOCK_ORDER_IDS } from './tools/query-order.js';
