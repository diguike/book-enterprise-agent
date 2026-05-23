/**
 * 第8章：Fastify 租户上下文中间件
 *
 * 职责：从每个请求的 JWT 中提取 tenantId，验证租户状态，
 * 将租户信息注入 request 对象供后续路由处理器使用。
 *
 * 这是多租户隔离的第一道关卡，后续所有操作都依赖这里注入的 tenantId。
 */

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import {
  Tenant,
  TenantConfig,
  TenantQuota,
  PLAN_QUOTAS,
  TenantNotFoundError,
  TenantInactiveError,
} from './types.js';

// ─── JWT Payload 结构 ─────────────────────────────────────────────────────────

/**
 * AgentFlow JWT 签发的 payload 结构
 * JWT 由 AgentFlow 控制台在租户创建 API Key 时签发
 */
const JwtPayloadSchema = z.object({
  sub: z.string().uuid(),   // tenantId（租户 UUID）
  iat: z.number(),
  exp: z.number(),
  plan: z.enum(['starter', 'pro', 'enterprise']),
  jti: z.string(),          // JWT ID，用于吊销检测
});

type JwtPayload = z.infer<typeof JwtPayloadSchema>;

// ─── Request 类型扩展 ─────────────────────────────────────────────────────────

/**
 * 扩展 Fastify Request 类型，添加租户上下文
 *
 * 中间件执行后，路由处理器可以直接通过 request.tenant 访问租户信息，
 * 无需再次查询数据库或 Redis。
 */
declare module 'fastify' {
  interface FastifyRequest {
    tenant: {
      id: string;
      plan: Tenant['plan'];
      config: TenantConfig;
      quota: TenantQuota;
    };
  }
}

// ─── 模拟数据存储（演示用） ───────────────────────────────────────────────────

/**
 * 模拟租户数据库（实际生产中从 PostgreSQL 查询）
 */
const MOCK_TENANTS: Record<string, Tenant> = {
  'tenant-a-uuid-0000-0000-000000000001': {
    id: 'tenant-a-uuid-0000-0000-000000000001',
    name: '电商公司 A',
    plan: 'pro',
    apiKey: 'hashed-api-key-a',
    createdAt: new Date('2024-01-01'),
    isActive: true,
  },
  'tenant-b-uuid-0000-0000-000000000002': {
    id: 'tenant-b-uuid-0000-0000-000000000002',
    name: 'SaaS 公司 B',
    plan: 'starter',
    apiKey: 'hashed-api-key-b',
    createdAt: new Date('2024-02-01'),
    isActive: true,
  },
  'tenant-c-uuid-0000-0000-000000000003': {
    id: 'tenant-c-uuid-0000-0000-000000000003',
    name: '金融机构 C',
    plan: 'enterprise',
    apiKey: 'hashed-api-key-c',
    createdAt: new Date('2024-03-01'),
    isActive: true,
  },
};

/**
 * 模拟租户配置（实际生产中由 ConfigManager 从 Redis/DB 加载）
 */
