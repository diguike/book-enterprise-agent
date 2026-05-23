/**
 * Skill 执行器
 *
 * 根据 Skill 类型（builtin/webhook/code/mcp）分发到对应的执行逻辑。
 * 统一处理超时、错误包装、执行时间记录。
 */

import type {
  SkillRecord,
  SkillContext,
  SkillExecutionResult,
  WebhookSkillConfig,
  CodeSkillConfig,
  MCPSkillConfig,
} from './types.js';
import type { BuiltinSkill } from './types.js';
import { executeInSandbox } from './sandbox.js';

// ─── Webhook Skill 执行 ──────────────────────────────────────────

/**
 * 执行 Webhook Skill：向企业提供的 HTTPS 端点发起 HTTP 请求。
 *
 * 请求格式：POST JSON，body 包含 input 数据和 AgentFlow 标识信息。
 * 签名：如果 webhookSecret 存在，附上 HMAC-SHA256 签名头。
 */
async function executeWebhookSkill(
  skill: SkillRecord,
  input: unknown,
  context: SkillContext
): Promise<SkillExecutionResult> {
  const config = skill.config as WebhookSkillConfig;
  const startTime = Date.now();

  try {
    // 构造请求体
    const requestBody = JSON.stringify({
      input,
      // 平台元数据，帮助企业做日志关联和审计
      _agentflow: {
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        skillId: skill.id,
        timestamp: new Date().toISOString(),
      },
    });

    // 构造请求头
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'AgentFlow/1.0',
      ...config.headers,
    };

    // 签名（如果配置了 webhookSecret）
    if (config.webhookSecret) {
      // 生产中使用 crypto.createHmac('sha256', secret).update(body).digest('hex')
      // const { createHmac } = await import('crypto');
      // const signature = createHmac('sha256', config.webhookSecret)
      //   .update(requestBody)
      //   .digest('hex');
      // headers['X-AgentFlow-Signature'] = `sha256=${signature}`;
      headers['X-AgentFlow-Signature'] = 'sha256=stub-signature';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(config.url, {
      method: config.method,
      headers,
      body: config.method === 'POST' ? requestBody : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        success: false,
        error: `Webhook 返回错误状态: ${response.status} ${response.statusText}`,
        errorType: 'network',
        latencyMs: Date.now() - startTime,
      };
    }

    const data = await response.json();
    return {
      success: true,
      data,
      latencyMs: Date.now() - startTime,
      cached: false,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isTimeout = errorMessage.includes('aborted') || errorMessage.includes('timeout');

    return {
      success: false,
      error: isTimeout ? `Webhook 请求超时（限制 ${config.timeout}ms）` : errorMessage,
      errorType: isTimeout ? 'timeout' : 'network',
      latencyMs: Date.now() - startTime,
    };
  }
}

// ─── Code Skill 执行 ─────────────────────────────────────────────

/**
 * 执行 Code Skill：在 isolated-vm 沙箱中运行用户代码。
 */
async function executeCodeSkill(
  skill: SkillRecord,
  input: unknown,
  context: SkillContext
): Promise<SkillExecutionResult> {
  const config = skill.config as CodeSkillConfig;
  const startTime = Date.now();

  const sandboxResult = await executeInSandbox(config, input, context);

  return sandboxResult.success
    ? {
        success: true,
        data: sandboxResult.data,
        latencyMs: Date.now() - startTime,
        cached: false,
      }
    : {
        success: false,
        error: sandboxResult.error ?? '沙箱执行失败',
        errorType: sandboxResult.error?.includes('超时') ? 'timeout' : 'unknown',
        latencyMs: Date.now() - startTime,
      };
}

// ─── MCP Skill 执行 ──────────────────────────────────────────────

/**
 * 执行 MCP Skill：通过 MCP 协议调用企业 MCP Server。
 *
 * 本示例展示接口框架，完整的 MCP Client 连接池实现在生产代码中。
 */
async function executeMCPSkill(
  skill: SkillRecord,
  input: unknown,
  _context: SkillContext
): Promise<SkillExecutionResult> {
  const config = skill.config as MCPSkillConfig;
  const startTime = Date.now();

  // MCP Skill 的 config 里包含 toolName 字段（注册时填写）
  const toolName = (config as MCPSkillConfig & { toolName: string }).toolName;

  try {
    // 生产实现：从连接池获取 MCP Client，调用工具
    // const client = await mcpConnectionPool.acquire(config.serverUrl!);
    // const result = await client.callTool({
    //   name: toolName,
    //   arguments: input as Record<string, unknown>,
    // });
    // mcpConnectionPool.release(config.serverUrl!, client);

    // Stub：模拟 MCP 工具调用
    console.log(`[executor] MCP Skill ${skill.name} 调用工具 ${toolName}，输入:`, input);
    const stubResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ status: 'ok', tool: toolName, input }),
        },
      ],
    };

    return {
      success: true,
      data: stubResult,
      latencyMs: Date.now() - startTime,
      cached: false,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      errorType: 'network',
      latencyMs: Date.now() - startTime,
    };
  }
}

