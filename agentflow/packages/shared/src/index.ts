/**
 * AgentFlow 共享类型定义
 *
 * 这个包定义了系统中所有服务共用的核心类型。
 * 修改这里的类型会影响所有依赖此包的 apps，
 * 请确保向后兼容，或者协调所有下游服务一起更新。
 */

// ============================================================
// 租户（Tenant）相关类型
// ============================================================

/**
 * 租户等级，决定资源配额和合规要求
 * - standard: 标准租户（电商、SaaS 等）
 * - financial: 金融等级，每次 LLM 调用需要审计日志，支持人工审批节点
 */
export type TenantTier = 'standard' | 'financial';

/**
 * 租户状态
 */
export type TenantStatus = 'active' | 'suspended' | 'deleted';

/**
 * 租户的 LLM 配额配置
 */
export interface TenantQuota {
  /** 每日最大 token 消耗量（输入 + 输出合计） */
  dailyTokenLimit: number;
  /** 每分钟最大 LLM 请求数 */
  rpmLimit: number;
  /** 单个 session 最大轮次 */
  maxTurnsPerSession: number;
  /** 并发 session 上限 */
  maxConcurrentSessions: number;
}

/**
 * 租户核心实体
 */
export interface Tenant {
  /** 租户唯一 ID，格式：tenant_{ulid} */
  id: string;
  /** 租户名称，用于展示 */
  name: string;
  /** 租户等级 */
  tier: TenantTier;
  /** 租户状态 */
  status: TenantStatus;
  /** 资源配额 */
  quota: TenantQuota;
  /** 创建时间（Unix 毫秒时间戳） */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
}

// ============================================================
// 会话（Session）相关类型
// ============================================================

/**
 * 会话状态枚举
 * - idle: 空闲，等待用户输入
 * - processing: agent 正在处理
 * - waiting_tool: 等待工具调用结果返回
 * - waiting_human: 等待人工审批（金融租户）
 * - completed: 会话正常结束
 * - error: 会话因错误终止
 */
export type SessionStatus =
  | 'idle'
  | 'processing'
  | 'waiting_tool'
  | 'waiting_human'
  | 'completed'
  | 'error';

/**
 * 会话消息角色
 */
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

/**
 * 单条消息
 */
export interface Message {
  /** 消息 ID */
  id: string;
  /** 消息角色 */
  role: MessageRole;
  /** 消息内容（文本或结构化内容） */
  content: string;
  /** 如果是 tool 消息，对应的工具调用 ID */
  toolCallId?: string;
  /** 消息创建时间 */
  createdAt: number;
}

/**
 * 工具调用记录（存储在 session 状态中，用于追踪正在进行的工具调用）
 */
export interface PendingToolCall {
  /** 工具调用 ID，由 LLM 生成 */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具参数（JSON 序列化后的字符串） */
  argumentsJson: string;
  /** 任务队列中的 job ID（BullMQ） */
  jobId: string;
  /** 提交时间 */
  submittedAt: number;
}

/**
 * 会话状态（存储在 Redis 中的热状态）
 *
 * 注意：这里只存当前轮次的上下文和正在进行的操作。
 * 完整的历史消息存在 PostgreSQL 中。
 */
export interface Session {
  /** 会话 ID，格式：session_{ulid} */
  id: string;
  /** 所属租户 ID */
  tenantId: string;
  /** 终端用户 ID（租户侧的用户 ID，不是 AgentFlow 内部 ID） */
  userId: string;
  /** 当前会话状态 */
  status: SessionStatus;
  /** 当前活跃的 agent ID */
  activeAgentId: string;
  /** 当前上下文窗口内的消息列表（不包含全部历史） */
  contextMessages: Message[];
  /** 正在等待结果的工具调用列表 */
  pendingToolCalls: PendingToolCall[];
  /** 会话创建时间 */
  createdAt: number;
  /** 最后活跃时间（用于 Redis TTL 计算） */
  lastActiveAt: number;
  /** 会话 metadata，可由 agent 自由写入 */
  metadata: Record<string, unknown>;
}

// ============================================================
// Agent 相关类型
// ============================================================

/**
 * Agent 支持的编排引擎
 * - mastra: 使用 Mastra 框架，适合普通业务 agent
 * - langgraph: 使用 LangGraph.js，适合需要精确 checkpoint 的 workflow
 */
export type AgentEngine = 'mastra' | 'langgraph';

/**
 * Agent 可使用的 LLM provider
 */
export type LLMProvider = 'openai' | 'anthropic' | 'azure-openai' | 'bedrock';

/**
 * Agent 的 LLM 配置
 */
export interface LLMConfig {
  /** 使用的 provider */
  provider: LLMProvider;
  /** 模型名称，如 'gpt-4o'、'claude-sonnet-4-5' */
  model: string;
  /** 温度（0-2），控制输出随机性 */
  temperature?: number;
  /** 最大输出 token 数 */
  maxTokens?: number;
  /** 系统提示词 */
  systemPrompt: string;
}

