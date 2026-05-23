-- AgentFlow 数据库初始化脚本
-- 由 PostgreSQL 容器启动时自动执行（docker-entrypoint-initdb.d）
-- 注意：此脚本在默认数据库（agentflow）中执行

-- ─────────────────────────────────────────────
-- 1. 安装 pgvector 扩展
-- 必须在创建向量类型字段之前执行
-- ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────
-- 2. 创建 Langfuse 专用数据库
-- Langfuse 需要独立的数据库，与 agentflow 业务库隔离
-- ─────────────────────────────────────────────
CREATE DATABASE langfuse
  WITH OWNER = agentflow
  ENCODING = 'UTF8'
  LC_COLLATE = 'en_US.utf8'
  LC_CTYPE = 'en_US.utf8'
  TEMPLATE = template0;

-- ─────────────────────────────────────────────
-- 3. 在 agentflow 数据库中创建基础表
-- ─────────────────────────────────────────────

-- 租户表：多租户 SaaS 的根实体
-- tenant_id 是全书所有 key 命名的前缀来源
CREATE TABLE IF NOT EXISTS tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 短标识符，用于 Redis key 前缀（如 "tenant_a"）
  slug          VARCHAR(64) NOT NULL UNIQUE,
  name          VARCHAR(255) NOT NULL,
  -- 租户配置：LLM 限额、功能开关等，JSON 格式方便扩展
  config        JSONB NOT NULL DEFAULT '{}',
  -- 租户状态：active | suspended | trial
  status        VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 会话表：一次完整的用户对话
-- 对应 Temporal workflow 的生命周期
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Temporal workflow ID，格式：{tenant_slug}:session:{session_id}
  workflow_id   VARCHAR(255),
  -- 用户侧标识符（来自租户系统）
  user_id       VARCHAR(255) NOT NULL,
  -- 会话状态：active | completed | error | timeout
  status        VARCHAR(32) NOT NULL DEFAULT 'active',
  -- 完整消息历史，保留全量方便调试
  messages      JSONB NOT NULL DEFAULT '[]',
  -- 会话元数据：渠道来源、设备信息等
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 会话表索引：按租户 + 用户查询是最常见的访问模式
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_user
  ON sessions(tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_tenant_status
  ON sessions(tenant_id, status);

-- LLM 调用审计日志
-- 对应租户 C（金融机构）的合规要求：每次 LLM 调用必须留存完整记录
CREATE TABLE IF NOT EXISTS llm_audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES sessions(id) ON DELETE SET NULL,
  -- LLM 提供商：anthropic | openai | azure-openai
  provider      VARCHAR(64) NOT NULL,
  model         VARCHAR(128) NOT NULL,
  -- 完整的 prompt 和 response，合规场景不能省略
  request_body  JSONB NOT NULL,
  response_body JSONB,
  -- Token 用量，用于成本核算
  input_tokens  INTEGER,
  output_tokens INTEGER,
  -- 端到端延迟（毫秒）
  latency_ms    INTEGER,
  -- 是否命中缓存
  cache_hit     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 审计日志只按 tenant_id 查询，不需要复合索引
CREATE INDEX IF NOT EXISTS idx_llm_audit_tenant
  ON llm_audit_logs(tenant_id, created_at DESC);

-- 知识库文档表（向量检索，第6章引入）
-- 此处先建表结构，向量列用于 pgvector 相似度搜索
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 原始文档标识
  doc_id        VARCHAR(255) NOT NULL,
  -- 文本块内容
  content       TEXT NOT NULL,
  -- 向量嵌入（1024 维对应 voyage-3，全书默认 embedding 模型）
  -- 如果切到 OpenAI text-embedding-3-small，把 1024 改成 1536 并重建索引
  -- 注意：维度选定后不能修改，需重新建表
  embedding     vector(1024),
  -- 文档元数据：标题、来源、更新时间等
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- pgvector HNSW 索引：用于近似最近邻搜索（ANN）
-- 生产注意：HNSW 索引构建耗时，数据量大时应在低峰期构建
-- ef_construction=64 是精度与构建速度的折中值
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 按租户过滤是必须的，避免跨租户数据泄露
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant
  ON knowledge_chunks(tenant_id);

-- ─────────────────────────────────────────────
-- 4. 插入初始测试数据
-- 三个测试租户，对应书中三类场景
-- ─────────────────────────────────────────────
INSERT INTO tenants (id, slug, name, config, status) VALUES
  (
    '00000000-0000-0000-0000-000000000001',
    'tenant-ecommerce',
    '电商租户 A',
    '{"llm_quota_per_day": 10000, "features": ["order_lookup", "refund_processing"]}',
    'active'
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    'tenant-saas',
    'SaaS 租户 B',
    '{"llm_quota_per_day": 5000, "features": ["ticket_creation", "knowledge_base"]}',
    'active'
  ),
  (
    '00000000-0000-0000-0000-000000000003',
    'tenant-finance',
    '金融租户 C',
    '{"llm_quota_per_day": 2000, "features": ["compliance_audit"], "require_audit_log": true}',
    'active'
  )
ON CONFLICT (slug) DO NOTHING;
