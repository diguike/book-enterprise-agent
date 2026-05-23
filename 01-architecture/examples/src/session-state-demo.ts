/**
 * session-state-demo.ts
 *
 * 演示第 1 章 1.2 节"假设一：状态在内存里"的失效场景。
 *
 * 对比两种 session 存储方式：
 *   - 错误做法：进程内 Map（本地 OK，多 Pod 灾难）
 *   - 正确做法：外部 Redis（通过 mock 实现演示接口，不需要真实连接）
 *
 * 运行方法：
 *   npx tsx src/session-state-demo.ts
 */

// ============================================================
// 类型定义（独立 demo 内联版本）
// ============================================================
//
// 在实际项目中，下面这些类型通过 monorepo 包名引入：
//   import type { Session, SessionStatus, Message } from '@agentflow/shared';
// 与 agentflow/packages/shared 的定义保持一致。
// 此处为了让 demo 不依赖任何外部包、可独立运行，把所需类型直接内联。

/** 会话消息角色 */
type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

/** 单条消息 */
interface Message {
  id: string;
  role: MessageRole;
  content: string;
  toolCallId?: string;
  createdAt: number;
}

/**
 * 会话状态枚举
 * - idle: 空闲，等待用户输入
 * - processing: agent 正在处理
 * - waiting_tool: 等待工具调用结果返回
 * - waiting_human: 等待人工审批（金融租户）
 * - completed: 会话正常结束
 * - error: 会话因错误终止
 */
type SessionStatus =
  | 'idle'
  | 'processing'
  | 'waiting_tool'
  | 'waiting_human'
  | 'completed'
  | 'error';

/** 工具调用记录 */
interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  jobId: string;
  submittedAt: number;
}

/**
 * 会话状态（存储在 Redis 中的热状态）
 *
 * 只存当前轮次的上下文和正在进行的操作。
 * 完整的历史消息存在 PostgreSQL 中。
 */
interface Session {
  id: string;
  tenantId: string;
  userId: string;
  status: SessionStatus;
  activeAgentId: string;
  contextMessages: Message[];
  pendingToolCalls: PendingToolCall[];
  createdAt: number;
  lastActiveAt: number;
  metadata: Record<string, unknown>;
}

// ============================================================
// 工具函数
// ============================================================

/** 生成简单的伪 ID（不依赖外部库） */
function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 创建一个新的空 Session */
function createSession(tenantId: string, userId: string): Session {
  const now = Date.now();
  return {
    id: genId('session'),
    tenantId,
    userId,
    status: 'idle' as SessionStatus,
    activeAgentId: 'order-support-agent',
    contextMessages: [],
    pendingToolCalls: [],
    createdAt: now,
    lastActiveAt: now,
    metadata: {},
  };
}

/** 创建一条用户消息 */
function userMessage(content: string): Message {
  return {
    id: genId('msg'),
    role: 'user',
    content,
    createdAt: Date.now(),
  };
}

/** 创建一条 assistant 消息 */
function assistantMessage(content: string): Message {
  return {
    id: genId('msg'),
    role: 'assistant',
    content,
    createdAt: Date.now(),
  };
}

// ============================================================
// 接口定义：SessionStore
// ============================================================

/**
 * Session 存储接口
 *
 * 无论底层是内存 Map 还是 Redis，对外暴露相同的操作契约。
 * 这样上层 agent 逻辑不感知存储实现，方便测试和迁移。
 */
interface SessionStore {
  /** 写入或更新一个 session */
  set(session: Session): Promise<void>;
  /** 按 ID 读取 session，不存在时返回 null */
  get(sessionId: string): Promise<Session | null>;
  /** 删除一个 session */
  delete(sessionId: string): Promise<void>;
  /** 返回当前存储的 session 数量（用于演示） */
  size(): Promise<number>;
  /** 存储名称，用于日志区分 */
  readonly storeName: string;
}

