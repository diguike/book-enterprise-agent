/**
 * 第5章示例代码演示入口
 *
 * 演示内容：
 * 1. 注册内置 Skill 和租户自定义 Skill（Webhook、Code）
 * 2. 语义检索：根据用户消息找到最相关的 Skill
 * 3. 执行 Code Skill（isolated-vm 沙箱）
 * 4. 查看 BullMQ 队列配置（连接检查，不实际连接 Redis）
 *
 * 运行方式：
 *   npm install
 *   npx tsx src/index.ts
 *
 * 注意：isolated-vm 需要编译 native addon，运行前确保已安装构建工具：
 *   apt-get install python3 make g++ （Linux）
 *   xcode-select --install （macOS）
 */

import { SkillRegistry } from './registry.js';
import { executeSkill } from './executor.js';
import { builtinSkills } from './builtin/index.js';
import type { SkillContext, CodeSkillConfig, WebhookSkillConfig } from './types.js';

// ─── 演示：注册 Skill ─────────────────────────────────────────────

async function demoRegistration() {
  console.log('\n=== 1. Skill 注册演示 ===\n');

  const registry = new SkillRegistry();

  // 注册内置 Skill
  for (const skill of builtinSkills) {
    await registry.registerSkill({
      tenantId: null, // 平台内置，不属于任何租户
      name: skill.name,
      description: skill.description,
      type: 'builtin',
      config: {},
      inputSchema: {},
      outputSchema: {},
      isActive: true,
      timeoutMs: skill.timeout,
    });
  }

  console.log(`内置 Skill 注册完成，共 ${registry.size} 个\n`);

  // 注册租户 B 的 Webhook Skill（查账单）
  const webhookConfig: WebhookSkillConfig = {
    url: 'https://billing.tenant-b.example.com/api/query',
    method: 'POST',
    headers: { Authorization: 'Bearer tenant-b-api-token' },
    timeout: 10000,
    retryOnTimeout: false,
    webhookSecret: 'secret-for-signature-verification',
  };

  await registry.registerSkill({
    tenantId: 'tenant-b',
    name: '查询账单',
    description: `查询租户 B 企业账户下指定用户的 SaaS 产品账单信息。
适用：用户询问本月账单金额、各功能模块的使用量和费用明细。
不适用：查询历史账单（超过 12 个月）、查询其他企业的账单。
返回字段：总金额、账单周期、各功能模块明细列表。`,
    type: 'webhook',
    config: webhookConfig,
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '用户 ID' },
        month: { type: 'string', description: '账单月份，格式 YYYY-MM' },
      },
      required: ['userId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        totalAmount: { type: 'number' },
        breakdown: { type: 'array' },
      },
    },
    isActive: true,
    timeoutMs: 12000,
  });

  // 注册租户 B 的 Code Skill（格式化账单数据）
  const codeSkillConfig: CodeSkillConfig = {
    // 用户编写的 JavaScript 代码
    // 这段代码在 isolated-vm 沙箱内执行
    code: `
      // 将账单数据格式化为用户友好的文本
      function formatBilling(input) {
        const { totalAmount, breakdown, month } = input;

        // 格式化金额（分转元）
        const amountYuan = (totalAmount / 100).toFixed(2);

        // 构建明细文本
        const details = (breakdown || [])
          .map(item => \`  - \${item.name}: ¥\${(item.amount / 100).toFixed(2)}\`)
          .join('\\n');

        return {
          summary: \`\${month} 账单总金额：¥\${amountYuan}\`,
          details: details || '  暂无明细',
          formatted: \`账单月份：\${month}\\n总金额：¥\${amountYuan}\\n\\n费用明细：\\n\${details}\`,
        };
      }
    `,
    entrypoint: 'formatBilling',
    allowedUrls: [], // 这个 Skill 不需要网络访问
    memoryLimitMb: 64,
    cpuTimeLimitMs: 2000,
  };

  await registry.registerSkill({
    tenantId: 'tenant-b',
    name: '格式化账单',
    description: '将账单数据格式化为适合在对话中展示的文本格式，包含总金额和各模块费用明细。',
    type: 'code',
    config: codeSkillConfig,
    inputSchema: {
      type: 'object',
      properties: {
        totalAmount: { type: 'number', description: '总金额（分）' },
        breakdown: { type: 'array', description: '费用明细列表' },
        month: { type: 'string', description: '账单月份' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        details: { type: 'string' },
        formatted: { type: 'string' },
      },
    },
    isActive: true,
    timeoutMs: 5000,
  });

  console.log(`租户 B 自定义 Skill 注册完成，Registry 共 ${registry.size} 个 Skill\n`);

  return registry;
}

// ─── 演示：语义检索 ───────────────────────────────────────────────

async function demoSemanticSearch(registry: SkillRegistry) {
  console.log('\n=== 2. 语义检索演示 ===\n');

  const testCases = [
    { message: '帮我查一下上海明天的天气', tenantId: 'tenant-a' },
    { message: '我想知道我这个月花了多少钱', tenantId: 'tenant-b' },
    { message: '搜索一下最新的 AI 新闻', tenantId: 'tenant-a' },
    { message: '发一封邮件给我们的客户', tenantId: 'tenant-a' },
  ];

  for (const { message, tenantId } of testCases) {
    console.log(`用户消息（租户 ${tenantId}）: "${message}"`);
    const skills = await registry.findRelevantSkills(message, tenantId, 3);
    console.log(
      '检索结果:',
      skills.map((s) => `${s.name}(${s.type})`).join(', ') || '无匹配'
    );
    console.log();
  }
}

