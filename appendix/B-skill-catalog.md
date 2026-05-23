---
title: "附录 B — 内置 Skill 库清单"
feishu_url: "https://www.feishu.cn/wiki/DSf8woF28icOIckWLjccQ4txnJb"
last_synced: "2026-05-11T17:29:55.289Z"
---

## 阅读说明

AgentFlow 平台默认提供一组开箱即用的 Skill，覆盖搜索、数据查询、内容生成、通信协作、数据处理、知识库等高频场景。本附录把每个内置 skill 的描述、输入输出 schema、调用限制、授权要求列成参考清单，方便在配置租户和写自定义 prompt 时查阅。

每个 skill 的字段含义统一为：

- **用途**：站在租户管理员的视角描述这个 skill 是做什么的
- **Description（agent 视角）**：直接写进 system prompt 给 LLM 看的描述。措辞会刻意提示适用场景和不适用场景，降低误调用率
- **Input / Output**：用 zod 风格的 TypeScript 类型描述。AgentFlow gateway 在调用前后都会做 schema 校验
- **调用限制**：速率限制和超时设置。所有限制都是按租户独立计算
- **授权要求**：哪些 skill 默认启用、哪些需要租户在控制台单独开通或配置凭据

所有内置 skill 的 ID 都不带前缀，租户自定义 skill 强制带 `skl_` 前缀，避免命名冲突。

---

## 类别 1：搜索与查询

### `search-web`

**用途**：通过 Brave 搜索引擎查询互联网上的实时信息。

**Description（agent 视角）**：通过 Brave 搜索引擎搜索互联网上的实时信息，适合查找新闻、当前事件、公司信息、产品评测等需要最新数据的问题。不适合查询用户自己的私有数据（如订单、账单），也不适合做数学计算或文本翻译。

**Input**：

```typescript
{
  query: string;                                    // 搜索关键词，建议 3-50 字
  count?: number;                                   // 返回结果数，默认 10，最大 20
  freshness?: 'pd' | 'pw' | 'pm' | 'py';            // pd=日 pw=周 pm=月 py=年
  country?: string;                                 // ISO 国家代码，默认按租户区域
}
```

**Output**：

```typescript
{
  results: Array<{
    title: string;
    url: string;
    description: string;                            // 搜索片段
    publishedAt?: string;                           // ISO 时间，部分结果有
  }>;
  totalCount: number;
}
```

**调用限制**：

- Rate limit: 10 req/min per tenant
- Timeout: 5000 ms
- 默认允许，无需特别授权

典型场景：客服 agent 在用户问到「最近 XX 行业新闻」「YY 公司是做什么的」时调用。注意要在 system prompt 中提醒 agent，搜索结果是第三方内容，要在回答时声明信息来源。

### `search-academic`

**用途**：通过 Semantic Scholar 搜索学术论文。

**Description（agent 视角）**：搜索学术论文、会议论文、综述等学术资源。返回论文标题、作者、摘要、引用数等。适合用户提出研究类、专业知识类问题时使用。不要用于普通新闻或商业信息查询。

**Input**：

```typescript
{
  query: string;
  yearFrom?: number;                                // 起始年份
  yearTo?: number;
  fieldsOfStudy?: Array<string>;                    // 如 ['Computer Science', 'Medicine']
  limit?: number;                                   // 默认 10，最大 50
}
```

**Output**：

```typescript
{
  papers: Array<{
    paperId: string;
    title: string;
    authors: Array<{ name: string }>;
    abstract: string;
    year: number;
    venue: string;
    citationCount: number;
    url: string;
  }>;
}
```

**调用限制**：

- Rate limit: 5 req/min per tenant
- Timeout: 8000 ms
- 默认允许

学术场景才会用到，企业客服类租户可以在配置里关掉以减少干扰。

### `search-news`

**用途**：按时间范围搜索新闻。

**Description（agent 视角）**：搜索近期新闻报道。和 search-web 的区别是：只返回新闻媒体来源，并强制限定时间范围。适合「最近一周关于 X 的新闻」这类问题。

**Input**：

```typescript
{
  query: string;
  from: string;                                     // ISO date，最早 90 天前
  to?: string;                                      // 默认为现在
  language?: 'zh' | 'en' | 'ja' | 'auto';
  sources?: Array<string>;                          // 限定来源域名
}
```

