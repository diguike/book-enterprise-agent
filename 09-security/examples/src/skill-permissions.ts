// Skill 权限检查模块
// 提供 fetch helper、资源限制 helper 以及白名单匹配逻辑
// 调用方式：把这些 helper 注入到 isolated-vm 沙箱中暴露给 Skill 代码

import type { SkillPermissions } from './types.js';

// ---------------- hostname 白名单匹配 ----------------

/**
 * 检查 hostname 是否在白名单内
 * 支持精确匹配和 *.example.com 通配
 * 注意：通配只对一级子域生效，避免简单 endsWith 被 evil-example.com 绕过
 */
export function isHostnameAllowed(
  hostname: string,
  allowedDomains: string[],
): boolean {
  const lower = hostname.toLowerCase();
  for (const rule of allowedDomains) {
    const r = rule.toLowerCase();
    if (r.startsWith('*.')) {
      // 通配：*.example.com 匹配 a.example.com、b.example.com，
      // 但不匹配 example.com 本身、也不匹配 evil-example.com
      const suffix = r.slice(2); // example.com
      if (lower === suffix) continue; // 不允许裸域
      if (lower.endsWith('.' + suffix)) {
        return true;
      }
    } else {
      // 精确匹配
      if (lower === r) return true;
    }
  }
  return false;
}

// ---------------- SSRF 防护：私有/特殊 IP 段 ----------------

/**
 * 判断目标 IPv4 是否为私有或特殊地址
 * 拒绝列表：0.0.0.0/8、10/8、127/8（回环）、169.254/16（链路本地+云元数据）、
 * 172.16/12、192.168/16、224/4（多播）
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;                        // 0.0.0.0/8
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 127) return true;                      // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true;         // 169.254.0.0/16 链路本地 + 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;// 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  if (a >= 224) return true;                       // 224/4 多播、240/4 保留
  return false;
}

/**
 * 判断目标 IPv6 字面量是否为私有/特殊地址
 * 拒绝列表：::1（回环）、fc00::/7（ULA）、fe80::/10（链路本地）、
 * ::ffff:0:0/96（IPv4-mapped，需进一步检查 IPv4 部分）、fd00:ec2::（部分云元数据）
 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true; // 链路本地
  // fc00::/7 唯一本地地址（fc.. / fd..）
  const firstByte = lower.split(':')[0] ?? '';
  if (/^f[cd][0-9a-f]{0,2}$/.test(firstByte)) return true;
  // IPv4-mapped：::ffff:a.b.c.d 或 ::ffff:abcd:abcd
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice('::ffff:'.length);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) {
      return isPrivateIPv4(tail);
    }
  }
  return false;
}

/**
 * 检查 hostname 是否是危险目标
 * 主要用于阻止 Skill 直接写 IP 或常见内网/元数据域名
 *
 * 重要局限：本函数只能拦截"字面 IP / 已知内网域名"。
 * 真正完整的 SSRF 防护必须在 DNS 解析后再次校验目标 IP——
 * 攻击者可以注册一个公网域名，把 A 记录指向 127.0.0.1 或 169.254.169.254
 * （DNS rebinding）。生产实现需在 fetch 前手动 dns.lookup() 拿到 IP，
 * 对每个返回的 IP 调用 isPrivateIPv4 / isPrivateIPv6 验证后再发请求，
 * 并禁止 HTTP 重定向到新主机时跳过该校验。
 */
export function isDangerousHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // 常见内网/元数据域名
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (lower === 'metadata.google.internal') return true;
  if (lower === 'metadata.azure.com') return true;
  if (lower === 'instance-data') return true; // AWS IMDS 别名
  // IPv4 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower)) {
    return isPrivateIPv4(lower);
  }
  // IPv6 字面量（包含冒号）
  if (lower.includes(':')) {
    return isPrivateIPv6(lower);
  }
  return false;
}

// ---------------- fetch helper ----------------

