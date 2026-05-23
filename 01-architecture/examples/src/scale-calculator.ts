/**
 * scale-calculator.ts
 *
 * 演示第 1 章 1.1 节的规模换算逻辑。
 * 把"1M 并发 session + 50K QPS"这两个常见目标数字拆解成
 * 真实的基础设施压力指标，帮助工程师做容量规划。
 *
 * 运行方法：
 *   npx tsx src/scale-calculator.ts
 */

// ============================================================
// 输入参数类型
// ============================================================

/**
 * 规模换算的输入参数
 */
interface ScaleParams {
  /** 系统维护的总 session 数（并发活跃对话状态数量） */
  totalSessions: number;
  /** 任意时刻处于活跃处理状态的 session 比例（0–1） */
  activeRatio: number;
  /** 每次用户请求触发的平均推理步骤数（ReAct 循环次数） */
  avgStepsPerRequest: number;
  /** 每步推理平均发起的 LLM 调用次数（包含工具选择、结果解析等） */
  avgLLMCallsPerStep: number;
  /** 单个 LLM 调用的平均响应时间（秒） */
  avgLLMLatencySec: number;
  /** 用户侧每秒请求数（HTTP 请求总量，含轮询/状态查询） */
  userQPS: number;
  /** 用户请求中实际触发 agent 推理的比例（0–1），其余为轻量查询 */
  inferenceRatio: number;
  /** 场景名称，用于输出表格标题 */
  scenarioName: string;
}

// ============================================================
// 换算结果类型
// ============================================================

/**
 * 规模换算结果
 */
interface ScaleResult {
  scenarioName: string;
  // 输入参数（格式化后）
  totalSessions: string;
  userQPS: string;
  // 换算结果
  activeSessions: string;
  inferenceQPS: string;
  llmCallsPerSec: string;
  llmConcurrentConnections: string;
  // 资源压力说明
  stateStoragePressure: string;
  llmGatewayPressure: string;
}

// ============================================================
// 核心换算类
// ============================================================

/**
 * ScaleCalculator：将业务目标数字换算为基础设施压力指标
 *
 * 换算逻辑：
 *   真实并发 session = totalSessions × activeRatio
 *   每秒推理请求    = userQPS × inferenceRatio
 *   每秒 LLM 调用  = 每秒推理请求 × avgStepsPerRequest × avgLLMCallsPerStep
 *   LLM 并发连接   = 每秒 LLM 调用 × avgLLMLatencySec（Little's Law）
 */
class ScaleCalculator {
  private readonly params: ScaleParams;

  constructor(params: ScaleParams) {
    this.params = params;
  }

  /**
   * 真实并发 session 数：只有这部分在等待 LLM 响应或工具调用。
   * 其余 session 处于等待用户输入状态，占内存但不占 CPU/LLM 资源。
   */
  get activeSessions(): number {
    return Math.round(this.params.totalSessions * this.params.activeRatio);
  }

  /**
   * 实际触发 agent 推理的 QPS（区别于轮询、状态查询等轻量请求）
   */
  get inferenceQPS(): number {
    return Math.round(this.params.userQPS * this.params.inferenceRatio);
  }

  /**
   * 发向 LLM provider 的每秒调用数
   * 一次用户推理请求 = avgStepsPerRequest 步 × avgLLMCallsPerStep 次 LLM 调用
   */
  get llmCallsPerSec(): number {
    return Math.round(
      this.inferenceQPS *
        this.params.avgStepsPerRequest *
        this.params.avgLLMCallsPerStep
    );
  }

  /**
   * LLM 层真实并发连接数（使用 Little's Law：并发 = 到达率 × 响应时间）
   *
   * 这个数字决定了 LLM Gateway 需要维护多少持久连接，
   * 也是成本控制的核心变量——每个并发连接都在消耗 GPU 资源。
   */
  get llmConcurrentConnections(): number {
    return Math.round(this.llmCallsPerSec * this.params.avgLLMLatencySec);
  }

  /**
   * 状态存储压力描述：基于 totalSessions 判断
   */
  get stateStoragePressure(): string {
    const sessions = this.params.totalSessions;
    if (sessions >= 1_000_000) {
      return '高 — 需要 Redis Cluster + PostgreSQL 分区表';
    } else if (sessions >= 100_000) {
      return '中 — 单节点 Redis 可能不够，需要评估内存';
    } else {
      return '低 — 单节点 Redis 足够';
    }
  }

  /**
   * LLM Gateway 压力描述：基于并发连接数判断
   */
  get llmGatewayPressure(): string {
    const conns = this.llmConcurrentConnections;
    if (conns >= 5_000) {
      return '高 — 需要连接池管理 + provider 限流策略';
    } else if (conns >= 1_000) {
      return '中 — 需要监控 429 错误，预留重试预算';
    } else {
      return '低 — 单个 provider 账号通常可以承载';
    }
  }

  /**
   * 执行换算并返回格式化结果
   */
  calculate(): ScaleResult {
    // 格式化大数字，提高可读性（千分位分隔符）
    const fmt = (n: number): string => n.toLocaleString('en-US');

    return {
      scenarioName: this.params.scenarioName,
      totalSessions: fmt(this.params.totalSessions),
      userQPS: fmt(this.params.userQPS),
      activeSessions: fmt(this.activeSessions),
      inferenceQPS: fmt(this.inferenceQPS),
      llmCallsPerSec: fmt(this.llmCallsPerSec),
      llmConcurrentConnections: fmt(this.llmConcurrentConnections),
      stateStoragePressure: this.stateStoragePressure,
      llmGatewayPressure: this.llmGatewayPressure,
    };
  }
}

