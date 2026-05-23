/**
 * 电商客服 Mastra Agent
 * 实现租户A（电商）的完整客服 agent，包含多租户内存隔离
 */

import { Agent, Mastra } from '@mastra/core';
import { anthropic } from '@ai-sdk/anthropic';
import { queryOrderTool, queryShippingTool, initiateRefundTool } from './tools.js';

// ===== 类型定义 =====

export interface ChatContext {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ===== Agent 工厂函数 =====

/**
 * 创建电商客服 Agent
 * 每个租户可以有独立的配置，这里以电商场景为例
 *
 * @param tenantId 租户ID，用于日志追踪和未来的配置隔离
 */
export function createEcommerceAgent(tenantId: string): Agent {
  return new Agent({
    name: `ecommerce-customer-service-${tenantId}`,

    // system prompt：定义 agent 的角色、能力边界和行为规则
    // 写法原则：具体、可执行，不写空话
    instructions: `你是一个电商平台的智能客服助手。

你的能力范围：
- 查询订单状态和详情（工具：query-order）
- 查询物流轨迹（工具：query-shipping，前提是订单已发货且有快递单号）
- 发起退款申请（工具：initiate-refund）

处理订单查询的标准流程：
1. 从用户消息中提取订单号（#后面的数字，或用户直接说的数字串）
2. 调用 query-order 获取订单信息
3. 如果订单状态是 shipped（已发货），主动调用 query-shipping 获取物流详情
4. 整合两个工具的结果，给出完整且简洁的回复

处理退款申请的标准流程：
1. 确认用户提供了订单号和退款原因
2. 如果用户没有说明退款金额，先调用 query-order 获取订单金额，默认全额退款
3. 调用 initiate-refund 提交申请
4. 告知用户申请结果和后续流程

处理投诉和情绪化用户：
1. 先表达理解："您的情况我已经了解了"
2. 立即进入解决方案，不要反复道歉
3. 如果无法自动解决，告知用户转人工的方式

重要约束（不可违反）：
- 退款金额超过1000元时，必须明确告知"需要人工审核，24小时内处理"，不能承诺具体退款时间
- 不透露系统内部错误信息，统一回复"系统繁忙，请稍后重试或联系在线客服"
- 不能修改订单状态，不能承诺补偿（补偿需要转人工）
- 用户的手机号、地址等隐私信息保持脱敏格式，不要补全

回复风格：
- 简洁直接，1-3句话能说清楚就不用5句话
- 使用中文习惯的表达方式
- 不要过度道歉，每次回复最多一句"抱歉"`,

    model: anthropic('claude-sonnet-4-5'),

    tools: {
      // 工具别名（key）是 agent 在 function calling 时用的名字
      // 建议用驼峰命名，清晰表达工具用途
      queryOrder: queryOrderTool,
      queryShipping: queryShippingTool,
      initiateRefund: initiateRefundTool,
    },
  });
}

// ===== Mastra 实例 =====

/**
 * 创建 Mastra 实例（全局单例）
 * 管理所有 agent 和共享服务
 *
 * 生产注意：Mastra 实例应该作为应用级单例，在服务启动时创建一次
 * 不要在每次请求里重新创建 Mastra 实例
 */
export function createMastraInstance(): Mastra {
  return new Mastra({
    agents: {
      // 电商租户的客服 agent
      ecommerceAgent: createEcommerceAgent('tenant-ecommerce'),
    },
  });
}

// 全局 Mastra 实例，模块加载时创建
export const mastra = createMastraInstance();

// ===== 对话上下文工具函数 =====

/**
 * 构建多租户隔离的 threadId
 * 格式：{tenantId}:{userId}:{sessionId}
 *
 * Mastra 用 threadId 区分不同的对话线程，
 * 相同 threadId 的对话会共享记忆历史。
 * 加上 tenantId 前缀确保不同租户的数据不会混淆。
 */
export function buildThreadId(ctx: ChatContext): string {
  return `${ctx.tenantId}:${ctx.userId}:${ctx.sessionId}`;
}

/**
 * 演示一次完整的多轮对话
 * 展示 agent 如何串联多个工具调用
 */
export async function demoConversation(): Promise<void> {
  const agent = mastra.getAgent('ecommerceAgent');

  const ctx: ChatContext = {
    tenantId: 'tenant-ecommerce',
    userId: 'user-demo-001',
    sessionId: `session-${Date.now()}`,
  };

  const threadId = buildThreadId(ctx);

  console.log('='.repeat(60));
  console.log('电商客服 Agent 对话演示');
  console.log('='.repeat(60));

  // 第一轮：查询订单状态（会触发两个工具调用：queryOrder + queryShipping）
  console.log('\n用户：我的订单 #12345 什么时候到？\n');

  const response1 = await agent.generate(
    [{ role: 'user', content: '我的订单 #12345 什么时候到？' }],
    {
      resourceId: ctx.userId,
      threadId,
    }
  );

  console.log('助手：', response1.text);
  console.log('\n---');

  // 第二轮：发起退款（小额，无需审批）
  console.log('\n用户：这个耳机我想退货，不好用\n');

  const response2 = await agent.generate(
    [{ role: 'user', content: '这个耳机我想退货，不好用' }],
    {
      resourceId: ctx.userId,
      threadId, // 相同 threadId，agent 有上下文记忆
    }
  );

  console.log('助手：', response2.text);
  console.log('\n---');

  // 第三轮：查询需要人工审批的大额订单退款
  console.log('\n用户：订单 #67890 那个键盘我也要退款\n');

  const response3 = await agent.generate(
    [{ role: 'user', content: '订单 #67890 那个键盘我也要退款，质量太差了' }],
    {
      resourceId: ctx.userId,
      threadId,
    }
  );

  console.log('助手：', response3.text);
  console.log('\n' + '='.repeat(60));
}
