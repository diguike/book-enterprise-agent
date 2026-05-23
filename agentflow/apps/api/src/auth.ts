/**
 * JWT 认证：从 Authorization: Bearer <token> 中提取租户信息。
 *
 * MVP 用 HS256 + 共享密钥；生产环境改为 RS256 + JWKS。
 */

import type { FastifyPluginAsync } from 'fastify';
import jwt from 'jsonwebtoken';

/** JWT payload 约定 */
export interface JwtPayload {
  /** 终端用户 ID（租户侧标识，不是 AgentFlow 内部用户） */
  sub: string;
  /** 租户 UUID */
  tenantId: string;
  /** 租户 slug */
  tenantSlug: string;
  iat?: number;
  exp?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: JwtPayload;
  }
}

export interface AuthPluginOptions {
  jwtSecret: string;
}

/**
 * 注册 preHandler 钩子：自动从 Authorization 头解析 JWT，挂到 request.auth。
 * 不限制路由白名单，由各 route 自己决定是否要求登录。
 */
export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (
  app,
  opts
) => {
  app.addHook('preHandler', async (request) => {
    const header = request.headers.authorization;
    if (!header) return;

    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return;
    const token = match[1]!;

    try {
      const payload = jwt.verify(token, opts.jwtSecret) as JwtPayload;
      request.auth = payload;
    } catch {
      // 无效 token 不立刻 401，让路由自己决定怎么处理
      // 这样可以让健康检查、签发 token 接口不受影响
    }
  });
};

/**
 * 签发一个开发用 JWT（README 里告诉读者怎么拿）。
 * 生产环境绝不应该把这个能力暴露在 API 上，只用于本地调试。
 */
export function signDevToken(
  payload: { userId: string; tenantId: string; tenantSlug: string },
  secret: string
): string {
  return jwt.sign(
    {
      sub: payload.userId,
      tenantId: payload.tenantId,
      tenantSlug: payload.tenantSlug,
    },
    secret,
    { expiresIn: '7d' }
  );
}