export class SkillPermissionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SkillPermissionError';
  }
}

export interface FetchGuards {
  // 输出大小上限
  maxOutputSizeKb: number;
  // 总超时（毫秒）
  timeoutMs: number;
}

/**
 * 构造可安全注入沙箱的 fetch helper
 * 每次调用都按当前权限快照检查，避免缓存过期权限
 */
export function createFetchHelper(
  loadPermissions: () => SkillPermissions,
) {
  return async (url: string, init?: RequestInit): Promise<{
    status: number;
    body: string;
  }> => {
    const permissions = loadPermissions();

    if (permissions.blockNetworkAccess) {
      throw new SkillPermissionError('network_blocked', 'Skill 无网络访问权限');
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SkillPermissionError('invalid_url', `无效 URL: ${url}`);
    }

    // 只允许 http/https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SkillPermissionError(
        'protocol_forbidden',
        `禁止的协议: ${parsed.protocol}`,
      );
    }

    const hostname = parsed.hostname;

    // SSRF 防护
    if (isDangerousHostname(hostname)) {
      throw new SkillPermissionError(
        'ssrf_blocked',
        `禁止访问内网或特殊地址: ${hostname}`,
      );
    }

    // 白名单匹配
    if (!isHostnameAllowed(hostname, permissions.allowedDomains)) {
      throw new SkillPermissionError(
        'domain_not_allowed',
        `域名 ${hostname} 不在白名单`,
      );
    }

    const guards: FetchGuards = {
      maxOutputSizeKb: permissions.maxOutputSizeKb,
      timeoutMs: permissions.maxCpuTimeMs,
    };

    return fetchWithGuards(url, init, guards);
  };
}

/**
 * 带超时和大小限制的 fetch
 * 这里用 mock 实现，生产可换成 undici 并启用 limit/abort
 */
async function fetchWithGuards(
  url: string,
  init: RequestInit | undefined,
  guards: FetchGuards,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), guards.timeoutMs);
  try {
    // 注：演示场景下不真的发请求，返回 mock 数据
    // 生产环境替换为：
    //   const res = await fetch(url, { ...init, signal: controller.signal });
    //   读取 body 时按 guards.maxOutputSizeKb 截断
    const mockBody = JSON.stringify({ ok: true, url });
    if (mockBody.length / 1024 > guards.maxOutputSizeKb) {
      throw new SkillPermissionError(
        'output_too_large',
        `响应超过 ${guards.maxOutputSizeKb}KB`,
      );
    }
    return { status: 200, body: mockBody };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 数据访问检查 ----------------

/**
 * 检查 Skill 是否被允许读取某个知识库
 */
export function ensureKnowledgeBaseAccess(
  permissions: SkillPermissions,
  kbId: string,
): void {
  if (!permissions.allowedKnowledgeBaseIds.includes(kbId)) {
    throw new SkillPermissionError(
      'kb_not_allowed',
      `知识库 ${kbId} 不在 Skill ${permissions.skillId} 的允许列表`,
    );
  }
}

export function ensureSessionReadable(permissions: SkillPermissions): void {
  if (!permissions.canReadSessions) {
    throw new SkillPermissionError(
      'session_read_denied',
      `Skill ${permissions.skillId} 没有读 session 历史的权限`,
    );
  }
}

// ---------------- 默认权限工厂 ----------------

/**
 * 平台默认权限：全部拒绝
 * 新建 Skill 拿到这套权限，只能跑纯计算
 */
export function makeDefaultPermissions(
  skillId: string,
  tenantId: string,
): SkillPermissions {
  return {
    skillId,
    tenantId,
    blockNetworkAccess: true,
    allowedDomains: [],
    allowedKnowledgeBaseIds: [],
    canReadSessions: false,
    canWriteAuditLog: false,
    maxMemoryMb: 128,
    maxCpuTimeMs: 5000,
    maxOutputSizeKb: 100,
  };
}
