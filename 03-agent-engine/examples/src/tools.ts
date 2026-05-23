/**
 * 电商客服工具集
 * 包含三个核心工具：查订单、查物流、发起退款
 * 本文件使用 Mock 数据，生产环境替换为真实 API 调用
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ===== 类型定义 =====

interface OrderItem {
  name: string;
  qty: number;
  price: number;
}

interface ShippingAddress {
  name: string;
  phone: string; // 脱敏格式，如 138****8888
  address: string;
}

interface Order {
  orderId: string;
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  statusLabel: string;
  amount: number;
  items: OrderItem[];
  createdAt: string;
  paidAt: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  shippingAddress: ShippingAddress;
}

interface ShippingEvent {
  time: string;
  location: string;
  event: string;
}

interface ShippingInfo {
  trackingNumber: string;
  status: 'pending' | 'in_transit' | 'delivered' | 'exception';
  statusLabel: string;
  estimatedDelivery: string;
  currentLocation: string;
  timeline: ShippingEvent[];
}

// ===== Mock 数据 =====

// Mock 订单数据库
const MOCK_ORDERS: Record<string, Order> = {
  '12345': {
    orderId: '12345',
    status: 'shipped',
    statusLabel: '已发货',
    amount: 299.0,
    items: [{ name: '无线耳机 Pro', qty: 1, price: 299.0 }],
    createdAt: '2024-03-10T14:30:00Z',
    paidAt: '2024-03-10T14:31:00Z',
    carrier: 'SF Express',
    trackingNumber: 'SF7890123456',
    shippingAddress: {
      name: '张三',
      phone: '138****8888',
      address: '北京市朝阳区某某街道 18 号',
    },
  },
  '67890': {
    orderId: '67890',
    status: 'processing',
    statusLabel: '备货中',
    amount: 1299.0,
    items: [{ name: '机械键盘 TKL', qty: 1, price: 1299.0 }],
    createdAt: '2024-03-12T09:00:00Z',
    paidAt: '2024-03-12T09:01:00Z',
    carrier: null,
    trackingNumber: null,
    shippingAddress: {
      name: '李四',
      phone: '139****9999',
      address: '上海市浦东新区某某路 88 号',
    },
  },
  '11111': {
    orderId: '11111',
    status: 'delivered',
    statusLabel: '已签收',
    amount: 599.0,
    items: [{ name: '智能手表', qty: 1, price: 599.0 }],
    createdAt: '2024-03-05T10:00:00Z',
    paidAt: '2024-03-05T10:02:00Z',
    carrier: 'JD Express',
    trackingNumber: 'JD123456789',
    shippingAddress: {
      name: '王五',
      phone: '135****5555',
      address: '广州市天河区某某大道 100 号',
    },
  },
};

// Mock 物流数据库
const MOCK_SHIPPING: Record<string, ShippingInfo> = {
  SF7890123456: {
    trackingNumber: 'SF7890123456',
    status: 'in_transit',
    statusLabel: '运输中',
    estimatedDelivery: '2024-03-13',
    currentLocation: '北京转运中心',
    timeline: [
      { time: '2024-03-12 08:30', location: '深圳发货仓库', event: '包裹已揽收' },
      { time: '2024-03-12 12:00', location: '深圳分拨中心', event: '已离开，发往北京' },
      { time: '2024-03-12 22:00', location: '北京首都机场', event: '已到达目的地转运中心' },
      { time: '2024-03-13 06:00', location: '北京转运中心', event: '分拣中' },
    ],
  },
  JD123456789: {
    trackingNumber: 'JD123456789',
    status: 'delivered',
    statusLabel: '已签收',
    estimatedDelivery: '2024-03-07',
    currentLocation: '广州市天河区派送站',
    timeline: [
      { time: '2024-03-06 09:00', location: '广州仓库', event: '包裹已揽收' },
      { time: '2024-03-06 14:00', location: '广州分拣中心', event: '分拣完成，派往天河区' },
      { time: '2024-03-07 10:00', location: '广州市天河区派送站', event: '快件已到达，准备派送' },
      { time: '2024-03-07 15:30', location: '广州市天河区', event: '快件已签收，签收人：本人' },
    ],
  },
};

// ===== 工具定义 =====

/**
 * 订单查询工具
 * 根据订单ID查询订单状态和基本信息
 */
