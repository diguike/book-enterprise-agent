/**
 * 第6章演示：知识库 RAG 完整流程
 *
 * 演示内容：
 * 1. 上传《双十一活动条款》Markdown 文档，触发入库流水线
 * 2. 上传平台内置通用客服手册
 * 3. 用三种检索策略（vector / bm25 / hybrid）检索几个问题
 * 4. 展示多租户隔离效果（不同租户只能检索自己的内容）
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

import {
  createDocument,
  getDocument,
  runIngestionPipeline,
  ingestBuiltinContent,
  resetPipelineStore,
} from './pipeline.js';
import { hybridSearch } from './retriever.js';
import { MockEmbeddingProvider, embedSingleText } from './embedder.js';

// ─────────────────────────────────────────────
// 演示文档内容
// ─────────────────────────────────────────────

const DOUBLE_ELEVEN_POLICY = `# 双十一活动条款

## 活动时间

本次双十一活动时间为 2024 年 11 月 1 日 00:00:00 至 2024 年 11 月 11 日 23:59:59。

## 活动商品范围

参与本次活动的商品以活动页面展示为准。部分特殊商品（如定制商品、生鲜商品、虚拟商品）不参与活动。

## 优惠规则

满减优惠：每满 300 元减 50 元，可叠加使用，上限 3 次。

优惠券：用户领取的优惠券须在有效期内使用，过期作废。

优惠不与其他促销活动叠加使用，以实际结算页面为准。

## 退换货政策

活动期间购买的商品支持 7 天无理由退货，以下商品除外：
- 拆封后影响二次销售的商品（如食品、化妆品）
- 定制商品
- 数字商品（下载码、会员卡等）

退货需保持商品完好，包装齐全，附原始发票。

退款将在收到退货后 3 个工作日内退回原支付渠道。

因商品质量问题引起的退换货，运费由平台承担。

## 发货规则

活动期间订单将在 72 小时内发出（大件商品除外）。

遇节假日或不可抗力因素，发货时间将适当延长。

## 注意事项

同一用户同一商品限购 5 件。

活动期间下单后 24 小时内支付方可享受活动价格。
`;

const BUILTIN_KNOWLEDGE = `# 平台通用客服手册

## 如何联系人工客服

在线客服服务时间：周一至周日 9:00-22:00。

可通过以下渠道联系：
- 平台内聊天工具（页面右下角客服图标）
- 电话：400-xxx-xxxx
- 邮件：support@example.com

## 账号安全

发现账号异常（如陌生登录记录、密码被修改），请立即：
1. 修改密码
2. 解绑并重新绑定手机号
3. 联系客服冻结账号进行核查

## 发票申请

订单完成后 30 天内可申请发票。进入「我的订单」→「申请发票」，填写开票信息。增值税专用发票需在购买前申请，事后无法补开。
`;

// ─────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────

/** 打印章节分隔线 */
function printSection(title: string): void {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

/** 打印检索结果 */
function printSearchResults(
  question: string,
  results: Array<{
    id: string;
    content: string;
    score: number;
    tenantId: string | null;
    metadata: { heading?: string };
  }>
): void {
  console.log(`\n问题: "${question}"`);
  console.log(`检索到 ${results.length} 条结果：`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const source = r.tenantId === null ? '[内置]' : '[租户]';
    const heading = r.metadata.heading ? ` (${r.metadata.heading})` : '';
    const preview = r.content.slice(0, 80).replace(/\n/g, ' ');
    console.log(
      `  ${i + 1}. ${source}${heading} | 分数: ${r.score.toFixed(4)} | ${preview}...`
    );
  }
}

// ─────────────────────────────────────────────
// 主演示流程
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  // 重置状态（防止重复运行时数据叠加）
  resetPipelineStore();

  const provider = new MockEmbeddingProvider();
  const TENANT_A_ID = randomUUID();  // 模拟电商租户 A

  // ────────────────────────────────────────────
  // 步骤 1：上传平台内置知识库
  // ────────────────────────────────────────────
  printSection('步骤 1：上传平台内置知识库');

  const builtinResult = await ingestBuiltinContent(
    '平台通用客服手册',
    BUILTIN_KNOWLEDGE
  );
  console.log(
    `内置知识库入库完成: ${builtinResult.totalChunks} 个 chunk`
  );

  // ────────────────────────────────────────────
  // 步骤 2：租户 A 上传双十一活动条款（Markdown）
  // ────────────────────────────────────────────
  printSection('步骤 2：租户 A 上传《双十一活动条款》');

  // 写入临时文件（演示用）
  const tmpDir = os.tmpdir();
  const mdFilePath = path.join(tmpDir, 'double-eleven-policy.md');
  await fs.writeFile(mdFilePath, DOUBLE_ELEVEN_POLICY, 'utf-8');

  const documentId = createDocument(TENANT_A_ID, '双十一活动条款', 'md');
  const pipelineResult = await runIngestionPipeline({
    documentId,
    tenantId: TENANT_A_ID,
    filePath: mdFilePath,
    fileType: 'md',
  });

  console.log('\n入库结果:');
  console.log(`  文档 ID: ${pipelineResult.documentId}`);
  console.log(`  分块数量: ${pipelineResult.totalChunks}`);
  console.log(`  总耗时: ${pipelineResult.durationMs}ms`);
  console.log(`  各阶段: 解析 ${pipelineResult.stages.parse}ms | 分块 ${pipelineResult.stages.chunk}ms | 向量化 ${pipelineResult.stages.embed}ms | 存储 ${pipelineResult.stages.store}ms`);

  const doc = getDocument(documentId);
  console.log(`  文档状态: ${doc?.status}`);

  // ────────────────────────────────────────────
  // 步骤 3：检索测试
  // ────────────────────────────────────────────
  printSection('步骤 3：检索测试');

  const testQuestions = [
    {
      question: '双十一活动期间购买的商品可以无理由退货吗？',
      strategy: 'hybrid' as const,
      description: '核心场景：检索退货政策',
    },
    {
      question: '活动商品多少钱可以优惠',
      strategy: 'vector' as const,
      description: '纯向量检索：语义相似度匹配',
    },
    {
      question: '如何联系客服',
      strategy: 'hybrid' as const,
      description: '混合检索：应该召回内置知识库内容',
    },
    {
      question: '发货时间',
      strategy: 'bm25' as const,
      description: '纯 BM25：关键词精确匹配',
    },
  ];

  for (const { question, strategy, description } of testQuestions) {
    console.log(`\n[${strategy.toUpperCase()}] ${description}`);

    const queryEmbedding = await embedSingleText(question, provider);
    const results = await hybridSearch({
      tenantId: TENANT_A_ID,
      query: question,
      queryEmbedding,
      includeBuiltin: true,
      tenantContentBoost: 1.2,
      limit: 3,
      strategy,
    });

    printSearchResults(question, results);
  }

  // ────────────────────────────────────────────
  // 步骤 4：多租户隔离测试
  // ────────────────────────────────────────────
  printSection('步骤 4：多租户隔离测试');

  const TENANT_B_ID = randomUUID();  // 另一个租户 B（SaaS 软件租户）

  console.log(`\n租户 B（未上传任何文档）查询"退货政策"：`);

  const queryEmbedding = await embedSingleText(
    '双十一活动期间购买的商品可以退货吗',
    provider
  );

  // 租户 B 关闭内置知识库（模拟金融租户严格隔离场景）
  const resultsB_noBuiltin = await hybridSearch({
    tenantId: TENANT_B_ID,
    query: '双十一活动期间购买的商品可以退货吗',
    queryEmbedding,
    includeBuiltin: false,   // 关闭内置知识库
    tenantContentBoost: 1.2,
    limit: 3,
    strategy: 'hybrid',
  });

  console.log(
    `  关闭内置知识库时，租户 B 检索到 ${resultsB_noBuiltin.length} 条结果（预期为 0）`
  );

  // 租户 B 开启内置知识库（能访问平台内置内容，但看不到租户 A 的私有文档）
  const resultsB_withBuiltin = await hybridSearch({
    tenantId: TENANT_B_ID,
    query: '双十一活动期间购买的商品可以退货吗',
    queryEmbedding,
    includeBuiltin: true,    // 开启内置知识库
    tenantContentBoost: 1.2,
    limit: 3,
    strategy: 'hybrid',
  });

  console.log(
    `  开启内置知识库时，租户 B 检索到 ${resultsB_withBuiltin.length} 条结果`
  );

  // 验证租户 B 的结果里没有租户 A 的内容
  const leakedResults = resultsB_withBuiltin.filter(
    (r) => r.tenantId === TENANT_A_ID
  );
  if (leakedResults.length > 0) {
    console.error('  [错误] 租户隔离失败：租户 B 访问到了租户 A 的数据！');
  } else {
    console.log('  [通过] 租户隔离正常：租户 B 只能访问内置知识库内容');
  }

  if (resultsB_withBuiltin.length > 0) {
    console.log('\n  租户 B 的检索结果（仅来自内置知识库）：');
    for (const r of resultsB_withBuiltin) {
      const heading = r.metadata.heading ?? '无标题';
      console.log(
        `    - [${r.tenantId === null ? '内置' : '租户'}] ${heading} | 分数: ${r.score.toFixed(4)}`
      );
    }
  }

  // ────────────────────────────────────────────
  // 清理临时文件
  // ────────────────────────────────────────────
  await fs.unlink(mdFilePath).catch(() => {});

  printSection('演示完成');
  console.log('知识库 RAG 流程验证通过。');
  console.log('\n生产部署检查清单：');
  console.log('  □ 替换 MockEmbeddingProvider 为 VoyageEmbeddingProvider 或 OpenAIEmbeddingProvider');
  console.log('  □ 替换内存存储为 PostgreSQL + pgvector');
  console.log('  □ 部署 BullMQ Worker 处理异步入库 Job');
  console.log('  □ 配置中文分词扩展（pg_jieba 或 zhparser）用于 BM25 检索');
  console.log('  □ 为 knowledge_chunks 建 HNSW 索引（m=16, ef_construction=64）');
}

// ─────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────

main().catch((error) => {
  console.error('[Fatal]', error);
  process.exit(1);
});
