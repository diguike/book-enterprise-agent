/**
 * Skill 系统核心类型定义
 *
 * 所有 Skill 都必须满足 BaseSkill 接口。
 * 不同类型的 Skill（builtin/webhook/code/mcp）通过 config 字段区分具体配置。
 */

import { z } from 'zod';

// ─── Skill 类型枚举 ───────────────────────────────────────────────

/** Skill 的执行模式 */
export type SkillType = 'builtin' | 'webhook' | 'code' | 'mcp' | 'subagent';

/** Skill 的功能分类（影响 UI 展示和过滤，不影响执行逻辑） */
export type SkillCategory =
  | 'search'        // 信息检索类
  | 'communication' // 邮件、消息通知类
  | 'data'          // 数据查询类
  | 'generation'    // 内容生成类
  | 'automation';   // 自动化操作类

// ─── 执行上下文 ──────────────────────────────────────────────────

/**
 * Skill 执行时注入的上下文信息。
 * 每次调用都会创建新的 SkillContext，包含本次调用的身份信息。
 */
export interface SkillContext {
  /** 发起调用的租户 ID */
  tenantId: string;
  /** 当前会话 ID（用于日志追踪） */
  sessionId: string;
  /** 终端用户 ID（可选，匿名用户时为 undefined） */
  userId?: string;
  /** 调用发起的时间戳（Unix 毫秒） */
  startedAt: number;
}

// ─── 内置 Skill ──────────────────────────────────────────────────

/**
 * 内置 Skill 的接口定义。
 *
 * 内置 Skill 的执行逻辑直接写在平台代码里，不走 HTTP 或沙箱。
 * description 字段会直接传给 LLM，影响 LLM 是否选择这个工具——写得越具体越好。
 */
export interface BuiltinSkill {
  id: string;
  name: string;
  /** 传给 LLM 的工具描述，需明确说明适用和不适用的场景 */
  description: string;
  category: SkillCategory;
  /** 用 Zod 定义的输入 schema，同时用于参数验证和给 LLM 提供结构信息 */
  inputSchema: z.ZodSchema;
  /** 输出 schema */
  outputSchema: z.ZodSchema;
  /** 实际执行函数 */
  execute: (input: unknown, context: SkillContext) => Promise<unknown>;
  /** 平台级每分钟调用限制（跨所有租户共享） */
  rateLimit?: { rpm: number };
  /** 超时时间（毫秒） */
  timeout: number;
  /** 结果是否可缓存（缓存 key = skill_id + input 的哈希） */
  isCacheable: boolean;
  /** 缓存 TTL（秒），isCacheable 为 true 时必填 */
  cacheTtl?: number;
}

// ─── Webhook Skill ───────────────────────────────────────────────

/**
 * Webhook Skill 配置。
 *
 * 调用时，平台向 url 发起 HTTP 请求，将 input 作为请求体。
 * webhookSecret 用于请求签名，企业端验证签名确保请求来自平台。
 */
export interface WebhookSkillConfig {
  url: string;
  method: 'GET' | 'POST';
  /** 请求头（加密存储在数据库中，运行时解密） */
  headers: Record<string, string>;
  /** 请求超时（毫秒） */
  timeout: number;
  /** 超时时是否自动重试一次 */
  retryOnTimeout: boolean;
  /** HMAC-SHA256 签名密钥（可选） */
  webhookSecret?: string;
}

// ─── Code Skill ──────────────────────────────────────────────────

/**
 * Code Skill 配置。
 *
 * 用户代码在 isolated-vm 沙箱内执行。
 * code 字段存储 ES2020 JavaScript 代码，不支持 import/require。
 * 沙箱内只能访问 __input__ 变量和白名单内的外部函数。
 */
export interface CodeSkillConfig {
  /** 用户编写的 JavaScript 代码（ES2020，不支持模块语法） */
  code: string;
  /** 入口函数名，平台调用 module[entrypoint](__input__) */
  entrypoint: string;
  /** 允许在沙箱内 fetch 的 URL 前缀白名单 */
  allowedUrls: string[];
  /** V8 Isolate 堆内存上限（MB，默认 128） */
  memoryLimitMb: number;
  /** CPU 时间上限（毫秒，默认 5000） */
  cpuTimeLimitMs: number;
}

// ─── MCP Skill ───────────────────────────────────────────────────

/**
 * MCP Skill 配置。
 *
 * AgentFlow 作为 MCP Client，调用租户实现的 MCP Server。
 * serverUrl 和 stdioCommand 二选一：生产环境用 HTTP Transport，本地开发用 stdio。
 */
export interface MCPSkillConfig {
  /** HTTP Transport 端点（生产环境） */
  serverUrl?: string;
  /** stdio 命令（本地开发，例如 "node /path/to/mcp-server.js"） */
  stdioCommand?: string;
  /** stdio 命令参数 */
  stdioArgs?: string[];
  /** Bearer Token 认证（可选） */
  authToken?: string;
  /** 只允许调用指定工具（不填则允许 MCP Server 暴露的全部工具） */
  allowedTools?: string[];
}

// ─── Sub-Agent Skill ─────────────────────────────────────────────

/**
 * Sub-Agent Skill 配置。
 *
 * 把另一个 Mastra Agent 作为 Skill 调用，适合复杂多步骤任务。
 * 通信协议：'internal' 直接方法调用，'a2a' 通过 A2A 协议（第9章）。
 */
export interface SubAgentSkillConfig {
  agentEndpoint: string;
  protocol: 'internal' | 'a2a';
  timeout: number;
}

// ─── 通用 Skill 记录 ─────────────────────────────────────────────

/**
 * 存储在数据库里的 Skill 记录。
 *
 * 通过 type 字段区分类型，config 存储对应类型的配置。
 * embedding 是 description 的向量表示，用于语义检索。
 */
export interface SkillRecord {
  id: string;
  /** NULL 表示平台内置 Skill */
  tenantId: string | null;
  name: string;
  description: string;
  type: SkillType;
  /** 类型相关配置，由 SkillType 决定具体结构 */
  config: WebhookSkillConfig | CodeSkillConfig | MCPSkillConfig | SubAgentSkillConfig | Record<string, never>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /** description 的向量（1024 维，voyage-3；切到 text-embedding-3-small 时为 1536 维） */
  embedding?: number[];
  isActive: boolean;
  rateLimitRpm?: number;
  timeoutMs: number;
  createdAt: Date;
}

/** 注册新 Skill 时的输入类型 */
export type CreateSkillInput = Omit<SkillRecord, 'id' | 'embedding' | 'createdAt'>;

// ─── 执行结果 ────────────────────────────────────────────────────

/** Skill 执行成功的结果 */
export interface SkillResult<T = unknown> {
  success: true;
  data: T;
  /** 实际执行耗时（毫秒） */
  latencyMs: number;
  /** 是否来自缓存 */
  cached: boolean;
}

/** Skill 执行失败的结果 */
export interface SkillError {
  success: false;
  error: string;
  /** 错误类型，用于决定是否重试 */
  errorType: 'timeout' | 'rate_limit' | 'sandbox_escape' | 'network' | 'validation' | 'unknown';
  latencyMs: number;
}

export type SkillExecutionResult<T = unknown> = SkillResult<T> | SkillError;

// ─── BullMQ Job 数据类型 ─────────────────────────────────────────

/** 投入队列的异步 Skill 执行任务数据 */
export interface SkillJobData {
  skillId: string;
  tenantId: string;
  sessionId: string;
  userId?: string;
  input: unknown;
  /** 任务唯一 ID，用于幂等性保证 */
  idempotencyKey: string;
}