const MOCK_CONFIGS: Record<string, TenantConfig> = {
  'tenant-a-uuid-0000-0000-000000000001': {
    tenantId: 'tenant-a-uuid-0000-0000-000000000001',
    systemPrompt: '你是电商平台的智能客服，专注于订单查询、退款处理和物流跟踪。',
    allowedSkillIds: null,      // 允许全部 Skill
    knowledgeBaseIds: ['kb-ecommerce-faq'],
    maxContextTurns: 20,
    enableBuiltinKnowledge: true,
    preferredModel: 'claude-sonnet-4-5',
    fallbackModel: 'claude-haiku-3-5',
    requireAuditLog: false,
    piiMaskingEnabled: false,
    allowedIpRanges: null,
    updatedAt: new Date(),
  },
  'tenant-b-uuid-0000-0000-000000000002': {
    tenantId: 'tenant-b-uuid-0000-0000-000000000002',
    systemPrompt: null,         // 使用平台默认 prompt
    allowedSkillIds: ['skill-search-docs', 'skill-create-ticket'],  // 限制可用 Skill
    knowledgeBaseIds: ['kb-saas-docs'],
    maxContextTurns: 10,        // starter 套餐降低上下文长度
    enableBuiltinKnowledge: false,
    preferredModel: null,       // 使用平台默认模型
    fallbackModel: null,
    requireAuditLog: false,
    piiMaskingEnabled: false,
    allowedIpRanges: null,
    updatedAt: new Date(),
  },
  'tenant-c-uuid-0000-0000-000000000003': {
    tenantId: 'tenant-c-uuid-0000-0000-000000000003',
    systemPrompt: '你是合规的金融服务助手，回答问题时必须注明"以上内容不构成投资建议"。',
    allowedSkillIds: ['skill-query-account', 'skill-query-transaction'],
    knowledgeBaseIds: ['kb-financial-regulations', 'kb-products'],
    maxContextTurns: 30,
    enableBuiltinKnowledge: false,
    preferredModel: 'claude-opus-4-5',  // 金融场景用旗舰模型
    fallbackModel: 'claude-sonnet-4-5',
    requireAuditLog: true,      // 金融机构必须开启审计日志
    piiMaskingEnabled: true,    // 开启 PII 脱敏
    allowedIpRanges: ['10.0.0.0/8'],  // 只允许内网访问
    updatedAt: new Date(),
  },
};

// ─── 中间件实现 ───────────────────────────────────────────────────────────────

/**
 * 租户上下文中间件 Fastify 插件
 *
 * 注册后，所有请求都会经过租户验证流程：
 * 1. 从 Authorization header 提取 JWT
 * 2. 验证 JWT 签名和过期时间
 * 3. 从 JWT payload 提取 tenantId
 * 4. 验证租户存在且处于激活状态
 * 5. 加载租户配置和配额，注入 request.tenant
 */
const tenantMiddlewarePlugin: FastifyPluginAsync = async (fastify) => {
  // 注册钩子：onRequest 是 Fastify 最早的钩子，在 body parsing 和路由处理之前执行。
  // 鉴权/限流类逻辑放这里能更早拒绝非法请求，避免无谓的 body parsing 开销。
  // preHandler 是另一种选项，它在 body parsing 之后、route handler 之前；
  // 如果需要根据 body 做鉴权决策才用 preHandler，否则一律用 onRequest。
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // 跳过健康检查和公开端点
    if (request.url === '/health' || request.url === '/') {
      return;
    }

    try {
      // 1. 提取并验证 JWT
      const payload = await extractAndVerifyJwt(request);

      // 2. 加载租户信息
      const tenant = await loadTenant(payload.sub);

      // 3. 加载配置和配额
      const [config, quota] = await Promise.all([
        loadTenantConfig(payload.sub),
        buildTenantQuota(payload.sub, tenant.plan),
      ]);

      // 4. 检查 IP 白名单（如果配置了）
      if (config.allowedIpRanges && config.allowedIpRanges.length > 0) {
        const clientIp = request.ip;
        if (!isIpAllowed(clientIp, config.allowedIpRanges)) {
          return reply.status(403).send({
            error: 'ip_not_allowed',
            message: `IP ${clientIp} is not in the allowed ranges`,
          });
        }
      }

      // 5. 注入租户上下文到 request 对象
      // 后续的路由处理器通过 request.tenant 访问，不需要再次查询
      request.tenant = {
        id: payload.sub,
        plan: tenant.plan,
        config,
        quota,
      };

    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        return reply.status(404).send({ error: 'tenant_not_found' });
      }
      if (err instanceof TenantInactiveError) {
        return reply.status(403).send({ error: 'tenant_inactive' });
      }
      // JWT 验证失败等其他错误
      request.log.warn({ err }, 'tenant authentication failed');
      return reply.status(401).send({ error: 'authentication_failed' });
    }
  });
};

// ─── 内部辅助函数 ─────────────────────────────────────────────────────────────

