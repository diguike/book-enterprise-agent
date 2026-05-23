---
title: "附录 D｜压测基准数据"
feishu_url: "https://www.feishu.cn/wiki/RbV6wwHv9i0fYXkOYg0cCiIXnhd"
last_synced: "2026-05-11T17:30:04.097Z"
---

本附录的数字与第 1 章 1.1 节"规模校准"的假设保持一致：1M session、50K 用户侧 QPS、LLM 层 5K-10K 真实并发。读者在 1.1 节看到的换算结论，可以在本附录的 D.2 单点基准和 D.3 端到端压测中找到对应的实测数据。

## D.1 测试环境

本附录的数据来自 AgentFlow 在 2024 年 Q4 跑的一组完整压测，环境基本对齐生产配置。读者拿这组数字做容量规划时，要结合自己的 LLM 调用比例做线性外推——LLM 是延迟和成本的最大变量，其他基础设施反而是配角。

**硬件配置（AWS ap-southeast-1）：**

| 组件 | 规格 | 副本 | 说明 |
|---|---|---|---|
| API Pod | 4 vCPU / 8GB | 3 | Node.js 主进程 + sidecar |
| Worker Pod | 2 vCPU / 4GB | 5 | 处理 BullMQ 异步任务 |
| Postgres | r6g.xlarge（4 vCPU / 32GB / gp3 SSD） | 1 主 + 1 只读 | 启用 pgvector 0.7 HNSW 索引 |
| Redis | r7g.large（2 vCPU / 13GB） | 1 | 测试单实例；生产建议 Cluster 至少 3 主 3 副 |
| 网络 | 同 AZ，私网 | — | 跨节点 RTT < 1ms |

**软件版本：**

- Node.js 20.11 LTS
- Postgres 14.10 + pgvector 0.7.0
- Redis 7.4.1
- BullMQ 5.34.2
- Temporal 1.24.0
- Fastify 5.0.0
- 压测工具：k6 0.50.0

**压测说明：**

- 所有数字是 5 次跑的中位数，每次跑 10 分钟，丢弃前 1 分钟 warmup。
- 客户端机器：m6i.2xlarge × 3，跑 k6，避免客户端成为瓶颈。
- LLM 全部走真实 Anthropic / OpenAI API，没有本地模拟（mock 数据会让 LLM 延迟从 1.5s 变成 5ms，参考价值为零）。
- 测试期间监控了客户端机器的 CPU 和带宽，确认压测瓶颈不在客户端。

## D.2 单点性能基准

单点基准的意义在于：当你做端到端调优时，能立刻判断瓶颈在哪一层。下面这些数字是各组件"裸跑"时的极限，组合到一起后会比这个低。

### HTTP 框架（Fastify v5）

| 场景 | RPS | p50 | p99 | 备注 |
|---|---|---|---|---|
| Hello World（返回静态 JSON） | 47K | 1ms | 5ms | 单进程，开 cluster 后 × 核数 |
| JSON body 解析（1KB payload） | 38K | 2ms | 8ms | 含 schema 校验 |
| 含 JWT 验证 | 32K | 3ms | 12ms | RS256，key 缓存命中 |
| 含数据库查询（select by id） | 8K | 8ms | 35ms | 受 pg connection pool 限制 |

数据来源：用 k6 直接打 API Pod，绕过 ingress。每个场景跑 5 分钟，500 vus。

读法：JWT 验证从 38K 掉到 32K，意味着 RSA 验签每请求多花约 1ms CPU。如果是 HS256（HMAC），这个开销会降到 0.1ms 以下，但密钥分发更麻烦——业务量大时值得换。

### Postgres + pgvector 向量检索

| 数据规模 | 查询类型 | p50 | p99 | 说明 |
|---|---|---|---|---|
| 10 万条 | 向量 top-5（HNSW，m=16，ef=64） | 4ms | 18ms | 适合单租户冷启动 |
| 100 万条 | 向量 top-5（HNSW） | 8ms | 42ms | 中等规模租户 |
| 100 万条 | 混合检索（向量 + BM25 RRF 合并） | 25ms | 110ms | 启用 GIN 全文索引 |
| 1000 万条 | 向量 top-5（HNSW） | 35ms | 180ms | 大租户上限，再大要分片或迁移 Qdrant |
| 1000 万条 | 混合检索 | 95ms | 380ms | BM25 这一支成主要瓶颈 |

数据来源：在 r6g.xlarge 上灌测试数据，向量维度 1024（voyage-3 默认输出，与第 6 章建表 `vector(1024)` 一致），HNSW 参数 `m=16, ef_construction=64, ef_search=40`。换 `text-embedding-3-small`（1536 维）时索引体积约 ×1.5，p99 同比例上升。

