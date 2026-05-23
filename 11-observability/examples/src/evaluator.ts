/**
 * LLM as Judge 评估实现
 *
 * 提供两种评估方式：
 *   - pointwise：单条样本评分（相关性、准确性、流畅性等）
 *   - pairwise：A/B 对比（用于 prompt 迭代或模型选型）
 *
 * 关键约定：
 *   - Judge 模型的 temperature 必须 = 0，否则评分不可重复
 *   - 输出用 Zod 强约束，parse 失败时重试或 fallback
 *   - pairwise 通过随机交换位置缓解 position bias
 */

import { z } from 'zod';

// ============ 类型 schema ============

const PointwiseSchema = z.object({
  score: z.number().min(1).max(5),
  reasoning: z.string(),
});
export type PointwiseResult = z.infer<typeof PointwiseSchema>;

const PairwiseRawSchema = z.object({
  winner: z.enum(['1', '2', 'tie']),
  reasoning: z.string(),
});

export interface PairwiseResult {
  winner: 'A' | 'B' | 'tie';
  reasoning: string;
}

// ============ 模拟 Judge LLM 调用（真实项目替换为实际 client） ============

interface JudgeCallArgs {
  prompt: string;
  /** 评估场景 temperature 必须 = 0 */
  temperature: 0;
}

async function callJudgeLlm(args: JudgeCallArgs): Promise<string> {
  // 真实项目：调 Claude / GPT 等。这里返回一个 mock JSON。
  await new Promise((resolve) => setTimeout(resolve, 100));
  // mock 返回值仅用于 demo，让代码能跑通
  if (args.prompt.includes('哪个更好')) {
    return JSON.stringify({ winner: '1', reasoning: '回复 1 更详细且相关' });
  }
  return JSON.stringify({ score: 4, reasoning: '回复覆盖了主要意图，缺少一点细节' });
}

// ============ Pointwise 相关性评估 ============

export async function evaluateRelevance(
  userMessage: string,
  agentResponse: string,
): Promise<PointwiseResult> {
  const judgePrompt = `你是评估专家。给定用户问题和 Agent 回复，评估回复的相关性。

评分规则：
- 5 = 完全相关，直接命中用户意图
- 4 = 相关，覆盖主要意图
- 3 = 部分相关，遗漏关键信息
- 2 = 弱相关，答非所问但有部分关联
- 1 = 完全不相关

用户问题：${userMessage}
Agent 回复：${agentResponse}

只输出严格的 JSON，不要任何额外文字：
{"score": number, "reasoning": "string"}`;

  return runWithRetry(async () => {
    const raw = await callJudgeLlm({ prompt: judgePrompt, temperature: 0 });
    const parsed = JSON.parse(stripCodeFence(raw));
    return PointwiseSchema.parse(parsed);
  });
}

// ============ Pointwise 准确性评估（需要金标） ============

export async function evaluateAccuracy(
  userMessage: string,
  agentResponse: string,
  groundTruth: string,
): Promise<PointwiseResult> {
  const judgePrompt = `你是评估专家。给定用户问题、Agent 回复和金标答案，评估回复的准确性。

评分规则：
- 5 = 与金标完全一致或语义等价
- 4 = 基本一致，细节有小差异
- 3 = 部分正确，包含错误信息
- 2 = 大部分错误
- 1 = 完全错误

用户问题：${userMessage}
Agent 回复：${agentResponse}
金标答案：${groundTruth}

只输出 JSON：{"score": number, "reasoning": "string"}`;

  return runWithRetry(async () => {
    const raw = await callJudgeLlm({ prompt: judgePrompt, temperature: 0 });
    const parsed = JSON.parse(stripCodeFence(raw));
    return PointwiseSchema.parse(parsed);
  });
}

// ============ Pairwise 对比评估 ============

/**
 * 比较两个回复哪个更好。
 * 内部会随机交换 A/B 顺序，规避 Judge LLM 的位置偏见。
 */
export async function pairwiseCompare(
  userMessage: string,
  responseA: string,
  responseB: string,
): Promise<PairwiseResult> {
  // 50% 概率交换位置
  const swap = Math.random() < 0.5;
  const [first, second] = swap ? [responseB, responseA] : [responseA, responseB];

  const judgePrompt = `你是评估专家。给定用户问题和两个 Agent 回复，判断哪个更好。
评估维度：相关性、准确性、清晰度。

用户问题：${userMessage}

回复 1：${first}

回复 2：${second}

只输出严格的 JSON：
{"winner": "1" | "2" | "tie", "reasoning": "string"}`;

  return runWithRetry(async () => {
    const raw = await callJudgeLlm({ prompt: judgePrompt, temperature: 0 });
    const parsed = PairwiseRawSchema.parse(JSON.parse(stripCodeFence(raw)));

    // 翻译回原始 A/B
    let winner: 'A' | 'B' | 'tie';
    if (parsed.winner === 'tie') {
      winner = 'tie';
    } else if (parsed.winner === '1') {
      winner = swap ? 'B' : 'A';
    } else {
      winner = swap ? 'A' : 'B';
    }

    return { winner, reasoning: parsed.reasoning };
  });
}