// ============================================================
// 错误做法：InMemorySessionStore
// ============================================================

/**
 * InMemorySessionStore：用进程内 Map 存储 session 状态
 *
 * 为什么这在多 Pod 场景下是错的：
 *
 * 1. Pod 重启时内存清空
 *    Kubernetes 会在以下场景重启 Pod：
 *    - 滚动更新（每次部署都会重启所有 Pod）
 *    - OOM Kill（内存超限时内核强制终止进程）
 *    - 健康检查失败（liveness probe 超时）
 *    - 节点故障转移
 *    每次重启后，这个 Map 里的所有 session 全部丢失。
 *    用户下一条消息到来时，agent 找不到上下文，只能从头开始。
 *
 * 2. 水平扩容时新 Pod 没有旧数据
 *    假设当前有 Pod-A 和 Pod-B 各存了一半 session。
 *    流量增加，加入 Pod-C。负载均衡器轮询分配请求：
 *      - 用户 U1 的上一条消息路由到 Pod-A（session 在 Pod-A 的 Map 里）
 *      - 用户 U1 的下一条消息路由到 Pod-C（Pod-C 的 Map 是空的）
 *      - 结果：Pod-C 上的 agent 不知道 U1 说过什么，对话断掉
 *
 * 3. 状态无法跨进程共享
 *    即使加了 session affinity（粘性会话），一旦负载均衡层失效或
 *    Pod 缩容，请求还是会漂移到没有该 session 的 Pod 上。
 */
class InMemorySessionStore implements SessionStore {
  // 进程内存储——Pod 重启或多 Pod 场景下，这里的数据不可见
  private readonly store = new Map<string, Session>();

  readonly storeName = 'InMemoryStore（进程内 Map）';

  async set(session: Session): Promise<void> {
    this.store.set(session.id, session);
  }

  async get(sessionId: string): Promise<Session | null> {
    return this.store.get(sessionId) ?? null;
  }

  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }

  async size(): Promise<number> {
    return this.store.size;
  }

  /**
   * 模拟 Pod 重启：清空所有内存状态
   *
   * 生产中：进程重启后，os 会回收整个进程内存，Map 直接消失。
   * 这里用 clear() 模拟这个行为。
   */
  simulatePodRestart(): void {
    console.log(`  [${this.storeName}] 模拟 Pod 重启 → 清空所有 session 数据`);
    this.store.clear();
  }
}

// ============================================================
// 正确做法：RedisSessionStore（Mock 实现）
// ============================================================

/**
 * RedisSessionStore：通过外部存储管理 session 状态
 *
 * 生产实现中，这里会用 ioredis 连接 Redis：
 *   await redis.set(`session:${session.id}`, JSON.stringify(session), 'EX', 3600);
 *   const raw = await redis.get(`session:${sessionId}`);
 *   return raw ? JSON.parse(raw) : null;
 *
 * 关键设计点：
 *   - Key 命名格式：session:{id}，加前缀便于 Redis Cluster 分片和批量清理
 *   - TTL：每次写入时设置 1 小时 TTL，lastActiveAt 更新时重置，
 *     防止僵尸 session 永久占用内存
 *   - 序列化：JSON 序列化，Session 内所有字段必须可序列化（无函数/循环引用）
 *   - 写回时机：每次 agent 处理完成后立即写回，而不是异步批量写，
 *     保证 Pod 崩溃时最多丢失当前这一轮的处理结果
 *
 * 本示例使用 mock 实现，避免依赖真实 Redis，但接口行为与真实实现一致。
 */
class RedisSessionStore implements SessionStore {
  // Mock 存储：模拟 Redis 的行为（真实实现替换为 ioredis 调用即可）
  // 这里模拟"外部存储"：不同的 Pod 实例共享同一个 mockRedis
  private static readonly mockRedis = new Map<string, string>();

