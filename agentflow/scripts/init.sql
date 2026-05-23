-- AgentFlow MVP 数据库初始化
-- 由 Postgres 容器启动时自动执行；如果需要在已运行的容器上重跑：
--   docker exec -i agentflow-mvp-postgres psql -U agentflow -d agentflow < scripts/init.sql

-- pgvector：为后续知识库章节预留，本 MVP 不直接用
CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────
-- 租户表
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          VARCHAR(64) NOT NULL UNIQUE,
  name          VARCHAR(255) NOT NULL,
  -- 租户等级：standard | financial
  tier          VARCHAR(32) NOT NULL DEFAULT 'standard',
  config        JSONB NOT NULL DEFAULT '{}',
  status        VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 会话表（持久化历史；热状态在 Redis）
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       VARCHAR(255) NOT NULL,
  status        VARCHAR(32) NOT NULL DEFAULT 'active',
  messages      JSONB NOT NULL DEFAULT '[]',
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_tenant_user
  ON sessions(tenant_id, user_id);

-- ─────────────────────────────────────────────
-- LLM 调用审计日志
-- 即便不是金融租户，MVP 也写入，便于成本回放和问题排查
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id      UUID REFERENCES sessions(id) ON DELETE SET NULL,
  provider        VARCHAR(64) NOT NULL,
  model           VARCHAR(128) NOT NULL,
  request_body    JSONB NOT NULL,
  response_body   JSONB,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens     INTEGER,
  latency_ms      INTEGER,
  success         BOOLEAN NOT NULL DEFAULT true,
  error_code      VARCHAR(128),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_audit_tenant_time
  ON llm_audit_logs(tenant_id, created_at DESC);

-- ─────────────────────────────────────────────
-- 演示数据：电商租户 A（slug = tenant-ecommerce）
-- ─────────────────────────────────────────────
INSERT INTO tenants (id, slug, name, tier, config, status) VALUES
  (
    '00000000-0000-0000-0000-000000000001',
    'tenant-ecommerce',
    '电商租户 A',
    'standard',
    '{"system_prompt": "你是【优购电商】的客服助手，专门处理订单查询、退货、物流问题。回复简洁、不超过 150 字。"}',
    'active'
  )
ON CONFLICT (slug) DO NOTHING;
