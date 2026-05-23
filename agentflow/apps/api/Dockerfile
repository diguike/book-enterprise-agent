# AgentFlow API Dockerfile（多阶段构建）
#
# 阶段 1：deps —— 安装全部依赖（包括 devDeps，用于构建）
# 阶段 2：build —— 编译 TypeScript
# 阶段 3：runner —— 仅运行时依赖 + 编译产物，最小化镜像体积

FROM node:20-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json* turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/llm-gateway/package.json packages/llm-gateway/
COPY packages/session/package.json packages/session/
COPY packages/agent-engine/package.json packages/agent-engine/
COPY apps/api/package.json apps/api/
RUN npm install --no-audit --no-fund

FROM deps AS build
WORKDIR /repo
COPY packages packages
COPY apps/api apps/api
# 按 workspace 依赖顺序构建
RUN npm run build --workspace=@agentflow/shared && \
    npm run build --workspace=@agentflow/llm-gateway && \
    npm run build --workspace=@agentflow/session && \
    npm run build --workspace=@agentflow/agent-engine && \
    npm run build --workspace=@agentflow/api

FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /repo
# 只 copy 编译产物 + 运行时依赖
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages packages
COPY --from=build /repo/apps/api apps/api
COPY --from=build /repo/package.json ./package.json
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
