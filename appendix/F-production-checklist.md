---
title: "附录 F：上线前 Checklist"
feishu_url: "https://www.feishu.cn/wiki/JN57wLI5Hit7X2kRZNmcXXKvnGc"
last_synced: "2026-05-11T17:30:12.208Z"
---

## 写在前面

这份 checklist 是从 AgentFlow 三次真实上线复盘里沉淀出来的。第一次上线时我们只查了 20 项就匆匆开放，结果第二周接连出了 3 起 P1 故障；第二次扩到 80 项，故障数量下降但还有遗漏；第三次扩到现在的 110 项，正式投产后一个月内零 P1。

使用方式：上线前一周开始走清单，每项必须有人 owner、有验证证据（截图、日志、命令输出）、有完成时间。所有项目都 check 完才能进入"上线 Day 1"流程。不要图省事跳过，跳过的项目就是上线后的故障源。

每一节对应一个核心维度，标注了对应章节。每一项后面用一两句话说明，重点项目展开。

## F.1 架构与基础设施（对应第 1、12 章）

```
□ Postgres 主从复制配置（无单点故障）
□ Postgres 自动备份策略（每日 + 异地）
□ Postgres PITR（point-in-time recovery）测试过
□ Redis Cluster 6 节点部署（3 主 3 从）
□ Redis 持久化策略（RDB + AOF 双开）
□ Temporal Server 集群部署（3 节点，PG 后端）
□ Temporal Visibility 用 ES 或 PG 单独配置
□ Langfuse 自托管部署
□ K8s 集群跨 AZ 部署
□ Ingress 配置 SSL（cert-manager 自动续签）
□ DNS TTL 设置合理（< 300s 便于切换）
□ NodePort/LoadBalancer 配置审计
□ 内网与外网流量分离（VPC 划分清楚）
```

**重点说明**

Postgres 主从不要用 PgPool 这种轻量方案，生产用 Patroni 或托管的 Cloud SQL / RDS。AgentFlow 的数据规模到几百万 session 后，单库 IO 就是瓶颈，必须读写分离。

Redis Cluster 必须是 3 主 3 从拓扑（不是 3 主 0 从）。单 master 挂了之后 slave 接管才有意义。AgentFlow 用 Redis 跑限流、session 缓存、配置缓存、circuit breaker 状态、BullMQ 队列——任何一个 master 单点故障都会拖垮整个 API 层。

Temporal Visibility 默认用主 Postgres，但 workflow 量大了之后 Visibility 查询会拖慢业务表。生产建议单独一个 ES 集群或单独一个 PG 实例。

## F.2 Agent 引擎与 LLM Gateway（对应第 3、4 章）

```
□ LLM Gateway 多 provider 配置（至少 2 个）
□ Prompt caching 已启用（验证 cache_read_input_tokens > 0）
□ 语义缓存阈值已调优（默认 0.92）
□ 语义缓存按租户隔离（不跨租户复用）
□ Model 路由策略已配置（simple/moderate/complex 分流）
□ Token budget per tenant 已设置
□ Circuit breaker 已启用（Redis 存状态）
□ Fallback 链路已测试（手动模拟主 provider 失败）
□ Agent max steps 上限已设（默认 15）
□ Agent 总超时已设（默认 120s）
□ Streaming + Tool use 同时启用时的边界 case 已测
□ Prompt 版本化（每个 prompt 有 hash + 元数据）
```

**重点说明**

Prompt caching 是省钱大头，但很容易上线后发现没生效。验证方式：在 Langfuse 上找一个相同 system prompt 的 trace 序列，看第二次以后的 `cache_read_input_tokens` 是否 > 0。如果一直是 0，多半是 system prompt 在序列化时不稳定（比如包含 `Date.now()` 或随机排序的字段）。

Fallback 链路必须真的测过，不能"代码里写了 try-catch 就算"。具体做法：在 staging 把主 provider 的 API key 改成无效值，发一批请求，确认每条都走到 fallback 而不是直接报错给用户。

Circuit breaker 状态必须存 Redis，不能存进程内。理由：API 副本数 ≥ 5 的时候，进程内状态各算各的，主 provider 真挂了也熔不彻底，仍有 1/5 流量打过去。

## F.3 Skill 系统（对应第 5 章）

```
□ isolated-vm 沙箱在独立 Pod（NOT 与主 API 同进程）
□ 沙箱 NetworkPolicy 限制出网
□ Skill 域名白名单已配置
□ SSRF 防护已启用（私有 IP 拒绝）
□ Skill 资源限制（内存 + CPU 时间）
□ Skill 调用幂等性已审计
□ 内置 Skill 全部 review 过
□ 自定义 Skill 审核流程上线
□ Skill 调用日志全量入 Langfuse
□ Skill 失败重试策略已配置
□ Skill 返回大小限制（防超长返回污染上下文）
```

