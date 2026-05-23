/**
 * 启动配置：集中读取环境变量，缺失时给出明确错误。
 */

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  anthropicApiKey: string;
  jwtSecret: string;
  databaseUrl: string;
  redisUrl: string;
  demoTenantId: string;
  demoTenantSlug: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[config] 缺少必填环境变量：${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '0.0.0.0',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    jwtSecret: process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me',
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgresql://agentflow:agentflow_dev_password@localhost:5432/agentflow',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    demoTenantId:
      process.env.DEMO_TENANT_ID ?? '00000000-0000-0000-0000-000000000001',
    demoTenantSlug: process.env.DEMO_TENANT_SLUG ?? 'tenant-ecommerce',
  };
}