  readonly storeName = 'RedisSessionStore（外部存储 Mock）';

  async set(session: Session): Promise<void> {
    // 真实 Redis 实现：
    //   await this.redis.set(
    //     `session:${session.id}`,
    //     JSON.stringify(session),
    //     'EX', 3600  // 1 小时 TTL
    //   );
    const key = `session:${session.id}`;
    RedisSessionStore.mockRedis.set(key, JSON.stringify(session));
    console.log(
      `  [Redis] SET ${key} （TTL: 3600s，模拟外部持久化）`
    );
  }

  async get(sessionId: string): Promise<Session | null> {
    // 真实 Redis 实现：
    //   const raw = await this.redis.get(`session:${sessionId}`);
    //   return raw ? (JSON.parse(raw) as Session) : null;
    const key = `session:${sessionId}`;
    const raw = RedisSessionStore.mockRedis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  }

  async delete(sessionId: string): Promise<void> {
    RedisSessionStore.mockRedis.delete(`session:${sessionId}`);
  }

  async size(): Promise<number> {
    return RedisSessionStore.mockRedis.size;
  }

  /**
   * 模拟 Pod 重启：外部存储不受影响
   *
   * 生产中：Pod 重启只是进程重启，Redis 是独立的服务，数据仍然在。
   * 新 Pod 启动后，直接从 Redis 读取 session 状态恢复对话。
   */
  simulatePodRestart(): void {
    console.log(
      `  [${this.storeName}] 模拟 Pod 重启 → Redis 数据不受影响，保留 ${RedisSessionStore.mockRedis.size} 条记录`
    );
  }
}

// ============================================================
// Agent 模拟：不感知底层存储实现
// ============================================================

/**
 * 模拟 agent 处理一条用户消息
 * 演示：上层 agent 逻辑通过 SessionStore 接口操作状态，
 * 不直接依赖具体存储实现，内存 Map 和 Redis 对它来说是透明的。
 */
async function handleUserMessage(
  store: SessionStore,
  sessionId: string,
  userInput: string
): Promise<void> {
  // 从 store 加载 session 状态
  const session = await store.get(sessionId);
  if (!session) {
    console.log(`  [Agent] sessionId=${sessionId} 不存在，对话无法续接`);
    return;
  }

  // 追加用户消息
  const updated: Session = {
    ...session,
    status: 'processing' as SessionStatus,
    contextMessages: [
      ...session.contextMessages,
      userMessage(userInput),
    ],
    lastActiveAt: Date.now(),
  };

  // 模拟 agent 生成回复
  const reply = `针对"${userInput}"的回复（基于 ${updated.contextMessages.length} 条历史消息）`;

  const withReply: Session = {
    ...updated,
    status: 'idle' as SessionStatus,
    contextMessages: [
      ...updated.contextMessages,
      assistantMessage(reply),
    ],
    lastActiveAt: Date.now(),
  };

  // 写回 store
  await store.set(withReply);

  console.log(`  [Agent] 处理完成，当前轮次消息数: ${withReply.contextMessages.length}`);
}

// ============================================================
// 演示：Pod 重启对两种方案的影响
// ============================================================

