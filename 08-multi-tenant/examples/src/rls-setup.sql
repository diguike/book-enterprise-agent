-- ============================================================================
-- 第8章：AgentFlow 多租户 Row-Level Security 完整 SQL
--
-- 设计原则：
--   1. 所有业务表都有 tenant_id 列，且作为联合主键/索引的一部分
--   2. ENABLE + FORCE RLS 双开，保证连 owner 也受策略约束
--   3. 应用层在每个事务开头 SET LOCAL app.current_tenant_id
--   4. 平台运维用专门角色（agentflow_admin）绕过 RLS 做跨租户运维
--
-- 部署顺序：表 → 索引 → RLS 启用 → 策略 → 角色权限
-- ============================================================================


-- ─── 0. 角色（一次性创建） ──────────────────────────────────────────────────

-- 业务请求路径用的角色：受 RLS 约束
-- AgentFlow 的所有 Agent 请求处理流程（API + Worker）都用这个角色连接，
-- 每次事务开头 SET LOCAL app.current_tenant_id
CREATE ROLE agentflow_app NOLOGIN;

-- 平台级组件用的角色：BYPASSRLS 可以查询任意租户数据
-- 使用场景严格限定为：
--   1. ConfigManager 拉取 tenant_configs（需要在不知道 current_tenant_id 时读任意租户配置）
--   2. 计费/对账脚本（跨租户聚合）
--   3. 客户支持工单排查（必须走堡垒机 + 审计日志）
-- 应用代码引用的连接池必须分离：业务路径用 agentflow_app，
-- 平台路径用 agentflow_platform——不能共用同一个连接字符串
CREATE ROLE agentflow_platform NOLOGIN BYPASSRLS;

-- 兼容旧引用：admin 是 platform 的别名（仅用于人工运维登录）
CREATE ROLE agentflow_admin NOLOGIN BYPASSRLS;


-- ─── 1. 租户基础表 ──────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  plan        VARCHAR(50)  NOT NULL CHECK (plan IN ('starter', 'pro', 'enterprise')),
  api_key_hash TEXT        NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);


-- ─── 2. 租户配置表 ──────────────────────────────────────────────────────────

CREATE TABLE tenant_configs (
  tenant_id                UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  system_prompt            TEXT,
  allowed_skill_ids        UUID[],
  knowledge_base_ids       UUID[],
  preferred_model          VARCHAR(100),
  fallback_model           VARCHAR(100),
  max_context_turns        INTEGER NOT NULL DEFAULT 20,
  enable_builtin_knowledge BOOLEAN NOT NULL DEFAULT TRUE,
  require_audit_log        BOOLEAN NOT NULL DEFAULT FALSE,
  pii_masking_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_ip_ranges        TEXT[],
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─── 3. 业务表：会话、消息、知识库切片 ───────────────────────────────────────

CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata    JSONB DEFAULT '{}'::jsonb
);

-- 多租户场景下，tenant_id 必须是所有索引的第一列
-- 这样查询 plan + tenant_id 时能命中索引，单独查 plan 不会让 RLS 失效但会慢
CREATE INDEX idx_sessions_tenant_user ON sessions(tenant_id, user_id, created_at DESC);


CREATE TABLE messages (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id  UUID NOT NULL,
  role        VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 外键带上 tenant_id，防止跨租户引用 session
  FOREIGN KEY (tenant_id, session_id) REFERENCES sessions(tenant_id, id) ON DELETE CASCADE
);

-- 上面的外键需要 sessions 表有 (tenant_id, id) 唯一约束
ALTER TABLE sessions ADD CONSTRAINT sessions_tenant_id_id_uniq UNIQUE (tenant_id, id);

CREATE INDEX idx_messages_tenant_session ON messages(tenant_id, session_id, created_at);


CREATE TABLE knowledge_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kb_id       UUID NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(1024),       -- 需要先 CREATE EXTENSION vector（全书默认 voyage-3，1024 维）
  metadata    JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chunks_tenant_kb ON knowledge_chunks(tenant_id, kb_id);

-- 向量索引用 HNSW，pgvector 0.5+ 支持。相比 IVFFLAT：
--   - 不需要训练，建索引立即可用
--   - 召回率/延迟对参数不敏感，调参成本低
--   - RLS 过滤发生在索引扫描之后，HNSW 的多路扫描行为对 RLS 影响小
-- m / ef_construction 按知识库规模调整，下面是 10M 量级的典型配置
CREATE INDEX idx_chunks_embedding ON knowledge_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);


