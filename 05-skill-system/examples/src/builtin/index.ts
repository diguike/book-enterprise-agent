/**
 * 内置 Skill 示例
 *
 * 平台提供的通用 Skill，覆盖大多数客服场景。
 * 这里实现 3 个示例：网页搜索、天气查询、发邮件。
 * 真实的 API 调用用 stub 代替，聚焦接口设计。
 */

import { z } from 'zod';
import type { BuiltinSkill, SkillContext } from '../types.js';

// ─── search-web ──────────────────────────────────────────────────

const searchWebInputSchema = z.object({
  query: z.string().min(1).max(500).describe('搜索关键词或问题'),
  maxResults: z.number().int().min(1).max(10).default(5).describe('返回结果数量'),
});

const searchWebOutputSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string().url(),
      snippet: z.string(),
    })
  ),
});

/**
 * 网页搜索 Skill（基于 Brave Search API）
 *
 * description 写法示范：
 * - 说明数据来源（Brave Search）
 * - 明确适用场景（实时信息、公开信息）
 * - 明确不适用场景（用户私有数据）
 * - 标注数据时效性（可能有延迟）
 */
export const searchWebSkill: BuiltinSkill = {
  id: 'search-web',
  name: '网页搜索',
  description: `通过 Brave Search 搜索互联网上的公开信息。
适用：查询新闻事件、公司公开信息、产品评测、技术文档、当前热点话题。
不适用：查询用户自己的数据（订单、账单、个人信息）——这类数据用专用的数据查询工具。
不适用：检索企业内部知识库——使用 search-knowledge-base 工具。
返回结果包含页面摘要和来源 URL，搜索结果可能有数小时延迟，不适合需要秒级实时数据的场景。`,
  category: 'search',
  inputSchema: searchWebInputSchema,
  outputSchema: searchWebOutputSchema,
  async execute(input, _context: SkillContext) {
    const { query, maxResults } = searchWebInputSchema.parse(input);

    // 生产中调用 Brave Search API
    // const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
    //   headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY! },
    // });

    // Stub：返回模拟数据，用于示例
    console.log(`[search-web] 搜索: "${query}", 最多返回 ${maxResults} 条`);
    return {
      results: [
        {
          title: `关于"${query}"的搜索结果 1`,
          url: 'https://example.com/result1',
          snippet: `这是关于 ${query} 的摘要内容，包含主要信息点...`,
        },
        {
          title: `关于"${query}"的搜索结果 2`,
          url: 'https://example.com/result2',
          snippet: `${query} 的另一个相关页面摘要...`,
        },
      ].slice(0, maxResults),
    };
  },
  rateLimit: { rpm: 100 }, // Brave Free Plan 限制
  timeout: 10000,          // 10 秒超时
  isCacheable: true,
  cacheTtl: 3600,          // 搜索结果缓存 1 小时
};

// ─── query-weather ───────────────────────────────────────────────

const queryWeatherInputSchema = z.object({
  city: z.string().describe('城市名，支持中文（"北京"）或英文（"Beijing"）'),
  days: z.number().int().min(1).max(7).default(1).describe('预报天数（1=今天，最多7天）'),
});

const queryWeatherOutputSchema = z.object({
  city: z.string(),
  current: z.object({
    temperature: z.number().describe('当前温度（摄氏度）'),
    feelsLike: z.number(),
    humidity: z.number().describe('湿度（百分比）'),
    description: z.string().describe('天气描述'),
    windSpeed: z.number().describe('风速（km/h）'),
  }),
  forecast: z
    .array(
      z.object({
        date: z.string(),
        high: z.number(),
        low: z.number(),
        description: z.string(),
        rainProbability: z.number().describe('降雨概率（0-100）'),
      })
    )
    .optional(),
});

/**
 * 天气查询 Skill（基于 OpenWeather API）
 */