**重点说明**

沙箱 Pod 必须独立。把 isolated-vm 跟主 API 跑在同一个进程里是上线最大的坑——一次 RCE 直接洞穿 API。AgentFlow 的设计是 sandbox Pod 通过 gRPC 暴露给 API，沙箱网络全靠 NetworkPolicy 拒绝出网。

SSRF 防护要做白名单 + 黑名单双层。白名单是用户配置的允许域名（比如租户配的自家 API），黑名单是私有 IP 段（10/8、172.16/12、192.168/16、169.254/16、127/8、::1、fd00::/8）。两者都过才能放行。

幂等性容易被忽略。Agent 重试时同一个 Skill 调用可能被执行 2-3 次，写操作（发送邮件、扣款、创建工单）必须带 idempotency-key。

## F.4 知识库 / RAG（对应第 6 章）

```
□ pgvector HNSW 索引已建（不是 IVFFlat）
□ HNSW 参数已调（m=16, ef_construction=64 是基线）
□ 中文分词扩展已安装（zhparser 或 pg_jieba）
□ Embedding 模型版本已固定（避免向量空间漂移）
□ Embedding 维度与索引匹配（全书默认 1024，对应 voyage-3；OpenAI text-embedding-3-small 为 1536）
□ 文档解析 PDF/Word 测试通过
□ 大文件 chunking 策略已审计（不要切碎语义）
□ 知识库租户隔离已验证（跨租户搜索测试）
□ 增量索引软删除流程已测试
□ 重建索引的 rolling rebuild 方案已 documented
□ Reranker 已接入（如果用了）
```

**重点说明**

HNSW vs IVFFlat：HNSW 召回率高但内存占用大，IVFFlat 快但召回差。AgentFlow 用 HNSW，前提是机器够大。如果用了 IVFFlat 还没察觉，那基本 90% 的相关结果丢了。

Embedding 模型一旦固定就不能轻易换。换模型 = 全库重建索引 = 几小时到几天的维护窗口。建议在 schema 里把 `embedding_model_version` 字段加上，未来切换时支持新旧并存。

中文分词只对 BM25 路径有用，向量搜索不需要分词。但 hybrid retrieval（向量 + BM25）现在是主流，分词必须装。

## F.5 会话与状态（对应第 7 章）

```
□ Redis hash tag 已统一使用（{tenantId}、{sessionId}）
□ Session TTL 已设置（30 分钟）
□ 会话归档到 Postgres 已实现
□ Temporal Worker 已部署
□ Workflow 确定性已 review（无 Date.now/Math.random）
□ 长对话压缩策略已测试
□ 跨 Pod 会话粘性已处理（或确认无状态）
□ SSE 流的断线续传已实现
□ 会话内存 token 上限已设（防止上下文爆炸）
```

**重点说明**

Redis hash tag 是 Cluster 模式下的硬要求。任何 multi-key 操作（MGET、Lua 脚本、Transaction）只能在同一个 slot 里执行，hash tag 让相关 key 落到一起。比如 session 的 hash 和该 session 的限流计数器要带 `{sessionId}` 在 key 里。

Workflow 确定性最容易踩的坑是 third-party SDK——某些 SDK 里偷偷调了 `Date.now()` 或者用了随机 retry jitter，业务代码看着没问题，replay 时就崩。CI 加 lint 规则禁止 workflow 文件 import 这些 SDK。

会话压缩在长对话场景必备。AgentFlow 的策略是超过 32k tokens 时把前面的对话用 Sonnet 摘要成 2k tokens，保留最近 5 轮原文。压缩本身也要花 token，所以要监控压缩频率。

## F.6 多租户（对应第 8 章）

```
□ RLS 在所有租户表启用（ENABLE + FORCE）
□ USING + WITH CHECK 都已设置
□ pgbouncer Transaction 模式 + SET LOCAL 验证
□ 双连接池（agentflow_app + agentflow_platform）
□ 平台连接池只给运维用，业务代码不能用
□ 租户配置三级缓存已实现（DB + Redis + Pod LRU）
□ 配额扣减 Lua 脚本已 review
□ 滑动窗口限流已部署
□ 跨租户查询走专门审计接口
□ 租户隔离测试 case 入 CI
```

**重点说明**

RLS 的 `ENABLE` 和 `FORCE` 两个都要打开。只 ENABLE 的话，表的 owner（通常是 migration user）仍然能绕过策略，一旦业务代码用了 owner 账号就是裸奔。FORCE 之后 owner 也受 RLS 约束。

`USING` 控制读，`WITH CHECK` 控制写。两个必须都写——只写 USING 的话，攻击者可能能写入别的租户的数据，自己读不到但污染了别人。

