/**
 * OTel SDK 初始化
 *
 * 关键约定：本文件必须在所有业务模块加载之前 import。
 * OTel 通过 monkey-patch 给各种库打补丁，业务代码已经 require 完了再启动 OTel 就来不及了。
 *
 * 使用方式（package.json 已经配好）：
 *   tsx --import ./src/otel-init.ts src/index.ts
 *
 * 或在入口文件第一行手动 import：
 *   import './otel-init';
 */

import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'agentflow-api';
const SERVICE_VERSION = process.env.SERVICE_VERSION ?? 'dev';
const ENVIRONMENT = process.env.NODE_ENV ?? 'development';

// Jaeger / Tempo / OTel Collector 的 OTLP HTTP 端点
const JAEGER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces';

// Langfuse 也接受 OTLP，端点是 /api/public/otel/v1/traces
const LANGFUSE_OTLP_ENDPOINT =
  process.env.LANGFUSE_OTLP_ENDPOINT ?? 'http://localhost:3000/api/public/otel/v1/traces';

// 构造 Langfuse 的 Basic Auth header（PUBLIC_KEY:SECRET_KEY 的 base64）
function buildLangfuseAuthHeader(): Record<string, string> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    // 缺失 key 时不向 Langfuse 发送，避免本地 demo 时报错
    return {};
  }
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  return { Authorization: `Basic ${auth}` };
}

const jaegerExporter = new OTLPTraceExporter({
  url: JAEGER_OTLP_ENDPOINT,
});

const langfuseAuthHeader = buildLangfuseAuthHeader();
const langfuseEnabled = Object.keys(langfuseAuthHeader).length > 0;

// 用 sdk-node 自带的 tracing 命名空间，避免与外部 sdk-trace-base 版本冲突
const spanProcessors: tracing.SpanProcessor[] = [
  new tracing.BatchSpanProcessor(jaegerExporter),
];

if (langfuseEnabled) {
  const langfuseExporter = new OTLPTraceExporter({
    url: LANGFUSE_OTLP_ENDPOINT,
    headers: langfuseAuthHeader,
  });
  spanProcessors.push(new tracing.BatchSpanProcessor(langfuseExporter));
}

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    'deployment.environment': ENVIRONMENT,
  }),
  spanProcessors,
  instrumentations: [
    getNodeAutoInstrumentations({
      // 关闭一些噪声大的 instrumentation
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
});

sdk.start();

// eslint-disable-next-line no-console
console.log(
  `[otel] 已启动 service=${SERVICE_NAME} env=${ENVIRONMENT} langfuse=${langfuseEnabled ? 'on' : 'off'}`,
);

// 进程退出时优雅关闭，确保 batch 队列里的 span 全部发出去
async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[otel] 收到 ${signal}，开始 shutdown`);
  try {
    await sdk.shutdown();
    // eslint-disable-next-line no-console
    console.log('[otel] shutdown 完成');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[otel] shutdown 失败', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { sdk };
