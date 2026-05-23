// PII 脱敏与恢复
// 主要覆盖中国场景常见敏感数据：身份证、手机号、银行卡、邮箱
// 三种粒度：full / partial / structured

import type { MaskingMode, PiiMatch, PiiType } from './types.js';

// ---------------- 检测规则 ----------------
// 顺序很关键：先长后短，避免身份证号被切成手机号

interface PiiRule {
  type: PiiType;
  pattern: RegExp;
}

// 注意：
// 1. 正则不带 anchors，使用 matchAll 扫描全文
// 2. 顺序"先长后短"：身份证 18 位 -> 银行卡 13-19 位 -> 手机号 11 位 -> 邮箱
//    dedup 阶段会按 (起点, 长度) 解决重叠，把更短的命中丢弃
// 3. bankcard 正则故意宽松（13-19 位连续数字），会误伤订单号、长流水号。
//    生产环境建议叠加 Luhn 校验，并限定上下文（"卡号:"、"账号:" 等前缀词）
const RULES: PiiRule[] = [
  // 身份证号：18 位，前 6 位地区码 + 8 位日期 + 3 位序号 + 1 位校验（数字或 X）
  {
    type: 'idcard',
    pattern: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  },
  // 银行卡号：13-19 位连续数字（实战可再叠加 Luhn 校验）
  {
    type: 'bankcard',
    pattern: /\b\d{13,19}\b/g,
  },
  // 手机号：1 开头，第 2 位 3-9，共 11 位
  {
    type: 'phone',
    pattern: /\b1[3-9]\d{9}\b/g,
  },
  // 邮箱：RFC 5322 子集
  {
    type: 'email',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  // 注：地址（address）类型留在 PiiType 中，但正则覆盖率太低，
  // 生产实现接 NER 模型（如 hanlp、PaddleNLP）单独识别后再调用 mask 流程
];

// ---------------- 三种粒度的占位符 ----------------

function fullPlaceholder(type: PiiType, index: number): string {
  return `[${type.toUpperCase()}_${index}]`;
}

function structuredPlaceholder(type: PiiType): string {
  const labels: Record<PiiType, string> = {
    phone: '[手机号]',
    idcard: '[身份证号]',
    bankcard: '[银行卡号]',
    email: '[邮箱]',
    address: '[地址]',
  };
  return labels[type];
}

function partialMask(type: PiiType, raw: string): string {
  switch (type) {
    case 'phone':
      // 13812345678 -> 138****5678
      if (raw.length === 11) return `${raw.slice(0, 3)}****${raw.slice(-4)}`;
      return raw;
    case 'idcard':
      // 18 位 -> 前 6 后 4
      if (raw.length === 18) return `${raw.slice(0, 6)}********${raw.slice(-4)}`;
      return raw;
    case 'bankcard':
      // 保留前 4 后 4
      if (raw.length >= 12) {
        return `${raw.slice(0, 4)}${'*'.repeat(raw.length - 8)}${raw.slice(-4)}`;
      }
      return raw;
    case 'email': {
      // a***@b.com
      const at = raw.indexOf('@');
      if (at <= 0) return raw;
      const local = raw.slice(0, at);
      const domain = raw.slice(at);
      const keep = local.slice(0, 1);
      return `${keep}***${domain}`;
    }
    case 'address':
      // 地址没有可靠的"前 N 后 M"切分方式，partial 模式下退回 structured
      // 占位符，避免静默漏出原文
      return structuredPlaceholder('address');
  }
}

// ---------------- 主类 ----------------

export interface MaskResult {
  masked: string;
  mapping: Map<string, string>; // placeholder -> raw
  matches: PiiMatch[];
}

export class PiiMasker {
  constructor(private mode: MaskingMode = 'partial') {}

  /**
   * 检测并脱敏
   * 返回脱敏后的文本、占位符到原值的映射、命中详情
   * 注意：mapping 不能传给 LLM、不能写入持久日志
   */
  mask(text: string): MaskResult {
    const matches: PiiMatch[] = [];

    // 第一步：扫描所有命中并按起始位置排序
    for (const rule of RULES) {
      for (const m of text.matchAll(rule.pattern)) {
        if (m.index === undefined) continue;
        matches.push({
          type: rule.type,
          raw: m[0],
          placeholder: '', // 先占位，下面统一编号
          start: m.index,
          end: m.index + m[0].length,
        });
      }
    }

    // 第二步：解决重叠——身份证号(18) 会包含手机号(11)，保留先匹配的（已按规则顺序）
    matches.sort((a, b) => a.start - b.start);
    const dedup: PiiMatch[] = [];
    for (const m of matches) {
      const last = dedup[dedup.length - 1];
      if (last && m.start < last.end) {
        // 重叠：保留更长的，丢弃更短的
        if (m.end - m.start > last.end - last.start) {
          dedup[dedup.length - 1] = m;
        }
        continue;
      }
      dedup.push(m);
    }

    // 第三步：编号占位符并构造 mapping
    const counters: Record<PiiType, number> = {
      phone: 0,
      idcard: 0,
      bankcard: 0,
      email: 0,
      address: 0,
    };
    const mapping = new Map<string, string>();

    for (const m of dedup) {
      counters[m.type] += 1;
      m.placeholder = fullPlaceholder(m.type, counters[m.type]);
      mapping.set(m.placeholder, m.raw);
    }

    // 第四步：按模式生成替换后的文本
    const masked = this.replaceText(text, dedup);

    return { masked, mapping, matches: dedup };
  }

  /**
   * 把 Agent 输出里的占位符还原回原值
   * 仅用于受信任的输出层（不能在传给 LLM 之前还原）
   */
  unmask(text: string, mapping: Map<string, string>): string {
    let result = text;
    for (const [placeholder, raw] of mapping) {
      // 全局替换占位符（escape 一下 [ ] _）
      const escaped = placeholder.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), raw);
    }
    return result;
  }

  private replaceText(text: string, matches: PiiMatch[]): string {
    if (matches.length === 0) return text;
    const chunks: string[] = [];
    let cursor = 0;
    for (const m of matches) {
      chunks.push(text.slice(cursor, m.start));
      chunks.push(this.renderReplacement(m));
      cursor = m.end;
    }
    chunks.push(text.slice(cursor));
    return chunks.join('');
  }

  private renderReplacement(m: PiiMatch): string {
    switch (this.mode) {
      case 'full':
        return m.placeholder;
      case 'partial':
        return partialMask(m.type, m.raw);
      case 'structured':
        return structuredPlaceholder(m.type);
    }
  }
}