async function runDemo(store: SessionStore & {
  simulatePodRestart(): void;
}): Promise<void> {
  const LINE = '─'.repeat(60);

  console.log(`\n${LINE}`);
  console.log(`  存储方案：${store.storeName}`);
  console.log(LINE);

  // 创建一个 session，模拟用户开始对话
  const session = createSession('tenant_ecommerce', 'user_alice');
  await store.set(session);
  console.log(`\n  步骤 1：创建 session（id: ...${session.id.slice(-8)}）`);
  console.log(`  当前存储中 session 数量: ${await store.size()}`);

  // 用户发送第一条消息
  console.log('\n  步骤 2：用户发送消息 "我想查一下我的订单"');
  await handleUserMessage(store, session.id, '我想查一下我的订单');

  // 用户发送第二条消息（对话续接）
  console.log('\n  步骤 3：用户继续追问 "订单号 12345 的物流在哪里"');
  await handleUserMessage(store, session.id, '订单号 12345 的物流在哪里');

  // 验证状态已正确保存
  const beforeRestart = await store.get(session.id);
  console.log(
    `\n  步骤 4：验证对话状态 → 当前消息数: ${beforeRestart?.contextMessages.length ?? 0}`
  );

  // 模拟 Pod 重启（例如：部署新版本、OOM Kill）
  console.log('\n  步骤 5：模拟 Pod 重启...');
  store.simulatePodRestart();

  // 重启后，用户发送第三条消息
  console.log('\n  步骤 6：用户重启后继续发消息 "那个订单能退款吗"');
  const afterRestart = await store.get(session.id);

  if (afterRestart === null) {
    console.log(
      `  [结果] session 已丢失！agent 无法恢复上下文，只能重新开始对话。`
    );
    console.log(
      `         用户需要重新说明订单号，之前两轮对话的上下文全部丢失。`
    );
  } else {
    console.log(
      `  [结果] session 恢复成功！消息历史 ${afterRestart.contextMessages.length} 条完整保留。`
    );
    await handleUserMessage(store, session.id, '那个订单能退款吗');
    const final = await store.get(session.id);
    console.log(
      `         Agent 基于完整历史回复，消息数: ${final?.contextMessages.length ?? 0}`
    );
  }
}

// ============================================================
// main：对比两种方案
// ============================================================

async function main(): Promise<void> {
  console.log('Session 状态存储方案对比：进程内 Map vs 外部 Redis');
  console.log('验证：Pod 重启时哪种方案能恢复对话上下文\n');

  // 演示错误做法
  const memStore = new InMemorySessionStore();
  await runDemo(memStore);

  // 演示正确做法（两个"Pod"实例共享同一个 mock Redis）
  const redisStore1 = new RedisSessionStore();
  await runDemo(redisStore1);

  // 额外演示：多 Pod 场景下 Redis 的跨实例共享
  console.log('\n' + '═'.repeat(60));
  console.log('  额外演示：多 Pod 共享 Redis（内存 Map 无法做到）');
  console.log('═'.repeat(60));

  console.log('\n  Pod-A 创建了一个 session 并写入 Redis...');
  const podA = new RedisSessionStore();
  const sharedSession = createSession('tenant_saas', 'user_bob');
  await podA.set(sharedSession);
  await handleUserMessage(podA, sharedSession.id, '你好，我需要帮助');

  console.log('\n  负载均衡器把下一条消息路由到 Pod-B（新扩容的 Pod）...');
  // Pod-B 是一个全新的 RedisSessionStore 实例，模拟全新的 Pod
  // 但因为 mock Redis 是静态共享的，它能读到 Pod-A 写入的数据
  const podB = new RedisSessionStore();
  const sessionInPodB = await podB.get(sharedSession.id);

  if (sessionInPodB !== null) {
    console.log(
      `  [Pod-B] 从 Redis 读到 session，消息历史 ${sessionInPodB.contextMessages.length} 条，可以无缝续接对话`
    );
    await handleUserMessage(podB, sharedSession.id, '请帮我查一下账单');
  } else {
    console.log('  [Pod-B] 未能读取 session（预期不会出现这种情况）');
  }

  console.log('\n' + '─'.repeat(60));
  console.log('  结论：');
  console.log('  · 进程内 Map：Pod 重启 → 所有 session 丢失，对话无法续接');
  console.log('  · Redis 外部存储：Pod 重启/扩容 → 状态透明恢复，对话无缝续接');
  console.log('  · 真实实现详见第 7 章：状态管理与 Redis 数据结构设计');
  console.log('');
}

main().catch((err: unknown) => {
  console.error('运行出错:', err);
  process.exit(1);
});