/**
 * 从请求头提取并验证 JWT
 *
 * 实际生产中使用 @fastify/jwt 插件的 request.jwtVerify()，
 * 这里用简化实现展示核心逻辑。
 */
async function extractAndVerifyJwt(request: FastifyRequest): Promise<JwtPayload> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);

  // 实际生产中：await request.jwtVerify()
  // 这里解析 Base64 编码的 mock JWT payload（演示用）
  const payload = parseMockJwt(token);

  // 校验 payload 结构
  const parsed = JwtPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Invalid JWT payload structure');
  }

  // 校验过期时间
  if (parsed.data.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('JWT expired');
  }

  return parsed.data;
}

/**
 * 加载租户基础信息并验证状态
 */
async function loadTenant(tenantId: string): Promise<Tenant> {
  // 实际生产中：从 PostgreSQL 查询，带 Redis 缓存（TTL 60s）
  const tenant = MOCK_TENANTS[tenantId];

  if (!tenant) {
    throw new TenantNotFoundError(tenantId);
  }

  if (!tenant.isActive) {
    throw new TenantInactiveError(tenantId);
  }

  return tenant;
}

/**
 * 加载租户配置
 * 实际生产中由 ConfigManager 处理 Redis 缓存逻辑
 */
async function loadTenantConfig(tenantId: string): Promise<TenantConfig> {
  const config = MOCK_CONFIGS[tenantId];
  if (!config) {
    throw new TenantNotFoundError(tenantId);
  }
  return config;
}

/**
 * 构建租户配额对象
 * 套餐默认配额 + 可能的企业自定义覆盖
 */
async function buildTenantQuota(tenantId: string, plan: Tenant['plan']): Promise<TenantQuota> {
  const defaults = PLAN_QUOTAS[plan];
  // 实际生产中：检查是否有针对该租户的配额覆盖（企业客户可能有协商后的定制配额）
  return {
    tenantId,
    plan,
    ...defaults,
  };
}

/**
 * 解析演示用的 mock JWT（实际生产中使用真正的 JWT 库）
 */
function parseMockJwt(token: string): unknown {
  try {
    // mock JWT 格式：header.payload.signature（Base64 编码）
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }
    const payload = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    throw new Error('Failed to parse JWT');
  }
}

/**
 * 检查客户端 IP 是否在白名单内
 *
 * 演示用的简化 CIDR 检查：把 IPv4 地址和子网都转成 32 位整数，
 * 用前 N 位（N = CIDR 前缀长度）做掩码比较。
 * 实际生产请用 ip-range-check / netmask 等库，支持 IPv6 和健壮的格式校验。
 */
function isIpAllowed(clientIp: string, allowedRanges: string[]): boolean {
  const clientInt = ipv4ToInt(clientIp);
  if (clientInt === null) return false;

  return allowedRanges.some(range => {
    const [subnet, prefixLenStr] = range.split('/');
    const prefixLen = parseInt(prefixLenStr ?? '32', 10);
    const subnetInt = ipv4ToInt(subnet ?? '');
    if (subnetInt === null || prefixLen < 0 || prefixLen > 32) return false;

    // mask 的高 prefixLen 位全 1。注意 prefixLen=0 时不能直接左移 32（JS 中 >>32 等于 >>0），需要特判
    const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
    return (clientInt & mask) === (subnetInt & mask);
  });
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

// ─── 工具函数：生成 Mock JWT（用于演示和测试） ────────────────────────────────

/**
 * 生成演示用的 mock JWT
 * 实际生产中 JWT 由控制台在租户创建 API Key 时生成
 */
export function createMockJwt(tenantId: string, plan: Tenant['plan']): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: tenantId,
    plan,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,  // 1 小时有效期
    jti: `jti-${Math.random().toString(36).slice(2)}`,
  })).toString('base64url');
  const signature = 'mock-signature';  // 演示用，实际需要 HMAC-SHA256

  return `${header}.${payload}.${signature}`;
}

export default fp(tenantMiddlewarePlugin, {
  name: 'tenant-middleware',
});