**Output**：

```typescript
{
  articles: Array<{
    title: string;
    url: string;
    source: string;
    publishedAt: string;
    snippet: string;
  }>;
  totalCount: number;
}
```

**调用限制**：

- Rate limit: 10 req/min per tenant
- Timeout: 5000 ms
- 默认允许

注意时间范围太大会被 gateway 自动截断到 90 天。

---

## 类别 2：数据获取

### `query-weather`

**用途**：查询全球城市的当前天气和未来 7 天预报。

**Description（agent 视角）**：查询某个城市的天气，可指定日期。返回温度、湿度、降水概率、天气状况描述。仅支持未来 7 天内和今天的查询。

**Input**：

```typescript
{
  city: string;                                     // 城市名（支持中英文）
  date?: string;                                    // ISO date，默认今天
  units?: 'metric' | 'imperial';                    // 默认 metric
}
```

**Output**：

```typescript
{
  city: string;
  date: string;
  condition: string;                                // 如 "多云"、"小雨"
  temperatureC: number;
  feelsLikeC: number;
  humidityPercent: number;
  precipitationProb: number;                        // 0-1
  windKmh: number;
  sunrise: string;
  sunset: string;
}
```

**调用限制**：

- Rate limit: 30 req/min per tenant
- Timeout: 3000 ms
- 默认允许

底层接 OpenWeatherMap，多语言城市名都会先用模糊匹配定位到准确的城市 ID。

### `query-stock`

**用途**：查询股票实时价格和基础财务指标。

**Description（agent 视角）**：查询指定股票的实时价格、涨跌幅、市值、市盈率。仅支持美股、港股、A 股主板上市公司。延迟约 15 分钟。

**Input**：

```typescript
{
  symbol: string;                                   // 如 'AAPL'、'00700.HK'、'600519.SS'
  fields?: Array<'price' | 'marketCap' | 'pe' | 'volume' | 'change'>;
}
```

**Output**：

```typescript
{
  symbol: string;
  name: string;
  price: number;
  currency: string;
  change: number;
  changePercent: number;
  marketCap?: number;
  pe?: number;
  volume?: number;
  asOf: string;                                     // 数据时间
}
```

**调用限制**：

- Rate limit: 20 req/min per tenant
- Timeout: 4000 ms
- 默认禁用，租户需在控制台启用并同意 15 分钟延迟声明

金融类租户用得较多。要在 system prompt 中明确告知 agent「数据非实时，不构成投资建议」。

### `query-currency`

**用途**：查询货币汇率。

**Description（agent 视角）**：查询两种货币之间的汇率，可指定历史日期。

**Input**：

```typescript
{
  from: string;                                     // ISO 4217 代码，如 'USD'
  to: string;
  date?: string;                                    // 默认今天，最早 5 年前
}
```

**Output**：

```typescript
{
  from: string;
  to: string;
  rate: number;
  date: string;
}
```

**调用限制**：

- Rate limit: 60 req/min per tenant
- Timeout: 2000 ms
- 默认允许

汇率数据来源欧洲央行 + 商业 API 兜底。

### `query-time`

**用途**：查询世界各时区当前时间。

**Description（agent 视角）**：返回指定时区的当前时间。当用户问「现在北京几点？」「纽约比这里晚几小时？」时调用。

**Input**：

```typescript
{
  timezone: string;                                 // IANA 时区，如 'Asia/Shanghai'
}
```

**Output**：

```typescript
{
  timezone: string;
  iso: string;
  unix: number;
  offsetMinutes: number;
}
```

**调用限制**：

- Rate limit: 120 req/min per tenant
- Timeout: 1000 ms
- 默认允许

完全本地实现（基于服务器时间 + tz 数据库），不走外部 API。

---

## 类别 3：内容生成

### `generate-image`

**用途**：调用图像生成模型创建图片。

**Description（agent 视角）**：根据文本描述生成图片。适合用户明确要求「画一张」「生成图片」时使用。生成的图片会保存到对象存储并返回 URL，有效期 24 小时。

**Input**：

