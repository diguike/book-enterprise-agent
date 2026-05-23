# 第 12 章配套代码

本目录包含 AgentFlow 部署到 K8s 的全部清单和脚本。

## 目录结构

```
examples/
  Dockerfile               # 多阶段构建（debian-slim 基础 + 非 root）
  .dockerignore
  k8s/                     # 原生 K8s 清单（不依赖 Helm）
    api-deployment.yaml
    api-hpa.yaml
    worker-deployment.yaml
    sandbox-deployment.yaml
    postgres-statefulset.yaml
    redis-cluster.yaml
    secrets.yaml.example   # 复制为 secrets.yaml 后填入真实值
    configmap.yaml
    ingress.yaml
  helm/agentflow/          # Helm Chart 等价物
    Chart.yaml
    values.yaml
    templates/
  scripts/
    migrate-to-qdrant.ts   # pgvector → Qdrant 双写迁移
```

## 快速试跑（kind 本地集群）

```bash
# 1. 创建 namespace
kubectl create namespace agentflow

# 2. 部署 Secret（复制模板填值）
cp k8s/secrets.yaml.example k8s/secrets.yaml
# 编辑 k8s/secrets.yaml 填入真实凭证
kubectl apply -f k8s/secrets.yaml

# 3. 部署依赖（生产用云托管，本地用 StatefulSet）
kubectl apply -f k8s/postgres-statefulset.yaml
kubectl apply -f k8s/redis-cluster.yaml

# 4. 部署应用
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/api-deployment.yaml
kubectl apply -f k8s/api-hpa.yaml
kubectl apply -f k8s/worker-deployment.yaml
kubectl apply -f k8s/sandbox-deployment.yaml
kubectl apply -f k8s/ingress.yaml
```

## Helm 部署

```bash
# 渲染检查
helm template agentflow ./helm/agentflow

# 安装
helm install agentflow ./helm/agentflow -n agentflow --create-namespace

# 升级（修改 values.yaml 或通过 --set 覆盖）
helm upgrade agentflow ./helm/agentflow -n agentflow \
  --set image.tag=v1.0.1

# 蓝绿切换沙箱版本（参考 12.6 节）
helm upgrade agentflow ./helm/agentflow -n agentflow \
  --set sandbox.version=v2
```

## pgvector → Qdrant 迁移

```bash
# 双写阶段已经运行后，跑回填脚本
npm run script -- migrate-to-qdrant.ts \
  --batch 500 \
  --collection knowledge_chunks \
  --mode backfill \
  --rate 5

# reconcile 模式：定时跑，补齐双写期间丢失的记录
npm run script -- migrate-to-qdrant.ts \
  --batch 1000 \
  --collection knowledge_chunks \
  --mode reconcile \
  --rate 2
```