// ─── 主执行器 ─────────────────────────────────────────────────────

/**
 * 执行 Skill。
 *
 * 根据 Skill 类型分发到对应的执行函数。
 * 统一处理：超时兜底、错误包装、执行时间记录。
 */
export async function executeSkill(
  skill: SkillRecord,
  input: unknown,
  context: SkillContext,
  builtinSkillMap: Map<string, BuiltinSkill>
): Promise<SkillExecutionResult> {
  console.log(
    `[executor] 执行 Skill: ${skill.name} (${skill.type}), 租户: ${context.tenantId}`
  );

  // 全局超时兜底（在具体执行器的超时之外，防止执行器本身挂起）
  const timeoutMs = skill.timeoutMs + 5000; // 比 skill 自身超时多 5 秒
  const timeoutPromise = new Promise<SkillExecutionResult>((_, reject) =>
    setTimeout(() => reject(new Error(`Skill 全局超时（${timeoutMs}ms）`)), timeoutMs)
  );

  let executionPromise: Promise<SkillExecutionResult>;

  switch (skill.type) {
    case 'builtin': {
      const builtinSkill = builtinSkillMap.get(skill.id);
      if (!builtinSkill) {
        return {
          success: false,
          error: `内置 Skill ${skill.id} 未找到`,
          errorType: 'unknown',
          latencyMs: 0,
        };
      }

      const startTime = Date.now();
      executionPromise = builtinSkill
        .execute(input, context)
        .then((data) => ({
          success: true as const,
          data,
          latencyMs: Date.now() - startTime,
          cached: false,
        }))
        .catch((err: Error) => ({
          success: false as const,
          error: err.message,
          errorType: 'unknown' as const,
          latencyMs: Date.now() - startTime,
        }));
      break;
    }

    case 'webhook':
      executionPromise = executeWebhookSkill(skill, input, context);
      break;

    case 'code':
      executionPromise = executeCodeSkill(skill, input, context);
      break;

    case 'mcp':
      executionPromise = executeMCPSkill(skill, input, context);
      break;

    case 'subagent': {
      // Sub-Agent 调用在第9章 A2A 协议中完整实现，这里占位
      const startTime = Date.now();
      executionPromise = Promise.resolve({
        success: false as const,
        error: 'Sub-Agent Skill 在第9章实现',
        errorType: 'unknown' as const,
        latencyMs: Date.now() - startTime,
      });
      break;
    }

    default:
      return {
        success: false,
        error: `未知的 Skill 类型: ${(skill as SkillRecord).type}`,
        errorType: 'unknown',
        latencyMs: 0,
      };
  }

  try {
    return await Promise.race([executionPromise, timeoutPromise]);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      errorType: 'timeout',
      latencyMs: timeoutMs,
    };
  }
}
