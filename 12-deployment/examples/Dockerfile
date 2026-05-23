# syntax=docker/dockerfile:1.6
# AgentFlow 多阶段 Dockerfile
# 通过 --build-arg APP=api|worker|sandbox 选择启动哪一个 app

# ================================================================
# Stage 1: builder（带 devDeps + 编译器，体积大）
# ================================================================
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# 先复制 manifest 文件，最大化 Docker 层缓存
# 业务代码变更但 package.json 没变时不会重装依赖
COPY package*.json ./
COPY packages/agent-engine/package.json packages/agent-engine/
COPY packages/llm-gateway/package.json packages/llm-gateway/
COPY packages/skill-system/package.json packages/skill-system/
COPY packages/knowledge-base/package.json packages/knowledge-base/
COPY packages/session/package.json packages/session/
COPY packages/observability/package.json packages/observability/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/sandbox/package.json apps/sandbox/

# native addon 需要的编译工具：
# - isolated-vm：C++ 扩展，编译时需要 build-essential 和 python
# - @temporalio/core-bridge：Rust 写的，构建时由 prebuilt binary 提供
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# 安装全部依赖（含 devDependencies），TS 编译需要 typescript
RUN npm ci

# 拷源码并编译
COPY . .
RUN npm run build

# 编译完成后，把 devDependencies 剪掉，缩小最终 runtime 复制成本
RUN npm prune --omit=dev

# ================================================================
# Stage 2: runtime（只包含运行所需文件）
# ================================================================
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# 安装运行时需要的最小依赖（CA 证书用于 HTTPS）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        tini && \
    rm -rf /var/lib/apt/lists/*

# 创建非 root 用户，uid 1001 与常见 K8s securityContext 对齐
# nologin shell 避免被攻破后开 shell
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /usr/sbin/nologin -M agentflow

# 只复制 build 阶段产物，不带源码、测试、git 历史
COPY --from=builder --chown=agentflow:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=agentflow:nodejs /app/packages ./packages
COPY --from=builder --chown=agentflow:nodejs /app/apps ./apps
COPY --from=builder --chown=agentflow:nodejs /app/package.json ./

USER agentflow
EXPOSE 3000

# 收到 SIGTERM 时进入优雅关闭。tini 作为 PID 1 负责正确转发信号
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]

# 通过 ARG 选择启动哪个 app
# 构建时：docker build --build-arg APP=worker -t agentflow/worker:vX .
ARG APP=api
ENV APP_PATH=apps/${APP}/dist/index.js

# 用 sh -c 才能让环境变量在 CMD 里展开
CMD ["sh", "-c", "node $APP_PATH"]
