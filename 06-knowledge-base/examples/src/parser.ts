/**
 * 文档解析模块
 * 支持 PDF、DOCX、Markdown、纯文本四种格式
 * PDF 解析使用 Mock 实现演示逻辑，实际生产需要安装 pdf-parse 和 llamaindex
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { DocumentFileType } from './types.js';

// ─────────────────────────────────────────────
// 解析结果类型
// ─────────────────────────────────────────────

export interface ParseResult {
  /** 提取出的纯文本内容 */
  text: string;
  /** 文档总页数（仅 PDF 有效，其他格式为 null） */
  pageCount: number | null;
  /** 解析器名称，便于调试和日志 */
  parser: string;
}

// ─────────────────────────────────────────────
// 格式检测
// ─────────────────────────────────────────────

/**
 * 根据文件扩展名检测文档类型
 * 不依赖 MIME type，避免客户端上传时 Content-Type 不准确的问题
 */
export function detectFileType(filePath: string): DocumentFileType {
  const ext = path.extname(filePath).toLowerCase();
  const typeMap: Record<string, DocumentFileType> = {
    '.pdf': 'pdf',
    '.docx': 'docx',
    '.doc': 'docx',   // 旧版 Word，mammoth 也能处理
    '.md': 'md',
    '.markdown': 'md',
    '.txt': 'txt',
  };
  const detected = typeMap[ext];
  if (!detected) {
    throw new Error(`不支持的文件格式: ${ext}，支持格式: pdf, docx, md, txt`);
  }
  return detected;
}

// ─────────────────────────────────────────────
// 各格式解析器
// ─────────────────────────────────────────────

/**
 * 解析 Markdown 文件
 * 直接读取文本，保留 Markdown 标记供后续 markdownChunk 使用
 */
async function parseMarkdown(filePath: string): Promise<ParseResult> {
  const text = await fs.readFile(filePath, 'utf-8');
  return {
    text,
    pageCount: null,
    parser: 'fs.readFile',
  };
}

/**
 * 解析纯文本文件
 */
async function parsePlainText(filePath: string): Promise<ParseResult> {
  const text = await fs.readFile(filePath, 'utf-8');
  return {
    text,
    pageCount: null,
    parser: 'fs.readFile',
  };
}

/**
 * 解析 PDF 文件
 *
 * 生产实现使用 pdf-parse：
 *   import pdfParse from 'pdf-parse';
 *   const buffer = await fs.readFile(filePath);
 *   const data = await pdfParse(buffer);
 *   return { text: data.text, pageCount: data.numpages, parser: 'pdf-parse' };
 *
 * 已知限制：
 * 1. 扫描版 PDF（图片型）：pdf-parse 无法提取文字，返回空字符串
 *    处理方案：检测 data.text.trim() 为空时，返回错误提示用户转换格式
 * 2. 表格：提取质量差，行列顺序可能乱序
 *    建议：表格内容改用 Markdown 格式上传
 *
 * 本示例使用 Mock 数据演示流程
 */
async function parsePDF(filePath: string): Promise<ParseResult> {
  // 检查文件是否存在
  try {
    await fs.access(filePath);
  } catch {
    // 演示模式：文件不存在时返回 Mock 内容
    console.log(`[Parser] PDF 文件不存在，使用 Mock 数据: ${filePath}`);
    return {
      text: getMockPDFContent(),
      pageCount: 3,
      parser: 'mock',
    };
  }

  // 实际生产代码（需安装 pdf-parse）：
  // const pdfParse = (await import('pdf-parse')).default;
  // const buffer = await fs.readFile(filePath);
  // const data = await pdfParse(buffer);
  //
  // if (data.text.trim().length === 0) {
  //   throw new Error('PDF 文件为扫描版（图片型），无法直接提取文字。请先用 OCR 工具处理后再上传。');
  // }
  //
  // return { text: data.text, pageCount: data.numpages, parser: 'pdf-parse' };

  // 演示模式：文件存在时也使用 Mock（避免 pdf-parse 依赖）
  return {
    text: getMockPDFContent(),
    pageCount: 3,
    parser: 'mock',
  };
}

/**
 * 解析 Word/DOCX 文件
 * 使用 mammoth 将 DOCX 转换为 Markdown 格式
 * 转换后的 Markdown 可以直接用 markdownChunk 按标题分块
 *
 * 已知限制：
 * - 复杂排版（多列布局、文本框、自定义样式）转换质量较差
 * - result.messages 里会有警告，不是错误，记录日志即可
 */