// ============ 数据集级评估：跑一组样本得平均分 ============

export interface EvalSample {
  userMessage: string;
  agentResponse: string;
  groundTruth?: string;
}

export interface EvalReport {
  total: number;
  relevanceAvg: number;
  accuracyAvg: number | null;
  byScore: Record<number, number>;
}

export async function runEvalsOnDataset(samples: EvalSample[]): Promise<EvalReport> {
  const relevanceScores: number[] = [];
  const accuracyScores: number[] = [];
  const byScore: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  // 真实生产里要做并发控制，避免一次性打爆 Judge LLM 配额
  const concurrency = 5;
  for (let i = 0; i < samples.length; i += concurrency) {
    const batch = samples.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (s) => {
        const rel = await evaluateRelevance(s.userMessage, s.agentResponse);
        const acc = s.groundTruth
          ? await evaluateAccuracy(s.userMessage, s.agentResponse, s.groundTruth)
          : null;
        return { rel, acc };
      }),
    );
    for (const { rel, acc } of results) {
      relevanceScores.push(rel.score);
      byScore[rel.score] = (byScore[rel.score] ?? 0) + 1;
      if (acc) accuracyScores.push(acc.score);
    }
  }

  const avg = (arr: number[]): number =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    total: samples.length,
    relevanceAvg: avg(relevanceScores),
    accuracyAvg: accuracyScores.length > 0 ? avg(accuracyScores) : null,
    byScore,
  };
}

// ============ 回归测试：与基线对比 ============

export interface RegressionThresholds {
  /** 相关性平均分允许的最大跌幅 */
  maxRelevanceDrop: number;
  /** 准确性平均分允许的最大跌幅 */
  maxAccuracyDrop: number;
}

export function assertNoRegression(
  baseline: EvalReport,
  current: EvalReport,
  thresholds: RegressionThresholds,
): void {
  if (baseline.relevanceAvg - current.relevanceAvg > thresholds.maxRelevanceDrop) {
    throw new Error(
      `相关性退步 ${(baseline.relevanceAvg - current.relevanceAvg).toFixed(3)}，` +
        `超过阈值 ${thresholds.maxRelevanceDrop}`,
    );
  }
  if (
    baseline.accuracyAvg !== null &&
    current.accuracyAvg !== null &&
    baseline.accuracyAvg - current.accuracyAvg > thresholds.maxAccuracyDrop
  ) {
    throw new Error(
      `准确性退步 ${(baseline.accuracyAvg - current.accuracyAvg).toFixed(3)}，` +
        `超过阈值 ${thresholds.maxAccuracyDrop}`,
    );
  }
}

// ============ 工具函数 ============

/** 去掉 LLM 偶尔包的 ```json ... ``` 代码围栏 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }
  return trimmed;
}

/** Judge LLM 偶尔会输出格式错的 JSON，retry 一次 */
async function runWithRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ============ Demo ============

async function main(): Promise<void> {
  // Pointwise
  const rel = await evaluateRelevance(
    '帮我查订单 ORD-123 的状态',
    '您的订单 ORD-123 正在配送中，预计明天送达。',
  );
  // eslint-disable-next-line no-console
  console.log('relevance:', rel);

  // Pairwise
  const pair = await pairwiseCompare(
    '退款政策是什么？',
    '7 天内无理由退款，需保持商品完好。',
    '可以退款。',
  );
  // eslint-disable-next-line no-console
  console.log('pairwise:', pair);

  // Dataset eval
  const samples: EvalSample[] = [
    {
      userMessage: '订单到哪了？',
      agentResponse: '您的订单 ORD-123 正在配送中。',
      groundTruth: '订单 ORD-123 当前状态为配送中。',
    },
    {
      userMessage: '怎么退款？',
      agentResponse: '7 天内无理由退款，保持商品完好。',
      groundTruth: '7 天内无理由，需商品未拆封。',
    },
  ];
  const report = await runEvalsOnDataset(samples);
  // eslint-disable-next-line no-console
  console.log('report:', report);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