export const queryWeatherSkill: BuiltinSkill = {
  id: 'query-weather',
  name: '查询天气',
  description: `查询指定城市的实时天气和未来 7 天预报。
适用：用户询问某地当前天气、温度、降雨概率、未来天气趋势、是否适合户外活动。
不适用：历史天气查询（只保留最近 30 天数据）、室内环境监测（需要 IoT 传感器）。
输入城市名支持中文（"北京"）或英文（"Beijing"），不支持模糊地名（"华北地区"）。
数据来源 OpenWeather，更新频率 10 分钟。`,
  category: 'data',
  inputSchema: queryWeatherInputSchema,
  outputSchema: queryWeatherOutputSchema,
  async execute(input, _context: SkillContext) {
    const { city, days } = queryWeatherInputSchema.parse(input);

    // 生产中调用 OpenWeather API
    // const apiKey = process.env.OPENWEATHER_API_KEY;
    // const response = await fetch(
    //   `https://api.openweathermap.org/data/2.5/forecast?q=${city}&appid=${apiKey}&units=metric&lang=zh_cn`
    // );

    // Stub：返回模拟天气数据
    console.log(`[query-weather] 查询城市: ${city}，预报 ${days} 天`);
    return {
      city,
      current: {
        temperature: 22,
        feelsLike: 24,
        humidity: 65,
        description: '多云',
        windSpeed: 12,
      },
      forecast:
        days > 1
          ? Array.from({ length: days - 1 }, (_, i) => ({
              date: new Date(Date.now() + (i + 1) * 86400000).toISOString().slice(0, 10),
              high: 25 + Math.round(Math.random() * 4 - 2),
              low: 18 + Math.round(Math.random() * 4 - 2),
              description: ['晴', '多云', '小雨'][Math.floor(Math.random() * 3)],
              rainProbability: Math.round(Math.random() * 40),
            }))
          : undefined,
    };
  },
  timeout: 8000,
  isCacheable: true,
  cacheTtl: 1800, // 天气缓存 30 分钟
};

// ─── send-email ──────────────────────────────────────────────────

const sendEmailInputSchema = z.object({
  to: z.array(z.string().email()).min(1).max(10).describe('收件人邮箱列表'),
  subject: z.string().min(1).max(200).describe('邮件主题'),
  body: z.string().min(1).max(10000).describe('邮件正文（支持 HTML）'),
  cc: z.array(z.string().email()).optional().describe('抄送列表'),
});

const sendEmailOutputSchema = z.object({
  messageId: z.string().describe('邮件消息 ID，用于追踪'),
  accepted: z.array(z.string()).describe('接受投递的收件人'),
  rejected: z.array(z.string()).describe('拒绝投递的收件人（如地址无效）'),
});

/**
 * 发邮件 Skill（基于 SMTP）
 *
 * 发邮件是写操作，不可缓存，且需要防止重复发送。
 * 生产中应结合幂等 key 避免因重试导致的重复邮件。
 */
export const sendEmailSkill: BuiltinSkill = {
  id: 'send-email',
  name: '发送邮件',
  description: `通过平台 SMTP 服务发送邮件给指定收件人。
适用：向用户发送通知邮件、确认邮件、报告邮件。
不适用：发送营销/推广邮件（需走专门的营销邮件渠道，本工具用于事务性邮件）。
不适用：一次发送超过 10 个收件人（批量邮件用 batch-email 工具）。
邮件从 AgentFlow 平台域名发出，发件人显示为 noreply@agentflow.ai。
发送后不可撤回，调用前请确认收件人和内容正确。`,
  category: 'communication',
  inputSchema: sendEmailInputSchema,
  outputSchema: sendEmailOutputSchema,
  async execute(input, context: SkillContext) {
    const { to, subject, body, cc } = sendEmailInputSchema.parse(input);

    // 生产中使用 nodemailer 或 Resend API
    // const transporter = nodemailer.createTransporter({ ... });
    // await transporter.sendMail({ from, to, subject, html: body });

    // Stub：模拟发送成功
    console.log(
      `[send-email] 租户 ${context.tenantId} 发送邮件`,
      `收件人: ${to.join(', ')}, 主题: ${subject}`,
      cc ? `抄送: ${cc.join(', ')}` : ''
    );

    return {
      messageId: `<${Date.now()}.${Math.random().toString(36).slice(2)}@agentflow.ai>`,
      accepted: to,
      rejected: [],
    };
  },
  timeout: 15000, // 邮件发送给更多时间，SMTP 可能有延迟
  isCacheable: false, // 发邮件是写操作，不可缓存
};

/** 所有内置 Skill 的注册列表 */
export const builtinSkills: BuiltinSkill[] = [
  searchWebSkill,
  queryWeatherSkill,
  sendEmailSkill,
];