观察：

- HNSW 的延迟随数据规模呈亚线性增长，1000 万条只比 10 万条慢 8 倍，符合 HNSW O(log N) 的理论复杂度。
- 混合检索的延迟是纯向量的 3 倍左右，因为 BM25 需要扫描更多 GIN 索引节点，且 RRF 合并阶段无法并行。
- 如果业务允许，先粗排（向量 top-50）再精排（BM25 + rerank top-5），比一次性 RRF 快 40%。

### Redis 操作

| 操作 | QPS | p99 |
|---|---|---|
| GET（单 key） | 100K | 2ms |
| MGET（10 keys） | 50K | 3ms |
| Lua 脚本（限流：令牌桶） | 80K | 3ms |
| Pipeline（5 ops 一批） | 200K | 4ms（按 op 算 1ms）|
| HSET（hash 写入） | 70K | 3ms |
| ZRANGE（小集合 100 元素） | 60K | 4ms |

数据来源：redis-benchmark + 自己写的 k6 脚本验证 Lua。Redis 单实例 r7g.large，CPU 跑到 85%。

容量参考：生产规划 30% 余量，单实例规划 70K QPS 上限。超过这个量级一定要 Cluster——不是因为吞吐打不动，而是单实例的故障 blast radius 太大。

### LLM API 延迟（外部依赖）

| 模型 | 输入 token | 输出 token | p50 | p99 | TPS（output） |
|---|---|---|---|---|---|
| Claude 3 Haiku（`claude-3-haiku-20240307`） | 1000 | 100 | 0.8s | 1.5s | ~120 t/s |
| Claude Sonnet 4.5（`claude-sonnet-4-5`） | 1000 | 100 | 2.1s | 4.5s | ~50 t/s |
| Claude 3 Opus（`claude-3-opus-20240229`） | 1000 | 100 | 3.5s | 8.0s | ~30 t/s |
| GPT-4o-mini | 1000 | 100 | 1.2s | 2.8s | ~85 t/s |
| GPT-4o | 1000 | 100 | 2.4s | 5.5s | ~45 t/s |

模型 ID 与第 4 章 `MODEL_BY_COMPLEXITY` 配置一致（simple/moderate/complex 三档分别对应 Haiku/Sonnet 4.5/Opus）。Fallback 链统一走 `gpt-4o-mini`。

数据来源：从 Singapore region 调用，连续打 1000 次，剔除超时（< 1%）。

要点：

- LLM 延迟和输出长度近似线性。输出 500 tokens 时 Sonnet 的 p50 会到 10s 左右。
- p99 和 p50 的比值通常在 2-2.5×。如果你看到自己的服务 p99/p50 > 5，多半是排队、重试或限流叠加，不是 LLM 本身的问题。
- 启用 prompt cache 后，cache hit 的 first token 延迟能降 40-60%（输入 token 不算 prefill）。

## D.3 端到端压测

端到端测的是"整条链路"：用户 HTTP 请求 → JWT 鉴权 → 限流 → 会话恢复 → LLM 调用 → 工具调用 → 持久化 → 返回。

### baseline 场景：稳态压测

- **模式**：k6 ramp-up 30s 到 500 vus，持续 10 分钟。
- **场景配比**：60% 闲聊（仅 LLM）、30% 工具调用（LLM + DB）、10% 知识库检索（LLM + pgvector）。
- **平均 RPS**：8200
- **延迟分布**：
  - p50 = 320ms
  - p95 = 850ms
  - p99 = 2.1s
- **错误率**：0.02%（11 个 500，主要是 LLM 偶发 5xx）
- **LLM 调用平均次数**：1.4 次 / req（部分请求触发了 tool use 二次调用）
- **prompt cache 命中率**：78%
- **资源水位**：
  - API Pod CPU 平均 65%，峰值 82%
  - Worker Pod CPU 平均 40%
  - Postgres CPU 35%
  - Redis CPU 22%

数据来源：跑了 5 轮取中位数。Langfuse 上完整 trace 已存档。

### spike 场景：突发流量

- **模式**：10 秒内从 100 vus 飙升到 3000 vus（30 倍跳变），持续 2 分钟，再回落。
- **结果**：
  - 限流触发：5800 个请求被 429 拒绝（占总流量 18%）。
  - circuit breaker：未触发（LLM 没有失败，只是被我方限流挡住）。
  - 通过限流的成功请求 p99：1.8s（比 baseline 还低一点，因为限流后整体压力反而轻）。
  - HPA 扩容：API Pod 从 3 扩到 8 用时 90 秒，但在扩容完成前已经被限流挡住了流量峰值。