```typescript
{
  prompt: string;                                   // 描述，建议英文效果更好
  model?: 'dalle-3' | 'sd-xl' | 'flux-pro';
  size?: '1024x1024' | '1792x1024' | '1024x1792';
  quality?: 'standard' | 'hd';
  count?: number;                                   // 1-4，默认 1
}
```

**Output**：

```typescript
{
  images: Array<{
    url: string;
    revisedPrompt?: string;                         // DALL-E 会改写 prompt
    width: number;
    height: number;
  }>;
  model: string;
  costUsd: number;
}
```

**调用限制**：

- Rate limit: 6 req/min per tenant
- Timeout: 60000 ms
- 默认禁用，租户需在控制台启用并接受按 token 计费

图片生成成本远高于文本，gateway 会单独统计配额。

### `summarize-url`

**用途**：抓取 URL 的网页内容并生成摘要。

**Description（agent 视角）**：访问指定 URL，抓取主要内容并生成摘要。适合用户分享一个链接让 AI「看看这个网页讲了什么」。不支持 PDF 链接，PDF 请用 ingest-document。

**Input**：

```typescript
{
  url: string;
  maxLength?: number;                               // 摘要字数上限，默认 500
  language?: string;                                // 输出语言，默认跟 url 内容语言
}
```

**Output**：

```typescript
{
  url: string;
  title: string;
  summary: string;
  language: string;
  wordCount: number;                                // 原文字数
  fetchedAt: string;
}
```

**调用限制**：

- Rate limit: 15 req/min per tenant
- Timeout: 15000 ms
- 默认允许

底层用 readability 算法提取正文后再喂给 LLM。对 SPA 网页支持有限。

### `translate-text`

**用途**：多语言翻译。

**Description（agent 视角）**：把文本从一种语言翻译成另一种语言。当用户明确要求翻译，或对话需要跨语言切换时调用。

**Input**：

```typescript
{
  text: string;                                     // 最长 5000 字
  to: string;                                       // 目标语言代码，如 'zh-CN'、'en'、'ja'
  from?: string;                                    // 源语言，留空自动识别
  formality?: 'default' | 'formal' | 'informal';
}
```

**Output**：

```typescript
{
  translatedText: string;
  detectedLanguage?: string;                        // 自动检测时返回
}
```

**调用限制**：

- Rate limit: 30 req/min per tenant
- Timeout: 4000 ms
- 默认允许

DeepL + Google Translate 双源，按租户区域路由。

---

## 类别 4：通信与协作

通信类 skill 默认全部禁用，租户必须在控制台显式开通并配置凭据，因为它们会产生对外可见的副作用。

### `send-email`

**用途**：通过租户配置的 SMTP 发送邮件。

**Description（agent 视角）**：发送电子邮件。仅当用户明确要求「发邮件」「邮件通知我」时调用。绝不要在用户没有要求的情况下主动发邮件。发件人地址由租户配置，无法动态指定。

**Input**：

```typescript
{
  to: Array<string>;                                // 收件人列表
  cc?: Array<string>;
  bcc?: Array<string>;
  subject: string;
  body: string;                                     // 支持 HTML 或纯文本
  bodyType?: 'text' | 'html';
  attachments?: Array<{ filename: string; contentUrl: string }>;
}
```

**Output**：

```typescript
{
  messageId: string;
  sentAt: string;
  accepted: Array<string>;
  rejected: Array<string>;
}
```

**调用限制**：

- Rate limit: 6 req/min per tenant
- Timeout: 10000 ms
- 需要租户在控制台配置 SMTP 凭据；默认禁用

为防滥用，gateway 会做收件人域名白名单校验（租户可关闭）。

### `send-sms`

**用途**：发送短信。

**Description（agent 视角）**：发送短信通知。仅用于必要的告警、验证码、确认场景。不要发营销内容。

**Input**：

```typescript
{
  phoneNumber: string;                              // E.164 格式
  message: string;                                  // 最长 70 字（中文）/ 160 字（英文）
  templateId?: string;                              // 使用模板（合规要求）
}
```

**Output**：

```typescript
{
  messageId: string;
  cost: number;
  segments: number;
}
```

**调用限制**：

- Rate limit: 3 req/min per tenant
- Timeout: 8000 ms
- 需要租户配置短信服务商凭据（阿里云、Twilio）；默认禁用