pgbouncer Transaction 模式 + SET LOCAL 的组合一定要验证，因为 Transaction 模式下 SET（无 LOCAL）会跨连接污染。本地起一个 pgbouncer 跑测试：连接 A 设了 tenant_id=X，连接 B 读到的应该是 default 而不是 X。

## F.7 安全（对应第 9 章）

```
□ API Key 在 Secrets Manager / Vault（不在 env）
□ Key 轮换流程已演练
□ Key 泄漏应急流程已 documented
□ Prompt Injection 检测正则已配置
□ system prompt 加固版本（含拒绝输出指令）
□ PII 脱敏 mapping 加密存储
□ Skill 权限模型已审核
□ 安全审计日志已开启
□ 审计日志独立存储（防被 root 篡改）
□ 日志保留期符合合规（GDPR 等）
□ Outbound 请求出口固定 IP（便于 provider 侧加白名单）
□ 镜像漏洞扫描通过（Trivy / Snyk）
```

**重点说明**

Key 轮换不能等出事再演练。最佳实践是每季度走一次完整流程：生成新 key → 灰度发布到 10% 流量 → 验证 → 全量切 → 撤销旧 key。整个流程要有 runbook，谁来执行、谁来 review、回滚怎么做都要写清楚。

PII 脱敏 mapping 是一把双刃剑。脱敏后还要有反查能力（比如客服要看到真实手机号），mapping 表本身就是个高价值目标。AgentFlow 的方案是 mapping 表用 KMS 加密，访问要二次身份认证。

system prompt 加固有标准范式：明确角色、限定能力、拒绝指令注入、限定输出格式。可以参考 Anthropic 的 prompt engineering 文档。

## F.8 高并发与稳定性（对应第 10 章）

```
□ 入口令牌桶配置完成
□ Agent 层并发限制已设
□ BullMQ Worker 副本数 ≥ 5
□ Worker 任务超时已设
□ DLQ 已部署 + 告警接通
□ Circuit Breaker 在 Redis（不在内存）
□ 重试加 jitter 抖动
□ 压测达标（baseline + spike + fault-inject 三场景）
□ 慢查询监控告警接通
□ Backpressure 在所有流处理点都实现
□ 长尾请求超时统一管理
```

**重点说明**

压测要分三场景。Baseline：稳态流量（预期 RPS 持续 30 分钟），验证基础性能；Spike：3 倍流量冲击 5 分钟，验证扩容反应；Fault-inject：随机杀 Pod、断网、调 LLM provider 失败率，验证降级和恢复。AgentFlow 一上线的目标是 baseline P99 < 3s，spike 期 P99 < 8s，fault-inject 期可用性 > 95%。

重试 jitter 是避免雪崩的关键。固定 backoff 的重试会让所有失败请求同时重试，把 provider 二次打挂。jitter 范围至少 ±25%。

DLQ 必须接告警。死信进了 DLQ 不看，相当于业务静默丢失。AgentFlow 的规则是 DLQ 任意一条消息进入 30 分钟内必须有人处理。

## F.9 可观测性（对应第 11 章）

```
□ OTel 接入完成（trace + metrics）
□ Langfuse 接入完成
□ 跨 Pod trace 传播已验证（HTTP + BullMQ）
□ GenAI semantic conventions 字段全部上报
□ trace sampling 策略合理（错误 100%，正常 1-10%）
□ 关键告警接通（p99、错误率、成本突刺）
□ 告警 SLO 已定义（不要每个指标都告警）
□ 每租户成本 dashboard 已上线
□ 每租户 SLA dashboard 已上线
□ Prompt 版本管理已启用
□ Runbook 链接挂在告警里（点告警直达解决方案）
□ 日志结构化（JSON）+ 日志聚合
```

**重点说明**

跨 Pod trace 传播是最容易出错的地方。HTTP 调用要传 `traceparent` header，BullMQ 任务要把 trace context 放进 job data，从队列消费时手动 inject 回 context。验证方式：在 Langfuse / Jaeger 上找一个完整的 user request，确认 trace 上 API → Worker → Sandbox 这条链是连起来的，不是断成三段。

成本 dashboard 要按租户拆分，按 day/hour 切片。一上线就要建好——如果不建，第一次成本异常时只能事后从 log 翻数据。

Prompt 版本管理在 AgentFlow 里是 `(prompt_text, version, created_at, author, metrics)` 五元组。版本回退要 1 分钟内完成，否则线上 prompt 改坏了的损失就放大了。

## F.10 部署与运维（对应第 12 章）