- **结论**：限流是抗 spike 的第一道防线，比 HPA 快 1-2 个数量级。HPA 只能解决"持续高水位"，spike 必须靠限流挡。

### fault-inject 场景：依赖故障

- **模式**：用 toxiproxy 给 LLM API 注入 50% 概率返回 429。
- **结果**：
  - fallback 触发率：35%（部分 429 被 SDK 内置重试吃掉了，剩下的命中应用层 fallback）。
  - 降级路径 p99：1.2s（fallback 用 Haiku + 模板回复，比正常路径快）。
  - 用户感知：约 8% 的请求收到了"系统繁忙，请稍后再试"的兜底回复。
  - 错误率：0.4%（少数请求 fallback 也失败，直接抛错）。
- **结论**：fallback 链路必须比主链路简单、快、可控。生产里 fallback 跑 Haiku + 不调工具，几乎不会再失败。

## D.4 容量规划

基于 baseline 数据做线性外推（注意：超过 1 万 RPS 时存在非线性效应，要预留 30% 余量）。

**单 API Pod 的极限：**

baseline 跑出来 3 个 Pod 撑 8200 RPS，单 Pod 约 2700 RPS。如果业务 LLM 调用占比上升（比如从 60% 变成 90%），单 Pod RPS 会降到 1500 左右，因为 LLM 调用期间 connection 占用时间更长。

**目标 100K RPS 的规划：**

- API Pod：100K / 2700 ≈ 37 个，规划 40 个（留 8% 余量给 HPA 滚动）。
- Worker Pod：异步任务通常是 RPS 的 0.2 倍，规划 25 个。
- Postgres：100K RPS 中 30% 命中 DB ≈ 30K DB QPS，单实例 r6g.xlarge 撑不住，需要 r6g.4xlarge + 2 个只读副本。
- Redis：100K RPS 中 90% 命中 Redis（缓存 + 会话 + 限流）≈ 90K Redis QPS，需要 3 主 3 副本 Cluster。
- LLM token 配额：100K RPS × 1.4 次 / req × 输出 100 token ≈ 14M 输出 token / s ≈ 84M / min。这个量级要找供应商单独申请配额，默认 tier 远远不够。

**100K 日活租户场景的规划（更现实）：**

按 AgentFlow 实际数据，10K 日活用户产生约 200K 请求 / 天，峰值集中在工作日 10-12 点和 14-17 点。换算下来：

- 峰值 QPS：200K × 0.2（峰值集中度）/ 3600 ≈ 11 QPS。
- 即使 100 个租户都满活跃，总峰值约 1100 QPS。
- 实际需要：6 个 API Pod + 10 个 Worker + 1 主 1 副 DB + Redis 单实例（不用 Cluster）。

很多团队上来就规划 100K RPS，结果买了 50 台机器跑 10 QPS。**先按真实业务规划，留 3-5 倍余量给增长，不要按理论极限规划。**

## D.5 成本基准（基于真实账单）

以下数据是 AgentFlow 租户 A（电商，10K 日活）在 2024 年 10 月走完 12.7 节四阶段优化（原型 $50K → prompt caching $20K → 语义缓存 $8K → 精细化 $5K）之后的稳定态账单。读者按自己规模线性缩放即可。

**月度成本拆分（Phase 4 优化后稳定态，按总计中位数 $6.5K 计算占比）：**

| 项目 | 月成本 | 占比 | 说明 |
|---|---|---|---|
| LLM API（Anthropic 主 + OpenAI 兜底） | $3K - $5K | 55%-62% | 范围取决于 prompt cache + 语义缓存命中率 |
| K8s 节点（EKS，约 12 台 m6i.large） | $1.8K | 24% | 含 API + Worker + 监控 |
| Postgres RDS（r6g.xlarge + 1 副本） | $750 | 10% | 含备份和 IOPS |
| Redis ElastiCache（r7g.large × 3 主 3 副，Cluster 模式） | $840 | 11% | 生产 Cluster 拓扑，单实例只用于压测环境 |
| 数据传输与存储（S3、跨 AZ 流量） | $400 | 5% | |
| 可观测性（Langfuse 自托管） | $200 | 3% | 1 台 c6i.large + 100GB pgvector |
| 其他（DNS、WAF、ELB） | $300 | 4% | |
| **总计** | **$7.3K - $9.3K** | 100% | 与 12.7 节"Phase 4：月 $5K"叙事方向一致，$5K 是 LLM 部分，再叠加基础设施后到此区间 |