/**
 * Agent 的 Memory 配置
 */
export interface MemoryConfig {
  /** 是否启用长期记忆（基于向量检索的跨 session 记忆） */
  enableLongTermMemory: boolean;
  /** 是否在 session 结束后自动生成摘要（会触发额外 LLM 调用） */
  autoSummarize: boolean;
  /** 触发摘要的最小对话轮次（autoSummarize 为 true 时生效） */
  summarizeAfterTurns: number;
  /** 注入上下文窗口的历史消息轮次数 */
  contextWindowTurns: number;
}

/**
 * AgentConfig：agent 的完整配置，存储在数据库中
 * 一个租户可以有多个 agent 配置（不同业务场景对应不同 agent）
 */
export interface AgentConfig {
  /** Agent 配置 ID */
  id: string;
  /** 所属租户 ID */
  tenantId: string;
  /** Agent 名称，如 'order-support'、'billing-support' */
  name: string;
  /** Agent 描述 */
  description: string;
  /** 使用的编排引擎 */
  engine: AgentEngine;
  /** LLM 配置 */
  llm: LLMConfig;
  /** Memory 配置 */
  memory: MemoryConfig;
  /** 允许此 agent 使用的 skill ID 列表 */
  enabledSkillIds: string[];
  /** 是否启用审计日志（金融租户必须为 true） */
  auditLogEnabled: boolean;
  /** 是否启用（false 时不接受新 session） */
  enabled: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
}

// ============================================================
// Skill 相关类型
// ============================================================

/**
 * Skill 参数的 JSON Schema 定义
 * 使用标准 JSON Schema draft-07 子集
 */
export interface SkillParameterSchema {
  type: 'object';
  properties: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean' | 'array' | 'object';
      description: string;
      /** 枚举值（type 为 string 时可选） */
      enum?: string[];
      /** 数组元素类型（type 为 array 时必填） */
      items?: { type: string };
    }
  >;
  required: string[];
  additionalProperties: false;
}

/**
 * Skill 的执行环境
 * - builtin: 内置 skill，运行在主进程，受信任
 * - sandboxed: 用户上传的自定义 skill，运行在 isolated-vm 沙箱
 * - remote: 通过 HTTP 调用外部服务
 */
export type SkillRuntime = 'builtin' | 'sandboxed' | 'remote';

/**
 * Skill 的可见范围
 * - global: 所有租户可用（内置 skill）
 * - tenant: 只对特定租户可用（租户上传的自定义 skill）
 */
export type SkillScope = 'global' | 'tenant';

/**
 * SkillDefinition：skill 的注册定义
 * 对应 LLM tool calling 协议中的 tool definition
 */
export interface SkillDefinition {
  /** Skill 唯一 ID，如 'query-order'、'create-ticket' */
  id: string;
  /** Skill 名称，暴露给 LLM 的工具名（snake_case） */
  name: string;
  /** Skill 描述，LLM 据此决定是否调用此工具 */
  description: string;
  /** 参数 schema，LLM 按此结构生成工具调用参数 */
  parameters: SkillParameterSchema;
  /** 执行环境 */
  runtime: SkillRuntime;
  /** 可见范围 */
  scope: SkillScope;
  /** 如果 scope 为 'tenant'，指定所属租户 ID */
  tenantId?: string;
  /** 最大执行超时（毫秒），超时后强制终止 */
  timeoutMs: number;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 */
  createdAt: number;
}

/**
 * Skill 执行请求
 */
export interface SkillExecutionRequest {
  /** 执行请求 ID，用于幂等去重 */
  requestId: string;
  /** Skill ID */
  skillId: string;
  /** LLM 生成的工具调用参数（已通过 JSON Schema 验证） */
  params: Record<string, unknown>;
  /** 所属租户 ID（用于权限检查和资源隔离） */
  tenantId: string;
  /** 所属 session ID */
  sessionId: string;
  /** LLM 生成的 tool call ID（回传给 LLM 时需要） */
  toolCallId: string;
}

/**
 * Skill 执行结果
 */
export interface SkillExecutionResult {
  /** 对应的执行请求 ID */
  requestId: string;
  /** 对应的 tool call ID */
  toolCallId: string;
  /** 是否执行成功 */
  success: boolean;
  /** 执行结果（序列化为字符串，回传给 LLM） */
  result: string;
  /** 执行失败时的错误信息 */
  error?: string;
  /** 实际执行耗时（毫秒） */
  durationMs: number;
}

// ============================================================
// 通用工具类型
// ============================================================

/**
 * 分页查询参数
 */
export interface PaginationParams {
  page: number;
  pageSize: number;
}

/**
 * 分页查询结果
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

/**
 * 标准 API 响应格式
 */
export type ApiResponse<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };

/**
 * 生成标准成功响应
 */
export function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

/**
 * 生成标准错误响应
 */
export function err(
  code: string,
  message: string,
  details?: unknown
): ApiResponse<never> {
  return { success: false, error: { code, message, details } };
}