```
□ Docker 镜像非 root 用户
□ Pod 健康检查 readiness/liveness 分离
□ Readiness 检查依赖（DB、Redis 连得通才 Ready）
□ Liveness 检查极简（防止级联失败）
□ HPA 配置完成（CPU + 队列深度）
□ PodDisruptionBudget 已设置
□ Rolling update maxUnavailable=0
□ SSE 流的 preStop sleep 已配置
□ DB schema 迁移分步发布流程已验证
□ pgvector → Qdrant 迁移路径已 documented
□ Helm Chart / Kustomize 模板化（环境差异参数化）
□ GitOps 流程已建立（ArgoCD / Flux）
□ 镜像 tag 不用 latest，用 git sha
```

**重点说明**

Readiness vs Liveness 分离是个老话题但仍有人搞错。Readiness 检查依赖（DB 连不上就不接流量），Liveness 检查只看进程本身是否卡死（HTTP 自检即可）。如果 Liveness 也检查 DB，DB 抖一下所有 Pod 同时被 K8s 重启，业务直接全挂。

DB schema 迁移分四步：1）新增字段（兼容旧代码）；2）发新代码（读旧字段，写双字段）；3）回填历史数据；4）切到新代码（读新字段）+ 后续清旧字段。一步到位的 migration 在生产是禁止的。

Helm Chart 模板化时，把镜像 tag、副本数、资源 limit、外部依赖地址都做成 values.yaml 的参数，dev/staging/prod 用同一份 chart 不同 values。

## F.11 灾备与应急（对应第 12 章）

```
□ DR 演练完成（数据库故障切换）
□ Pod 大规模重启演练（>50% Pod 重启不丢业务）
□ 跨 AZ 故障演练（一个 AZ 整体下线）
□ 紧急 Key 轮换 runbook 已写
□ 故障 escalation 流程已建立
□ On-call rotation 已排
□ On-call 工具链已配置（PagerDuty / Opsgenie）
□ 故障排查手册（附录 E）团队已熟悉
□ 数据备份恢复演练完成
□ 紧急联系人通讯录已更新
□ 客户公告模板已准备（SLA 通知）
```

**重点说明**

DR 演练不能停留在文档。每季度做一次实战：故意把 staging 的主库停掉，看从库能不能升主，看应用切换连接串需要多久，看数据有没有丢。AgentFlow 的目标是 RTO < 5 分钟、RPO < 30 秒。

On-call 排班要避免单点。每个班次至少有 primary + secondary，primary 15 分钟无响应自动升级到 secondary。新员工进 on-call 前必须跟班至少 2 周。

客户公告模板提前准备。SLA 通知是给客户看的，不是给团队的吐槽。模板要包括：故障开始时间、当前状态、影响范围、临时解决办法、预计恢复时间、后续 RCA 报告时间。

## F.12 上线 Day 1 关注事项

上线第一天值班的人，盯以下指标，任何一个偏离基线 2 倍以上立刻 escalate：

**业务可用性**

- 请求总数（每分钟）：上线后流量是否正常爬升
- 请求成功率：必须 > 99.5%
- p50 / p95 / p99 延迟：跟压测基线对比
- SSE 流完整率：> 95%

**LLM 层**

- LLM 调用 p99 延迟
- LLM 错误率（按 provider 分）
- Token 总消耗（每分钟）
- Prompt caching 命中率：> 50% 才算正常
- 语义缓存命中率：> 30% 才算正常

**资源水位**

- 各 Pod CPU / Memory 使用率：稳定 < 70%
- Postgres 连接数：< max_connections 的 70%
- Redis memory：< maxmemory 的 70%
- BullMQ 队列深度：稳定，不持续增长

**租户视角**

- 按租户 top 10 的请求量、成本、错误率
- 每租户 quota 使用率
- 异常租户告警（成本飙升、错误集中）

**安全相关**

- Injection 拦截次数：基线建立期，突增告警
- 401/403 错误率：识别可能的 brute force
- 异常 IP 访问模式

**Day 1 应急准备**

- 值班团队全员到位（开发 + 运维 + 安全 + PM）
- 上一版本回滚命令已准备好（直接 `kubectl rollout undo` 能用）
- 客户成功团队待命，准备处理用户反馈
- 通讯录 + Zoom war room 链接已 ping 过

Day 1 最重要的不是"没出故障"，是"出了故障能在 SLA 内处理"。准备好回滚、准备好降级开关、准备好客户沟通，比追求零故障更现实。

## 结语

这份 checklist 是动态的——AgentFlow 每出一类新问题、每接入一项新能力、每经过一次架构升级，都会有新的项目加进来。建议团队把这份 checklist 维护在内部 wiki 上，每次上线后回顾"哪些项目漏了、哪些项目其实没必要"，把它打磨成自己团队的版本。

上线只是开始，不是终点。让每一次上线都比上一次更稳，是 AgentFlow 这种长期演进系统的核心运维哲学。