**每个日活用户的单价：$0.7 - $0.9 / 用户 / 月**

优化前（Phase 1，月 $50K，仅 LLM 部分就如此）的单价高达 $5 / 用户 / 月，毛利完全做不出来——这也是 12.7 节那次优化的起点。

这个数字直接决定商业模式：

- 如果你卖企业版 SaaS 按用户 / 月计费，定价必须 ≥ $3 / 用户 / 月才有正毛利。
- 如果你做 to C，免费用户必须严格限频（一天 5 次以内），否则单用户成本会破 $0.3 / 月。
- LLM 成本占比超过 50% 是常态，优化 prompt cache 命中率 10 个百分点，能省 6-8% 总成本，比抠基础设施值钱得多。

**prompt cache 命中率对成本的影响（实测，基于 Phase 1 的 $50K 量级、未叠加语义缓存）：**

| cache 命中率 | LLM 月成本 | 相对节省 |
|---|---|---|
| 30%（典型未优化） | $50K | baseline |
| 60% | $35K | -30% |
| 80% | $28K | -44% |
| 90% | $24K | -52% |

cache 命中率每提高 10%，省的钱大概是 6-8% 的 LLM 账单。优化方向是 C.1 讲的分层 prompt 结构 + 把动态信息推到最后。叠加 12.7 节的模型分级（Haiku/Sonnet 路由）和语义缓存（阈值 0.92-0.95）才能进一步压到 $5K 量级。

## D.6 监控基准线

下面这组数字是 AgentFlow 生产用的告警阈值，已经调过 3 个版本，能稳定区分"正常波动"和"真出事"。

**正常态（不应告警）：**

| 指标 | 正常范围 | 说明 |
|---|---|---|
| API p99 延迟 | < 3s | baseline 是 2.1s，留 40% 余量 |
| API p50 延迟 | < 500ms | 包含 LLM 调用 |
| LLM 调用平均次数 | 1.2 - 2.0 / req | 工具调用密集场景上限 2.5 |
| prompt cache 命中率 | > 60% | 低于 60% 检查 prompt 结构 |
| Skill 成功率 | > 99% | 工具调用成功率 |
| HTTP 错误率 | < 0.1% | 含 5xx 和超时 |
| LLM API 错误率 | < 0.5% | 含 429、5xx、超时 |
| Redis 命中率 | > 85% | 会话缓存命中 |
| Postgres 连接池使用率 | < 70% | 单 Pod 池子 20 个连接 |

**异常态（必须告警）：**

| 指标 | 阈值 | 推断的故障 |
|---|---|---|
| API p99 > 5s 持续 5 分钟 | P1 | LLM 慢 / DB 慢 / 排队积压 |
| API 错误率 > 1% 持续 3 分钟 | P0 | 上游故障 / 代码 bug / 限流误伤 |
| LLM 调用平均 > 3 次 / req | P2 | agent 陷入循环或工具失败重试 |
| prompt cache 命中率 < 40% 持续 30 分钟 | P3 | prompt 结构破坏 / 部署引入动态字段 |
| Postgres 连接池使用率 > 90% 持续 5 分钟 | P1 | 慢查询 / 连接泄漏 |
| Redis 命中率 < 70% | P2 | 缓存策略失效 / TTL 配置错误 |
| LLM API 错误率 > 5% 持续 2 分钟 | P0 | 供应商故障，立即切换备用模型 |
| Worker queue 长度 > 1000 持续 5 分钟 | P2 | 异步任务积压 |
| Skill 成功率 < 95% | P1 | 工具实现 bug / 第三方 API 故障 |

**告警分级建议：**

- **P0（5 分钟响应）**：影响所有用户的核心功能不可用。直接电话告警。
- **P1（30 分钟响应）**：影响部分用户或核心指标显著退化。即时通讯告警。
- **P2（4 小时响应）**：单一功能异常、有 workaround。工单 / 邮件告警。
- **P3（24 小时响应）**：观察项，不影响业务。聚合到日报。

**告警最重要的不是阈值，而是"是否可操作"。** 如果告警响了大家也不知道该做什么，不如不响。每个告警都应该附一条 runbook 链接，说明：

1. 这个告警代表什么故障类型。
2. 第一时间该看哪些 dashboard / log。
3. 已知的 mitigation（如切流、回滚、扩容）。
4. 升级到谁。

线上跑久了你会发现，能持续生效的告警通常只有 10-15 条。剩下的不是失效就是噪声，定期 review 砍掉。
