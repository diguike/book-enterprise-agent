// 第9章共用类型定义

// ---------------- Skill 权限 ----------------

export interface SkillPermissions {
  skillId: string;
  tenantId: string;
  // 网络访问
  blockNetworkAccess: boolean;
  // 白名单 hostname，支持 *.example.com 通配
  allowedDomains: string[];
  // 数据访问
  allowedKnowledgeBaseIds: string[];
  canReadSessions: boolean;
  canWriteAuditLog: boolean;
  // 资源限制
  maxMemoryMb: number;
  maxCpuTimeMs: number;
  maxOutputSizeKb: number;
}

// ---------------- Prompt Injection ----------------

export type InjectionRiskLevel = 'none' | 'low' | 'medium' | 'high';

export interface InjectionRisk {
  level: InjectionRiskLevel;
  // 累计分值，便于上游做阈值判断
  score: number;
  // 命中的规则 id 列表
  matchedRules: string[];
  // 命中片段（用于日志）
  matchedSnippets: string[];
}

// ---------------- PII ----------------

export type PiiType = 'phone' | 'idcard' | 'bankcard' | 'email' | 'address';

export interface PiiMatch {
  type: PiiType;
  raw: string;
  placeholder: string;
  start: number;
  end: number;
}

export type MaskingMode =
  | 'full'         // 完全脱敏：[PHONE_1]
  | 'partial'      // 部分脱敏：138****5678
  | 'structured';  // 结构化脱敏：[手机号]

// ---------------- API Key 管理 ----------------

export type KeyStatus = 'active' | 'deprecated';

export interface KeyEntry {
  value: string;
  status: KeyStatus;
  createdAt: number;
  deprecatedAt?: number;
}

// ---------------- 安全审计 ----------------

export type SecurityEventType =
  | 'prompt_injection_detected'
  | 'skill_permission_denied'
  | 'api_key_anomaly'
  | 'pii_leak_blocked'
  | 'output_validation_failed';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface SecurityEvent {
  eventType: SecurityEventType;
  severity: Severity;
  tenantId: string;
  userId?: string;
  sessionId?: string;
  details: Record<string, unknown>;
  autoResponse?: string;
  timestamp: number;
}