// ─── 演示：Code Skill 沙箱执行 ───────────────────────────────────

async function demoCodeSkillExecution(registry: SkillRegistry) {
  console.log('\n=== 3. Code Skill 沙箱执行演示 ===\n');

  // 构造内置 Skill Map（Executor 需要用来查找内置 Skill）
  const builtinSkillMap = new Map(builtinSkills.map((s) => [s.id, s]));

  // 执行上下文
  const context: SkillContext = {
    tenantId: 'tenant-b',
    sessionId: 'session-demo-001',
    userId: 'user-123',
    startedAt: Date.now(),
  };

  // 找到租户 B 注册的 Code Skill（格式化账单）
  const skills = registry.listSkillsForTenant('tenant-b');
  const codeSkill = skills.find((s) => s.type === 'code');

  if (!codeSkill) {
    console.log('未找到 Code Skill，跳过执行演示');
    return;
  }

  console.log(`找到 Code Skill: ${codeSkill.name}`);
  console.log('执行沙箱代码...\n');

  // 模拟账单数据（实际来自 Webhook Skill 的返回值）
  const billingData = {
    totalAmount: 158800, // 1588.00 元（分为单位）
    month: '2025-04',
    breakdown: [
      { name: 'API 调用费', amount: 98000 },
      { name: '存储费', amount: 32000 },
      { name: '带宽费', amount: 28800 },
    ],
  };

  const result = await executeSkill(codeSkill, billingData, context, builtinSkillMap);

  if (result.success) {
    console.log('沙箱执行成功！');
    console.log('执行结果:');
    console.log(JSON.stringify(result.data, null, 2));
    console.log(`执行耗时: ${result.latencyMs}ms`);
  } else {
    console.error('沙箱执行失败:', result.error);
  }
}

// ─── 演示：内置 Skill 执行 ────────────────────────────────────────

async function demoBuiltinSkillExecution(registry: SkillRegistry) {
  console.log('\n=== 4. 内置 Skill 执行演示 ===\n');

  const builtinSkillMap = new Map(builtinSkills.map((s) => [s.id, s]));

  const context: SkillContext = {
    tenantId: 'tenant-a',
    sessionId: 'session-demo-002',
    startedAt: Date.now(),
  };

  // 执行天气查询
  const weatherSkillRecord = registry.listSkillsForTenant('tenant-a')
    .find((s) => s.name === '查询天气');

  if (weatherSkillRecord) {
    console.log('执行天气查询 Skill...');
    const result = await executeSkill(
      weatherSkillRecord,
      { city: '上海', days: 3 },
      context,
      builtinSkillMap
    );

    if (result.success) {
      console.log('天气查询结果:', JSON.stringify(result.data, null, 2));
    } else {
      console.error('天气查询失败:', result.error);
    }
  }
}

// ─── 演示：BullMQ 队列说明 ────────────────────────────────────────

async function demoBullMQConfig() {
  console.log('\n=== 5. BullMQ 队列说明 ===\n');

  console.log('BullMQ 队列配置（需要 Redis 连接才能实际运行）：');
  console.log('');
  console.log('  队列名称: agentflow:skill-execution');
  console.log('  重试策略: 最多 3 次，指数退避（1s, 2s, 4s）');
  console.log('  并发数: 10（单机示例）/ 5×N副本（生产）');
  console.log('');
  console.log('投递任务示例：');
  console.log(`
  const queue = createSkillQueue(createRedisConnection());
  const jobId = await enqueueSkillExecution(queue, {
    skillId: 'skill_xxx',
    tenantId: 'tenant-b',
    sessionId: 'session-001',
    input: { userId: 'user-123', month: '2025-04' },
    idempotencyKey: 'session-001:skill_xxx:1714500000',
  });
  `);
  console.log('等待结果：');
  console.log(`
  const result = await waitForJobResult(queue, jobId, 30000);
  `);
  console.log('生产注意：');
  console.log('  - at-least-once 语义，Skill 执行必须幂等');
  console.log('  - 用 idempotencyKey 防止崩溃重启后重复执行');
  console.log('  - Redis AOF 持久化配置，防止重启后任务状态丢失\n');
}

// ─── 主函数 ───────────────────────────────────────────────────────

async function main() {
  console.log('第5章：Skill 系统 - 示例代码演示');
  console.log('='.repeat(50));

  try {
    // 1. 注册 Skill
    const registry = await demoRegistration();

    // 2. 语义检索演示
    await demoSemanticSearch(registry);

    // 3. Code Skill 沙箱执行（需要 isolated-vm）
    try {
      await demoCodeSkillExecution(registry);
    } catch (err) {
      // isolated-vm 需要 native addon 编译
      // 如果未安装构建工具，跳过沙箱演示，不影响其他功能
      if (err instanceof Error && err.message.includes('Cannot find module')) {
        console.log('⚠ isolated-vm 未安装，跳过沙箱演示');
        console.log('  安装方式: npm install（需要 python3 + make + g++）\n');
      } else {
        throw err;
      }
    }

    // 4. 内置 Skill 执行
    await demoBuiltinSkillExecution(registry);

    // 5. BullMQ 说明
    await demoBullMQConfig();

    console.log('='.repeat(50));
    console.log('演示完成。');
  } catch (err) {
    console.error('演示执行出错:', err);
    process.exit(1);
  }
}

main();
