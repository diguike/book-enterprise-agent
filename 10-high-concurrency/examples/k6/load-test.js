// AgentFlow k6 压测脚本
//
// 运行：
//   k6 run k6/load-test.js
//   k6 run -e SCENARIO=fault-inject k6/load-test.js
//
// 默认场景：阶梯式爬坡到 500 vus 持续 1 分钟，验证常规吞吐 + p95 延迟
// fault-inject 场景：固定 200 vus，但 30% 请求带 simulate=429 头，
//   后端按头返回 LLM 429，用来验证 Circuit Breaker + fallback

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate } from 'k6/metrics';

// 业务自定义指标：限流命中率、断路器降级率
const rateLimited = new Rate('rate_limited_429');
const fallbackHit = new Rate('fallback_responses');

const SCENARIO = __ENV.SCENARIO || 'baseline';
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// k6 的 stages 配置：每段 (duration, target) 控制并发
const scenarios = {
  baseline: {
    stages: [
      { duration: '30s', target: 100 },
      { duration: '1m', target: 500 },
      { duration: '30s', target: 0 },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500'],
      http_req_failed: ['rate<0.01'],
    },
  },
  'fault-inject': {
    stages: [
      { duration: '30s', target: 200 },
      { duration: '2m', target: 200 },
      { duration: '20s', target: 0 },
    ],
    thresholds: {
      // 故障注入场景允许较高失败率，但要求降级响应占比足够
      http_req_duration: ['p(95)<2000'],
      fallback_responses: ['rate>0.1'],
    },
  },
  spike: {
    // 峰值冲击：模拟双十一开抢瞬间
    stages: [
      { duration: '10s', target: 50 },
      { duration: '5s', target: 2000 }, // 瞬间拉到 2000
      { duration: '30s', target: 2000 },
      { duration: '10s', target: 0 },
    ],
    thresholds: {
      // 峰值场景重点不是延迟，是系统不雪崩
      http_req_failed: ['rate<0.5'],
      rate_limited_429: ['rate>0.3'], // 限流必须真的挡住请求
    },
  },
};

export const options = scenarios[SCENARIO];

// 三类租户对应不同流量画像
const tenants = [
  { id: 'tenant-a', weight: 0.7 }, // 电商，70% 流量
  { id: 'tenant-b', weight: 0.2 }, // SaaS，20%
  { id: 'tenant-c', weight: 0.1 }, // 金融，10%
];

function pickTenant() {
  const r = Math.random();
  let acc = 0;
  for (const t of tenants) {
    acc += t.weight;
    if (r < acc) return t.id;
  }
  return tenants[0].id;
}

export default function () {
  const tenantId = pickTenant();
  const payload = JSON.stringify({
    tenantId,
    sessionId: `s-${tenantId}-${__VU}-${__ITER}`,
    message: '查询订单 #' + Math.floor(Math.random() * 100000) + ' 状态',
  });

  const headers = { 'Content-Type': 'application/json' };
  // 故障注入场景：30% 请求要求后端模拟 LLM 429
  if (SCENARIO === 'fault-inject' && Math.random() < 0.3) {
    headers['X-Simulate-Failure'] = 'llm-429';
  }

  group('POST /chat', () => {
    const res = http.post(`${BASE_URL}/chat`, payload, { headers });

    // 统计 429
    rateLimited.add(res.status === 429);

    // 统计降级响应（业务约定：body.reply 包含"降级"两字）
    let isFallback = false;
    try {
      const j = res.json();
      isFallback = typeof j.reply === 'string' && j.reply.includes('降级');
    } catch (_e) {
      // 非 JSON 响应忽略
    }
    fallbackHit.add(isFallback);

    check(res, {
      'status 200 或受控失败': (r) => r.status === 200 || r.status === 429 || r.status === 504,
      '响应时间 < 3s': (r) => r.timings.duration < 3000,
    });
  });

  // 留一点思考时间，避免 VU 全部死循环打
  sleep(Math.random() * 0.5 + 0.1);
}

// k6 默认每轮结束输出 summary。如需自定义可实现 handleSummary。