发送中国大陆号码必须使用预审批模板，gateway 会强制校验 `templateId`。

### `post-slack`

**用途**：向 Slack channel 发消息。

**Description（agent 视角）**：在 Slack channel 中发送消息。适用于团队协作场景，比如把 AI 整理出来的信息同步到工作群。

**Input**：

```typescript
{
  channel: string;                                  // channel ID 或名称
  text: string;
  blocks?: Array<unknown>;                          // Block Kit 富文本
  threadTs?: string;                                // 回复到 thread
}
```

**Output**：

```typescript
{
  channel: string;
  ts: string;                                       // 消息时间戳，可用于后续编辑
  permalink: string;
}
```

**调用限制**：

- Rate limit: 30 req/min per tenant
- Timeout: 5000 ms
- 需要租户在控制台完成 Slack OAuth 授权；默认禁用

### `create-calendar-event`

**用途**：创建日历事件。

**Description（agent 视角）**：在用户的日历中创建事件。当用户说「帮我约 X」「在日历加一个 Y」时调用。

**Input**：

```typescript
{
  title: string;
  startTime: string;                                // ISO 8601
  endTime: string;
  timezone?: string;                                // 默认 UTC
  attendees?: Array<string>;                        // 邮箱列表
  description?: string;
  location?: string;
  reminders?: Array<number>;                        // 提前分钟数
}
```

**Output**：

```typescript
{
  eventId: string;
  htmlLink: string;
  createdAt: string;
}
```

**调用限制**：

- Rate limit: 10 req/min per tenant
- Timeout: 6000 ms
- 需要 Google Calendar / Outlook / 飞书日历 OAuth；默认禁用

按用户授权时选择的日历服务自动路由。

---

## 类别 5：数据处理

这一类 skill 都是「纯函数」，不涉及外部 IO，性能高、可靠性强。常用于把上游 skill 的结果做进一步加工。

### `parse-json`

**用途**：解析 JSON 字符串并按 JSONPath 提取字段。

**Description（agent 视角）**：解析 JSON 字符串。可指定 JSONPath 表达式提取特定字段。当用户给一段 JSON 让你帮他找某个值时使用。

**Input**：

```typescript
{
  json: string;
  path?: string;                                    // 如 '$.data.items[0].name'
}
```

**Output**：

```typescript
{
  parsed: unknown;
  extracted?: unknown;                              // 如果指定了 path
}
```

**调用限制**：

- Rate limit: 300 req/min per tenant
- Timeout: 500 ms
- 默认允许

### `extract-from-html`

**用途**：从 HTML 中按 CSS 选择器提取内容。

**Description（agent 视角）**：从 HTML 字符串中按 CSS 选择器或 XPath 提取内容。常配合 summarize-url 使用，先抓页面再精确提取。

**Input**：

```typescript
{
  html: string;
  selector: string;
  attribute?: string;                               // 不传则返回 textContent
  all?: boolean;                                    // 是否返回所有匹配
}
```

**Output**：

```typescript
{
  matches: Array<string>;
  count: number;
}
```

**调用限制**：

- Rate limit: 120 req/min per tenant
- Timeout: 2000 ms
- 默认允许

### `convert-currency`

**用途**：按当前汇率换算金额。

**Description（agent 视角）**：把一个金额从一种货币换算成另一种货币。和 query-currency 的区别是：这个是直接换算具体金额，前者只返回汇率数字。

**Input**：

```typescript
{
  amount: number;
  from: string;
  to: string;
  date?: string;                                    // 历史汇率，默认今天
}
```

**Output**：

```typescript
{
  amount: number;
  converted: number;
  rate: number;
  from: string;
  to: string;
  date: string;
}
```

**调用限制**：

- Rate limit: 60 req/min per tenant
- Timeout: 2000 ms
- 默认允许

内部复用 query-currency 的汇率缓存。

### `format-date`

**用途**：日期格式化、解析、时区转换。

**Description（agent 视角）**：处理日期：格式化、解析自然语言（如「下周三」）、时区转换。

**Input**：