export const queryOrderTool = createTool({
  id: 'query-order',
  description:
    '根据订单ID查询订单状态、金额、商品列表和收货地址。用户询问订单情况、订单在哪里、什么时候发货时调用此工具。',
  inputSchema: z.object({
    orderId: z.string().describe('订单ID，6-12位纯数字，例如：12345'),
  }),
  execute: async ({ context }) => {
    const { orderId } = context;

    // 生产环境：调用内部订单系统 API
    // const response = await fetch(`${ORDER_API_BASE}/orders/${orderId}`, {
    //   headers: { Authorization: `Bearer ${ORDER_API_TOKEN}` },
    // });

    const order = MOCK_ORDERS[orderId];
    if (!order) {
      return {
        found: false,
        error: `订单 #${orderId} 不存在，请确认订单号是否正确。订单号通常是6位以上的纯数字。`,
      };
    }

    return { found: true, order };
  },
});

/**
 * 物流查询工具
 * 根据快递单号查询物流轨迹和预计送达时间
 * 依赖：需要先调用 query-order 获取 trackingNumber
 */
export const queryShippingTool = createTool({
  id: 'query-shipping',
  description:
    '根据快递单号查询物流轨迹和预计送达时间。需要先调用 query-order 获取快递单号，再调用此工具查询详情。',
  inputSchema: z.object({
    trackingNumber: z.string().describe('快递单号，例如：SF7890123456'),
    carrier: z.string().describe('快递公司名称，例如：SF Express、JD Express'),
  }),
  execute: async ({ context }) => {
    const { trackingNumber } = context;

    // 生产环境：调用快递查询聚合 API（快递鸟、快递100等）
    // const response = await fetch(`${SHIPPING_API_BASE}/track`, {
    //   method: 'POST',
    //   body: JSON.stringify({ trackingNumber, carrier }),
    // });

    const shipping = MOCK_SHIPPING[trackingNumber];
    if (!shipping) {
      return {
        found: false,
        error: `快递单号 ${trackingNumber} 暂无轨迹信息，可能包裹尚未揽收或信息延迟，请稍后再试。`,
      };
    }

    return { found: true, shipping };
  },
});

/**
 * 退款发起工具
 * 为指定订单提交退款申请
 * 超过1000元的退款会进入人工审批流程（由 LangGraph.js workflow 处理）
 */
export const initiateRefundTool = createTool({
  id: 'initiate-refund',
  description:
    '为指定订单发起退款申请。此工具只提交申请，不能保证退款一定成功。超过1000元需要人工审批。',
  inputSchema: z.object({
    orderId: z.string().describe('订单ID'),
    reason: z.string().describe('退款原因，例如：商品质量问题、不想要了、发错货、未收到货'),
    amount: z
      .number()
      .positive()
      .describe('申请退款金额（元），不能超过实际支付金额'),
  }),
  execute: async ({ context }) => {
    const { orderId, reason, amount } = context;

    // 先验证订单存在
    const order = MOCK_ORDERS[orderId];
    if (!order) {
      return {
        success: false,
        error: `订单 #${orderId} 不存在，无法发起退款`,
      };
    }

    // 验证退款金额不超过订单金额
    if (amount > order.amount) {
      return {
        success: false,
        error: `退款金额（${amount}元）不能超过订单实际支付金额（${order.amount}元）`,
      };
    }

    // 已取消的订单不能退款
    if (order.status === 'cancelled') {
      return {
        success: false,
        error: '该订单已取消，无需退款',
      };
    }

    // 超过1000元需要人工审批
    // 生产环境中：这里会触发 LangGraph.js 的人工审批 workflow
    const requiresApproval = amount > 1000;

    // 生成退款申请单号
    const refundId = `RF${Date.now()}`;

    // 生产环境：写入退款申请到数据库，并推送审批通知
    // await db.insert(refunds).values({ refundId, orderId, amount, reason, status: ... });
    // if (requiresApproval) {
    //   await notifyApproval({ refundId, orderId, amount, reason });
    // }

    return {
      success: true,
      refundId,
      orderId,
      amount,
      reason,
      status: requiresApproval ? 'pending_approval' : 'processing',
      statusLabel: requiresApproval ? '待人工审批' : '退款处理中',
      requiresApproval,
      message: requiresApproval
        ? `退款申请 ${refundId} 已提交。由于退款金额超过1000元，需要财务团队人工审核，预计24小时内完成审核并通过站内信通知您。`
        : `退款申请 ${refundId} 已提交，系统将在3-5个工作日内退款至您的支付账户。`,
      estimatedTime: requiresApproval ? '24小时内审核' : '3-5个工作日到账',
    };
  },
});
