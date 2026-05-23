/**
 * 仅用于本地开发的辅助路由：
 *   - GET  /api/v1/dev/token  → 签发一个演示 JWT
 *   - GET  /api/v1/dev/orders → 列出 Mock 订单号，便于测试
 *
 * 生产环境必须移除整个路由前缀。
 */

import type { FastifyInstance } from 'fastify';
import { signDevToken } from '../auth.js';
import { MOCK_ORDER_IDS } from '@agentflow/agent-engine';

export interface DevRouteDeps {
  jwtSecret: string;
  demoTenantId: string;
  demoTenantSlug: string;
}

export async function devRoutes(
  app: FastifyInstance,
  deps: DevRouteDeps
): Promise<void> {
  app.get('/api/v1/dev/token', async () => {
    const token = signDevToken(
      {
        userId: 'demo-user',
        tenantId: deps.demoTenantId,
        tenantSlug: deps.demoTenantSlug,
      },
      deps.jwtSecret
    );
    return { token, usage: `Authorization: Bearer ${token}` };
  });

  app.get('/api/v1/dev/orders', async () => {
    return { mockOrderIds: MOCK_ORDER_IDS };
  });
}
