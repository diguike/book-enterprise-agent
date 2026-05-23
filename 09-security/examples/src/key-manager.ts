// API Key 管理器
// 单机简化版：内存持有 + deprecated 窗口轮换
// 生产替换为 Vault / Secrets Manager 拉取，但保留双 Key 并存的设计

import type { KeyEntry } from './types.js';

const DEFAULT_DEPRECATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 小时

export class KeyManagerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KeyManagerError';
  }
}

export class KeyManager {
  // provider -> Key 列表（最多一个 active + 一个 deprecated）
  private keys = new Map<string, KeyEntry[]>();
  private deprecationWindowMs: number;
  private now: () => number;

  constructor(options?: {
    deprecationWindowMs?: number;
    now?: () => number; // 便于测试注入时钟
  }) {
    this.deprecationWindowMs =
      options?.deprecationWindowMs ?? DEFAULT_DEPRECATION_WINDOW_MS;
    this.now = options?.now ?? (() => Date.now());
  }

  /**
   * 首次注册某 provider 的 Key
   * 已有 active Key 时拒绝（应该走 rotate）
   */
  registerKey(provider: string, value: string): void {
    const existing = this.keys.get(provider) ?? [];
    if (existing.some((k) => k.status === 'active')) {
      throw new KeyManagerError(
        'already_registered',
        `provider ${provider} 已有 active Key，请使用 rotate`,
      );
    }
    existing.push({
      value,
      status: 'active',
      createdAt: this.now(),
    });
    this.keys.set(provider, existing);
  }

  /**
   * 轮换 Key
   * 旧 active 标记为 deprecated 进入并存窗口，新 Key 设为 active
   */
  rotate(provider: string, newValue: string): void {
    const list = this.keys.get(provider);
    if (!list || list.length === 0) {
      throw new KeyManagerError('not_found', `provider ${provider} 未注册`);
    }

    const now = this.now();
    // 先清理已过期的 deprecated（防止积累）
    const cleaned = list.filter((k) => {
      if (k.status === 'deprecated' && k.deprecatedAt !== undefined) {
        return now - k.deprecatedAt < this.deprecationWindowMs;
      }
      return true;
    });

    // 将当前 active 转 deprecated
    for (const entry of cleaned) {
      if (entry.status === 'active') {
        entry.status = 'deprecated';
        entry.deprecatedAt = now;
      }
    }

    // 加入新 active
    cleaned.push({
      value: newValue,
      status: 'active',
      createdAt: now,
    });
    this.keys.set(provider, cleaned);
  }

  /**
   * 获取当前 active Key（调用 LLM 时使用）
   */
  getActiveKey(provider: string): string {
    const list = this.keys.get(provider) ?? [];
    const active = list.find((k) => k.status === 'active');
    if (!active) {
      throw new KeyManagerError('no_active_key', `provider ${provider} 没有 active Key`);
    }
    return active.value;
  }

  /**
   * 校验某个 Key 是否仍可接受（active 或仍在 deprecation window 内）
   * 用于回调请求验证：客户端可能还在用旧 Key 但应允许其继续工作
   */
  isAcceptable(provider: string, value: string): boolean {
    const list = this.keys.get(provider) ?? [];
    const now = this.now();
    for (const entry of list) {
      if (entry.value !== value) continue;
      if (entry.status === 'active') return true;
      if (
        entry.status === 'deprecated' &&
        entry.deprecatedAt !== undefined &&
        now - entry.deprecatedAt < this.deprecationWindowMs
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 立即撤销某个 Key（应急流程）
   * 不等 deprecation window，强制移除
   */
  revoke(provider: string, value: string): void {
    const list = this.keys.get(provider) ?? [];
    const next = list.filter((k) => k.value !== value);
    this.keys.set(provider, next);
  }

  /**
   * 列出某 provider 当前所有 Key（用于运维查看）
   * 返回的 value 字段做脱敏处理，不暴露完整值
   */
  listKeys(provider: string): Array<Omit<KeyEntry, 'value'> & { masked: string }> {
    const list = this.keys.get(provider) ?? [];
    return list.map((k) => ({
      status: k.status,
      createdAt: k.createdAt,
      deprecatedAt: k.deprecatedAt,
      masked: maskKey(k.value),
    }));
  }
}

/**
 * Key 脱敏：保留前 4 后 4，中间星号
 */
export function maskKey(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
}

// ---------------- Key 异常使用检测 ----------------

export interface KeyUsageSample {
  provider: string;
  // 简化的 IP/地区指纹
  fingerprint: string;
  timestamp: number;
  costUsd: number;
}

/**
 * 简单的滑动窗口异常检测
 * 实战场景应接入更完整的告警系统（Prometheus + alertmanager）
 */
export class KeyUsageMonitor {
  private samples: KeyUsageSample[] = [];
  private windowMs = 10 * 60 * 1000; // 10 分钟

  record(sample: KeyUsageSample): void {
    this.samples.push(sample);
    // 清理过期样本
    const cutoff = sample.timestamp - this.windowMs;
    this.samples = this.samples.filter((s) => s.timestamp >= cutoff);
  }

  /**
   * 检测最近窗口内是否出现了新指纹（地理位置/IP 切换）
   * 返回新出现的指纹列表
   */
  detectNewFingerprints(provider: string, knownFingerprints: Set<string>): string[] {
    const recent = this.samples.filter((s) => s.provider === provider);
    const seen = new Set<string>();
    for (const s of recent) {
      if (!knownFingerprints.has(s.fingerprint)) {
        seen.add(s.fingerprint);
      }
    }
    return [...seen];
  }

  /**
   * 计算窗口内总成本
   * 超过阈值时上游应触发告警
   */
  totalCostUsd(provider: string): number {
    return this.samples
      .filter((s) => s.provider === provider)
      .reduce((sum, s) => sum + s.costUsd, 0);
  }
}