async function parseDocx(filePath: string): Promise<ParseResult> {
  try {
    await fs.access(filePath);
  } catch {
    // 演示模式
    console.log(`[Parser] DOCX 文件不存在，使用 Mock 数据: ${filePath}`);
    return {
      text: getMockDocxContent(),
      pageCount: null,
      parser: 'mock',
    };
  }

  // 实际生产代码（需安装 mammoth）：
  // const mammoth = (await import('mammoth')).default;
  // const result = await mammoth.convertToMarkdown({ path: filePath });
  //
  // if (result.messages.length > 0) {
  //   // 记录转换警告，不中断处理
  //   console.warn('[Parser] DOCX 转换警告:', result.messages.map(m => m.message));
  // }
  //
  // return { text: result.value, pageCount: null, parser: 'mammoth' };

  return {
    text: getMockDocxContent(),
    pageCount: null,
    parser: 'mock',
  };
}

// ─────────────────────────────────────────────
// 统一入口
// ─────────────────────────────────────────────

/**
 * 解析文档，提取纯文本
 * 根据文件类型自动选择对应的解析器
 */
export async function parseDocument(
  filePath: string,
  fileType?: DocumentFileType
): Promise<ParseResult> {
  const type = fileType ?? detectFileType(filePath);

  const startAt = Date.now();
  let result: ParseResult;

  switch (type) {
    case 'md':
      result = await parseMarkdown(filePath);
      break;
    case 'txt':
      result = await parsePlainText(filePath);
      break;
    case 'pdf':
      result = await parsePDF(filePath);
      break;
    case 'docx':
      result = await parseDocx(filePath);
      break;
    default: {
      // TypeScript 确保这个分支不可达，但保留作为运行时保障
      const exhaustive: never = type;
      throw new Error(`未知文件类型: ${exhaustive}`);
    }
  }

  const durationMs = Date.now() - startAt;
  console.log(
    `[Parser] 解析完成 | 格式: ${type} | 字符数: ${result.text.length} | 耗时: ${durationMs}ms | 解析器: ${result.parser}`
  );

  return result;
}

// ─────────────────────────────────────────────
// Mock 数据（演示用）
// ─────────────────────────────────────────────

function getMockPDFContent(): string {
  return `双十一活动条款

第一条 活动时间
本次双十一活动时间为 2024 年 11 月 1 日 00:00:00 至 2024 年 11 月 11 日 23:59:59。

第二条 活动商品范围
参与本次活动的商品以活动页面展示为准。部分特殊商品（如定制商品、生鲜商品、虚拟商品）不参与活动。

第三条 优惠规则
3.1 满减优惠：每满 300 元减 50 元，可叠加使用，上限 3 次。
3.2 优惠券：用户领取的优惠券须在有效期内使用，过期作废。
3.3 优惠不与其他促销活动叠加使用，以实际结算页面为准。

第四条 下单规则
4.1 同一用户同一商品限购 5 件。
4.2 活动期间下单后 24 小时内支付方可享受活动价格。

第五条 发货规则
5.1 活动期间订单将在 72 小时内发出（大件商品除外）。
5.2 遇节假日或不可抗力因素，发货时间将适当延长。

第六条 物流说明
6.1 本次活动默认使用顺丰/圆通/韵达快递。
6.2 偏远地区（新疆、西藏、内蒙古等）运费另计。

第七条 退换货政策
7.1 活动期间购买的商品支持 7 天无理由退货（以下商品除外）：
    - 拆封后影响二次销售的商品（如食品、化妆品）
    - 定制商品
    - 数字商品（下载码、会员卡等）
7.2 退货需保持商品完好，包装齐全，附原始发票。
7.3 退款将在收到退货后 3 个工作日内退回原支付渠道。
7.4 因商品质量问题引起的退换货，运费由平台承担。

第八条 争议解决
本活动最终解释权归本平台所有。如有争议，双方协商解决；协商不成，提交平台所在地人民法院诉讼解决。`;
}

function getMockDocxContent(): string {
  return `# 产品使用手册 v2.1

## 快速开始

安装本产品前，请确认系统满足以下要求：
- 操作系统：Windows 10 / macOS 12 / Ubuntu 20.04 及以上版本
- 内存：至少 4GB RAM
- 存储：至少 2GB 可用空间

## 账号注册

1. 访问官网 https://example.com/register
2. 填写邮箱地址和密码
3. 验证邮箱
4. 完善个人信息

## 基本功能

### 文件管理
支持上传、下载、分享文件。单个文件大小上限为 100MB，总存储空间 10GB。

### 协作功能
邀请团队成员共同编辑文件。编辑权限分为查看、评论、编辑三个级别。

## 常见问题

**Q: 忘记密码怎么办？**
点击登录页面的"忘记密码"链接，输入注册邮箱，系统将发送重置密码邮件。

**Q: 如何升级套餐？**
在账号设置 > 套餐管理页面选择目标套餐，完成支付后立即生效。`;
}
