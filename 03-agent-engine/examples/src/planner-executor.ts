/**
 * Planner-Executor-Reflector 三层模型
 *
 * 适用场景：用户意图复杂，涉及多步操作（如"退款并查询其他待发货订单"）
 * 简单单步查询直接用 agent.generate()，不需要 P-E-R 开销
 */

import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { Agent } from '@mastra/core';

// ===== 类型定义 =====

/**
 * 子任务计划
 * Planner 产出的结构化数据，描述单个原子操作
 */
export interface TaskPlan {
  id: string;           // 任务唯一标识，用于依赖引用
  description: string;  // 自然语言描述，Executor 据此生成 prompt
  tool?: string;        // 对应的工具 id（部分任务可能不需要工具）
  params?: Record<string, unknown>;  // 工具参数（Planner 预填，Executor 可覆盖）
  dependsOn?: string[]; // 依赖的其他任务 id，有依赖的任务不能并行执行
  type: 'query' | 'mutation'; // 只读操作 or 写操作，决定是否跳过 Reflector
}

/**
 * 单个任务的执行结果
 */
export interface TaskResult {
  taskId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * 会话上下文，用于多租户隔离
 */
export interface SessionContext {
  tenantId: string;
  userId: string;
  sessionId: string;
}

/**
 * P-E-R 模型的最终输出
 */
export interface PERResponse {
  text: string;           // 汇总后的回复文本
  tasks: TaskResult[];    // 所有子任务的执行结果
  plannerTokens: number;  // Planner 阶段消耗的 tokens
  reflectorTokens: number; // Reflector 阶段消耗的 tokens（跳过时为0）
  reflectorSkipped: boolean; // 是否跳过了 Reflector
}

// ===== Planner =====

/**
 * 把用户消息分解为有序的子任务列表
 *
 * @param userMessage 用户原始消息
 * @param availableTools 当前 agent 可用的工具列表
 */
async function runPlanner(
  userMessage: string,
  availableTools: string[],
): Promise<{ plans: TaskPlan[]; usage: { inputTokens: number; outputTokens: number } }> {
  const result = await generateObject({
    model: anthropic('claude-sonnet-4-5'),
    system: `你是任务规划器。根据用户消息，将任务分解为有序的子任务列表。

可用工具：${availableTools.join(', ')}

分解规则：
1. 每个子任务对应一个具体的原子操作
2. 如果子任务 B 需要用到子任务 A 的结果，在 B 的 dependsOn 中填写 A 的 id
3. 只读操作（查询）标记 type: query，写操作（退款、创建工单）标记 type: mutation
4. 任务粒度要适中：不要把一个查询拆成3步，也不要把5个独立操作合并成1步
5. 最多拆分5个子任务，超出范围的需求告知用户无法处理`,

    prompt: `用户消息：${userMessage}

请分解为子任务列表。`,

    schema: z.object({
      plans: z.array(
        z.object({
          id: z.string().describe('任务ID，如 task-1、task-2'),
          description: z.string().describe('任务的自然语言描述，Executor 会据此执行'),
          tool: z.string().optional().describe('对应的工具名称'),
          params: z.record(z.unknown()).optional().describe('工具参数（如果能从用户消息中直接提取）'),
          dependsOn: z.array(z.string()).optional().describe('依赖的其他任务ID列表'),
          type: z.enum(['query', 'mutation']).describe('操作类型：query=只读，mutation=写操作'),
        })
      ).describe('子任务列表，按执行顺序排列'),
    }),
  });

  return {
    plans: result.object.plans,
    usage: {
      inputTokens: result.usage.promptTokens,
      outputTokens: result.usage.completionTokens,
    },
  };
}

// ===== Executor =====

/**
 * 执行单个子任务
 * 把任务描述 + 依赖结果组合成 prompt，调用 agent 执行
 *
 * @param task 要执行的子任务
 * @param agent Mastra agent 实例
 * @param previousResults 已完成任务的结果 Map，用于注入依赖上下文
 */
async function executeTask(
  task: TaskPlan,
  agent: Agent<any, any, any>,
  previousResults: Map<string, TaskResult>,
): Promise<TaskResult> {
  try {
    // 把依赖任务的结果注入到当前任务的上下文中
    let contextParts: string[] = [];

    if (task.dependsOn && task.dependsOn.length > 0) {
      for (const depId of task.dependsOn) {
        const depResult = previousResults.get(depId);
        if (depResult?.success) {
          contextParts.push(`${depId} 的执行结果：${JSON.stringify(depResult.data)}`);
        } else if (depResult) {
          contextParts.push(`${depId} 执行失败：${depResult.error}`);
        }
      }
    }

    // 如果 Planner 预填了参数，也注入到 prompt 中
    if (task.params && Object.keys(task.params).length > 0) {
      contextParts.push(`已知参数：${JSON.stringify(task.params)}`);
    }

    const prompt = contextParts.length > 0
      ? `${task.description}\n\n相关上下文：\n${contextParts.join('\n')}`
      : task.description;

    const response = await agent.generate([
      { role: 'user', content: prompt },
    ]);

    return {
      taskId: task.id,
      success: true,
      data: response.text,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`任务 ${task.id} 执行失败：${errorMessage}`);
    return {
      taskId: task.id,
      success: false,
      error: errorMessage,
    };
  }
}

// ===== Reflector =====

/**
 * 验证执行结果是否满足用户的原始意图
 * 这是额外一次 LLM call，有成本。简单查询任务会跳过。
 *
 * @param userMessage 用户原始消息
 * @param plans 执行计划
 * @param results 执行结果
 */
async function runReflector(
  userMessage: string,
  plans: TaskPlan[],
  results: TaskResult[],
): Promise<{
  satisfied: boolean;
  feedback: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  // 格式化执行结果，便于 LLM 理解
  const resultSummary = results
    .map((r) => {
      const status = r.success ? '成功' : `失败（${r.error}）`;
      const data = r.success ? JSON.stringify(r.data) : '';
      return `- ${r.taskId}（${status}）：${data}`;
    })
    .join('\n');

  const planSummary = plans.map((p) => `- ${p.id}：${p.description}`).join('\n');

  const reflectResult = await generateObject({
    model: anthropic('claude-sonnet-4-5'),
    system: '你是结果验证器。判断任务执行结果是否完整满足了用户的原始意图。',
    prompt: `用户原始消息：${userMessage}

执行计划：
${planSummary}

执行结果：
${resultSummary}

判断结果是否完整满足了用户的意图。`,

    schema: z.object({
      satisfied: z.boolean().describe('执行结果是否完整满足用户意图'),
      feedback: z.string().describe('判断理由。如果不满足，指出缺少什么或哪一步有问题'),
    }),
  });

  return {
    satisfied: reflectResult.object.satisfied,
    feedback: reflectResult.object.feedback,
    usage: {
      inputTokens: reflectResult.usage.promptTokens,
      outputTokens: reflectResult.usage.completionTokens,
    },
  };
}

// ===== 主函数：串联三层 =====

/**
 * 运行 Planner-Executor-Reflector 三层模型
 *
 * 流程：
 * 1. Planner：分解用户意图为子任务列表
 * 2. Executor：拓扑排序后并行/串行执行子任务
 * 3. Reflector：验证结果（简单查询可跳过）
 *
 * @param agent Mastra agent 实例（负责工具调用）
 * @param userMessage 用户原始消息
 * @param _context 会话上下文（tenantId/userId/sessionId，目前用于日志）
 * @param availableTools 可用工具名称列表，传给 Planner
 */
export async function runPlannerExecutorReflector(
  agent: Agent<any, any, any>,
  userMessage: string,
  _context: SessionContext,
  availableTools: string[],
): Promise<PERResponse> {
  const startTime = Date.now();

  // ===== 第一层：Planner =====
  console.log('[PER] Planner 开始...');
  const { plans, usage: plannerUsage } = await runPlanner(userMessage, availableTools);

  console.log(`[PER] Planner 产出 ${plans.length} 个子任务：`);
  plans.forEach((p) => console.log(`  - ${p.id}（${p.type}）：${p.description}`));

  // 判断是否跳过 Reflector
  // 跳过条件：只有1个任务，且是只读操作（查询）
  // 原因：简单查询结果明确，无需验证；节省1次 LLM call（约500-1000 tokens）
  const shouldSkipReflector = plans.length === 1 && plans[0].type === 'query';

  // ===== 第二层：Executor（拓扑排序，支持并行） =====
  console.log('[PER] Executor 开始...');
  const results: TaskResult[] = [];
  const resultMap = new Map<string, TaskResult>();
  const executed = new Set<string>();

  // 拓扑排序：每轮找出所有依赖已满足的任务，并行执行这一批
  let iterations = 0;
  const maxIterations = plans.length + 1; // 防止循环依赖死锁

  while (executed.size < plans.length && iterations < maxIterations) {
    iterations++;

    // 找出这一轮可以执行的任务（依赖全部已完成）
    const readyTasks = plans.filter((task) => {
      if (executed.has(task.id)) return false; // 已执行
      if (!task.dependsOn || task.dependsOn.length === 0) return true; // 无依赖
      return task.dependsOn.every((depId) => executed.has(depId)); // 依赖全部完成
    });

    if (readyTasks.length === 0) {
      // 没有可执行的任务，可能是循环依赖
      console.error('[PER] Executor 发现循环依赖，中止执行');
      break;
    }

    console.log(`[PER] 第 ${iterations} 轮，并行执行 ${readyTasks.length} 个任务`);

    // 并行执行这一批无依赖关系的任务
    const batchResults = await Promise.all(
      readyTasks.map((task) => executeTask(task, agent, resultMap))
    );

    for (const result of batchResults) {
      results.push(result);
      resultMap.set(result.taskId, result);
      executed.add(result.taskId);

      const status = result.success ? '成功' : `失败（${result.error}）`;
      console.log(`[PER]   ${result.taskId}：${status}`);
    }
  }

  // ===== 第三层：Reflector =====
  let reflectorUsage = { inputTokens: 0, outputTokens: 0 };

  if (shouldSkipReflector) {
    console.log('[PER] Reflector 跳过（简单查询任务）');
  } else {
    console.log('[PER] Reflector 开始验证...');
    const reflection = await runReflector(userMessage, plans, results);
    reflectorUsage = reflection.usage;

    if (reflection.satisfied) {
      console.log('[PER] Reflector：结果满足用户意图');
    } else {
      console.warn(`[PER] Reflector：结果不满足，原因：${reflection.feedback}`);
      // 生产环境中可以在这里触发重新规划（最多重试2次）
      // 目前 Demo 直接返回，不重试
    }
  }

  // ===== 汇总结果 =====
  const successData = results
    .filter((r) => r.success)
    .map((r) => String(r.data))
    .join('\n');

  const failedTasks = results.filter((r) => !r.success);

  let finalText = successData;
  if (failedTasks.length > 0) {
    finalText += `\n\n（注意：${failedTasks.length} 个步骤执行失败：${failedTasks.map((r) => r.taskId).join(', ')}）`;
  }

  const totalMs = Date.now() - startTime;
  console.log(`[PER] 完成，耗时 ${totalMs}ms，Planner tokens：${plannerUsage.inputTokens + plannerUsage.outputTokens}，Reflector tokens：${reflectorUsage.inputTokens + reflectorUsage.outputTokens}`);

  return {
    text: finalText,
    tasks: results,
    plannerTokens: plannerUsage.inputTokens + plannerUsage.outputTokens,
    reflectorTokens: reflectorUsage.inputTokens + reflectorUsage.outputTokens,
    reflectorSkipped: shouldSkipReflector,
  };
}

// ===== 演示函数 =====

/**
 * 演示 P-E-R 模型处理复杂多步骤意图
 */
export async function demoPlannerExecutor(agent: Agent<any, any, any>): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Planner-Executor-Reflector 模型演示');
  console.log('='.repeat(60));

  const ctx: SessionContext = {
    tenantId: 'tenant-ecommerce',
    userId: 'user-demo-002',
    sessionId: `session-per-${Date.now()}`,
  };

  const availableTools = ['query-order', 'query-shipping', 'initiate-refund'];

  // 复杂意图：同时涉及退款和查询
  const complexMessage = '我想退款订单 #12345，然后帮我查一下订单 #67890 的状态';

  console.log(`\n用户消息：${complexMessage}\n`);

  const response = await runPlannerExecutorReflector(
    agent,
    complexMessage,
    ctx,
    availableTools,
  );

  console.log('\n最终结果：');
  console.log(response.text);
  console.log(`\n统计：${response.tasks.length} 个任务，Planner ${response.plannerTokens} tokens，Reflector ${response.reflectorTokens} tokens（${response.reflectorSkipped ? '已跳过' : '已执行'}）`);
}
