/**
 * 入口文件
 *
 * 支持两种运行模式：
 * 1. 服务器模式（默认）：启动 Fastify HTTP 服务，提供 SSE 流式聊天端点
 * 2. 演示模式（--demo 参数）：直接运行 agent 对话演示，无需 HTTP 服务
 *
 * 运行方式：
 *   npm run dev           → 启动服务器（需要 ANTHROPIC_API_KEY 环境变量）
 *   npm run dev -- --demo → 运行对话演示
 */

import { createServer } from './server.js';
import { mastra, demoConversation } from './agent.js';
import { demoPlannerExecutor } from './planner-executor.js';

// 从命令行参数判断运行模式
const isDemo = process.argv.includes('--demo');
const isDemoPlanner = process.argv.includes('--demo-per');

// 检查必要的环境变量
function checkEnv(): void {
  const required = ['ANTHROPIC_API_KEY'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`缺少必要的环境变量：${missing.join(', ')}`);
    console.error('请在项目根目录创建 .env 文件，内容：');
    console.error('ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  checkEnv();

  if (isDemo) {
    // 演示模式：直接运行电商 agent 对话
    console.log('运行 Agent 对话演示...\n');
    await demoConversation();
    process.exit(0);
  }

  if (isDemoPlanner) {
    // 演示模式：运行 Planner-Executor-Reflector 模型
    console.log('运行 P-E-R 模型演示...\n');
    const agent = mastra.getAgent('ecommerceAgent');
    await demoPlannerExecutor(agent);
    process.exit(0);
  }

  // 服务器模式：启动 Fastify HTTP 服务
  const server = createServer();

  // 监听进程退出信号，优雅关闭
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`收到 ${signal} 信号，正在关闭服务器...`);
    await server.close();
    console.log('服务器已关闭');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    // 监听 3000 端口
    // 生产注意：端口和 host 应从环境变量读取
    const host = process.env.HOST ?? '0.0.0.0';
    const port = parseInt(process.env.PORT ?? '3000', 10);

    await server.listen({ host, port });
    console.log(`\n服务器已启动：http://localhost:${port}`);
    console.log('\n可用端点：');
    console.log('  POST /api/chat       → 流式聊天（SSE）');
    console.log('  POST /api/chat/sync  → 同步聊天（非流式，用于测试）');
    console.log('  GET  /health         → 健康检查');
    console.log('\n流式聊天示例（curl）：');
    console.log(`  curl -X POST http://localhost:${port}/api/chat \\`);
    console.log('    -H "Content-Type: application/json" \\');
    console.log('    -d \'{"message":"订单 #12345 在哪里","sessionId":"s1","tenantId":"tenant-ecommerce","userId":"u1"}\'');
  } catch (err) {
    console.error('服务器启动失败：', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('未捕获的错误：', err);
  process.exit(1);
});