// ============================================================
// 输出工具函数
// ============================================================

/**
 * 打印单个场景的换算结果
 */
function printScenario(result: ScaleResult): void {
  const LINE = '─'.repeat(60);

  console.log(`\n${LINE}`);
  console.log(`  场景：${result.scenarioName}`);
  console.log(LINE);

  // 输入
  console.log('  [输入]');
  console.log(`    总 session 数       : ${result.totalSessions}`);
  console.log(`    用户侧 QPS          : ${result.userQPS}`);
  console.log('');

  // 换算结果
  console.log('  [换算结果]');
  console.log(`    真实并发 session    : ${result.activeSessions}`);
  console.log(`    触发推理的 QPS      : ${result.inferenceQPS}`);
  console.log(`    LLM 每秒调用数      : ${result.llmCallsPerSec}`);
  console.log(`    LLM 真实并发连接    : ${result.llmConcurrentConnections}`);
  console.log('');

  // 压力评估
  console.log('  [压力评估]');
  console.log(`    状态存储压力        : ${result.stateStoragePressure}`);
  console.log(`    LLM Gateway 压力    : ${result.llmGatewayPressure}`);
}

/**
 * 打印三个场景的对比表格（使用 console.table）
 */
function printComparisonTable(results: ScaleResult[]): void {
  console.log('\n\n' + '═'.repeat(60));
  console.log('  三场景对比表格');
  console.log('═'.repeat(60));

  // console.table 会自动对齐列，适合快速对比
  console.table(
    results.map((r) => ({
      场景: r.scenarioName,
      总Session: r.totalSessions,
      用户QPS: r.userQPS,
      真实并发Session: r.activeSessions,
      推理QPS: r.inferenceQPS,
      LLM每秒调用: r.llmCallsPerSec,
      LLM并发连接: r.llmConcurrentConnections,
    }))
  );
}

// ============================================================
// main：演示三种典型场景
// ============================================================

function main(): void {
  console.log('AgentFlow 规模换算计算器');
  console.log('将业务目标数字（session 数、QPS）拆解为基础设施压力指标');

  // ---- 场景一：低峰期（凌晨 2 点，流量低谷） ----
  const offPeak = new ScaleCalculator({
    scenarioName: '低峰期（凌晨 2 点）',
    totalSessions: 50_000,    // 5 万 session 仍在内存中（用户未关闭窗口）
    activeRatio: 0.005,       // 0.5% 活跃，大多数用户已离开
    avgStepsPerRequest: 3,    // 低峰期请求简单，步骤少
    avgLLMCallsPerStep: 2,    // 每步 2 次 LLM 调用（意图识别 + 回复）
    avgLLMLatencySec: 2,      // 平均 2 秒首 token
    userQPS: 500,             // 总请求稀少
    inferenceRatio: 0.15,     // 低峰期轮询比例更高，真实推理更少
  });

  // ---- 场景二：正常工作日（上午 10 点） ----
  const normal = new ScaleCalculator({
    scenarioName: '正常工作日（上午 10 点）',
    totalSessions: 200_000,   // 20 万活跃对话
    activeRatio: 0.02,        // 2% 活跃
    avgStepsPerRequest: 5,    // 工具调用链中等复杂度
    avgLLMCallsPerStep: 3,    // 每步 3 次（意图 + 工具选择 + 结果解析）
    avgLLMLatencySec: 2,
    userQPS: 10_000,          // 正常流量
    inferenceRatio: 0.1,      // 10% 触发真实推理，其余是状态查询/轮询
  });

  // ---- 场景三：双十一峰值 ----
  const peak = new ScaleCalculator({
    scenarioName: '双十一峰值（电商租户 50x 流量）',
    totalSessions: 1_000_000, // 书中的目标规模：100 万并发 session
    activeRatio: 0.01,        // 1% 活跃，即 1 万真实并发
    avgStepsPerRequest: 8,    // 高峰期查订单/退款流程复杂，步骤多
    avgLLMCallsPerStep: 4,    // 每步包含 ReAct 循环，调用次数多
    avgLLMLatencySec: 3,      // 高峰期 LLM 响应变慢（provider 也在排队）
    userQPS: 50_000,          // 目标 50K QPS
    inferenceRatio: 0.1,
  });

  // 打印三个场景的详细结果
  const results = [offPeak, normal, peak].map((c) => c.calculate());
  for (const r of results) {
    printScenario(r);
  }

  // 打印对比表格
  printComparisonTable(results);

  // 打印关键结论
  console.log('\n' + '─'.repeat(60));
  console.log('  关键结论');
  console.log('─'.repeat(60));
  console.log(
    '  1. 1M session ≠ 1M 并发处理：真实并发只有 1% 左右（约 1 万）'
  );
  console.log(
    '  2. 状态存储是主要挑战：需要高效管理 100 万份 session 状态'
  );
  console.log(
    '  3. LLM 真实并发连接约 1.2 万：这才是 GPU 资源和成本的决定因素'
  );
  console.log(
    '  4. 50K 用户 QPS 中只有 5K 触发推理：区分流量类型才能正确选型'
  );
  console.log('');
}

main();