-- ─── 4. 计费记录表 ──────────────────────────────────────────────────────────

CREATE TABLE billing_records (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  period_start            DATE NOT NULL,
  period_end              DATE NOT NULL,
  total_input_tokens      BIGINT NOT NULL DEFAULT 0,
  total_output_tokens     BIGINT NOT NULL DEFAULT 0,
  total_cache_hit_tokens  BIGINT NOT NULL DEFAULT 0,
  total_requests          BIGINT NOT NULL DEFAULT 0,
  input_token_cost_cents  BIGINT NOT NULL DEFAULT 0,
  output_token_cost_cents BIGINT NOT NULL DEFAULT 0,
  amount_cents            BIGINT NOT NULL DEFAULT 0,     -- 单位：分（整数避免浮点）
  currency                VARCHAR(8) NOT NULL DEFAULT 'USD',
  status                  VARCHAR(20) NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'finalized', 'paid')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, period_start)
);


-- ─── 5. 启用 Row-Level Security ─────────────────────────────────────────────

-- ENABLE + FORCE 必须配套使用：
--   ENABLE 让策略生效，但表 owner 默认豁免
--   FORCE 让 owner 也受约束，避免应用通过 owner 角色绕过隔离
ALTER TABLE sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions          FORCE  ROW LEVEL SECURITY;

ALTER TABLE messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages          FORCE  ROW LEVEL SECURITY;

ALTER TABLE knowledge_chunks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks  FORCE  ROW LEVEL SECURITY;

ALTER TABLE billing_records   ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_records   FORCE  ROW LEVEL SECURITY;

ALTER TABLE tenant_configs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_configs    FORCE  ROW LEVEL SECURITY;


-- ─── 6. 创建隔离策略 ────────────────────────────────────────────────────────

-- 通用模式：从 GUC 变量 app.current_tenant_id 拿当前租户 ID
-- USING 子句作用于 SELECT/UPDATE/DELETE 的可见性
-- WITH CHECK 子句作用于 INSERT/UPDATE 的写入校验
-- 两者都设置，防止应用 bug 写入错误 tenant_id 的行

CREATE POLICY tenant_isolation ON sessions
  USING      (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON messages
  USING      (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON knowledge_chunks
  USING      (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON billing_records
  USING      (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- tenant_configs 同样开启 RLS：业务路径（agentflow_app）必须 SET LOCAL 后才能读自己的配置
-- 注意：ConfigManager 在请求路径之外也要读取任意租户的配置（启动预热、后台 worker），
-- 这种场景下必须用 agentflow_platform（BYPASSRLS）连接，而不是 agentflow_app
CREATE POLICY tenant_isolation ON tenant_configs
  USING      (tenant_id = current_setting('app.current_tenant_id')::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);


-- ─── 7. 授权 ────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE
  ON sessions, messages, knowledge_chunks, billing_records, tenant_configs
  TO agentflow_app;

GRANT USAGE, SELECT ON SEQUENCE messages_id_seq TO agentflow_app;


-- ─── 8. 使用示例 ────────────────────────────────────────────────────────────

-- 业务请求处理流程：
--
--   BEGIN;
--   SET LOCAL app.current_tenant_id = '00000000-0000-0000-0000-000000000001';
--   SELECT * FROM sessions WHERE created_at > NOW() - INTERVAL '1 day';
--   COMMIT;
--
-- 注意：SET LOCAL 仅在当前事务内有效，pgbouncer Transaction 模式下连接
-- 会被复用，必须每个事务开始时重新 SET LOCAL，不能 SET（不带 LOCAL）。


-- ─── 9. 验证脚本（部署后执行） ──────────────────────────────────────────────

-- 模拟租户 A 视角，应该看不到租户 B 的数据
--
--   SET LOCAL app.current_tenant_id = '<tenant-a-uuid>';
--   SELECT COUNT(*) FROM sessions;   -- 期望：只看到租户 A 的 session
--
-- 故意不设置 GUC 变量，应该报错（current_setting 找不到键）
--
--   SELECT * FROM sessions;          -- 期望：报错 unrecognized configuration parameter
--
-- 用 BYPASSRLS 角色登录后，应该看到全部数据
--
--   SET ROLE agentflow_admin;
--   SELECT COUNT(*) FROM sessions;   -- 期望：所有租户的 session 总数