```typescript
{
  input: string;                                    // ISO 字符串或自然语言
  operation: 'format' | 'parse' | 'convert';
  format?: string;                                  // 如 'YYYY-MM-DD HH:mm'
  fromTimezone?: string;
  toTimezone?: string;
}
```

**Output**：

```typescript
{
  result: string;
  iso: string;
  unix: number;
}
```

**调用限制**：

- Rate limit: 300 req/min per tenant
- Timeout: 500 ms
- 默认允许

自然语言解析支持中、英、日。

---

## 类别 6：知识库操作

与第 6 章的知识库引擎深度集成。两个 skill 都默认启用，但只有当租户在配置中绑定了至少一个 `default_kb_ids` 时才会真正生效。

### `search-knowledge`

**用途**：在租户绑定的知识库中检索相关片段。

**Description（agent 视角）**：在公司内部知识库中搜索。适合回答关于本公司产品、政策、操作手册的问题。优先使用这个 skill 而不是 search-web，因为内部数据比公网信息更准确。如果搜不到结果再考虑 search-web。

**Input**：

```typescript
{
  query: string;
  kbIds?: Array<string>;                            // 不传则用租户默认知识库
  topK?: number;                                    // 默认 5，最大 20
  filter?: Record<string, string>;                  // 按文档 metadata 过滤
  rerank?: boolean;                                 // 是否启用 rerank，默认 true
}
```

**Output**：

```typescript
{
  results: Array<{
    chunkId: string;
    documentId: string;
    documentTitle: string;
    score: number;
    content: string;
    metadata: Record<string, unknown>;
    citationUrl?: string;
  }>;
  searchedKbs: Array<string>;
}
```

**调用限制**：

- Rate limit: 60 req/min per tenant
- Timeout: 5000 ms
- 默认允许（需先配置知识库）

`citationUrl` 字段方便 agent 在回答时附引用，建议 system prompt 强制要求引用来源。

### `summarize-knowledge`

**用途**：在知识库中检索后直接生成摘要回答。

**Description（agent 视角）**：在公司知识库中搜索并直接基于命中片段生成摘要回答。比 search-knowledge 更进一步，省去 agent 自己阅读片段的步骤。适合用户问简单事实性问题。复杂问题或需要 agent 自己推理时仍用 search-knowledge。

**Input**：

```typescript
{
  question: string;
  kbIds?: Array<string>;
  topK?: number;                                    // 默认 8
  maxLength?: number;                               // 摘要字数上限，默认 300
  citationStyle?: 'inline' | 'footnote' | 'none';
}
```

**Output**：

```typescript
{
  answer: string;
  citations: Array<{
    documentId: string;
    documentTitle: string;
    chunkContent: string;
    citationUrl?: string;
  }>;
  confidence: 'high' | 'medium' | 'low';
}
```

**调用限制**：

- Rate limit: 30 req/min per tenant
- Timeout: 15000 ms
- 默认允许（需先配置知识库）

内部走一次 LLM 调用，会计入租户的 token 配额。`confidence` 基于检索得分阈值给出，agent 看到 `low` 时应当谨慎回答或建议人工接入。

---

## 关于 skill 选用的几条经验

总结一下在真实租户上线过程中沉淀的经验：

第一，**少即是多**。不要给 agent 配置二十多个 skill，LLM 在 skill 过多时选择准确率明显下降。一个客服 agent 5-8 个 skill 通常够用。先用最少的 skill 跑通主流程，再按需添加。

第二，**Description 措辞决定调用准确率**。一个 skill 描述写得好，调用准确率能从 70% 提升到 95%。诀窍是明确写出「适合做什么」和「不适合做什么」，并给出几个典型 query 例子。本附录的描述都按这个原则写。

第三，**通信类 skill 谨慎放权**。`send-email`、`send-sms`、`post-slack` 一旦被 prompt injection 滥用，后果是 agent 替租户给客户群发邮件。除了默认禁用，建议在租户控制台增加二次确认开关。

第四，**知识库类 skill 一定要求引用**。`search-knowledge` 和 `summarize-knowledge` 返回的内容会被 agent 当作事实复述给用户。如果不强制 agent 附上引用，租户在合规审计时会很被动。在 system prompt 里写一句「使用知识库内容时必须在句末加引用链接」是廉价但有效的做法。
