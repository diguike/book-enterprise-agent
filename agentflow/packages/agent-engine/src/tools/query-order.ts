/**
 * queryOrder 工具：根据订单号查询订单状态、金额、商品、收货地址。
 *
 * MVP 用内存 Mock 数据演示。生产环境替换 execute 内部为真实订单系统 API 调用。
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

interface OrderItem {
  name: string;
  qty: number;
  price: number;
}

interface ShippingAddress {
  name: string;
  /** 手机号统一返回脱敏格式 */
  phone: string;
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

// Mock 订单库（生产环境替换为对内部订单系统的 HTTP 调用）
const MOCK_ORDERS: Record<string, Order> = {
  '12345': {
    orderId: '12345',
    status: 'shipped',
    statusLabel: '已发货',
    amount: 299,
    items: [{ name: '无线耳机 Pro', qty: 1, price: 299 }],
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
    amount: 1299,
    items: [{ name: '机械键盘 TKL', qty: 1, price: 1299 }],
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
};

export const queryOrderTool = createTool({
  id: 'query-order',
  description:
    '根据订单号查询订单状态、金额、商品列表和收货地址。用户询问订单进度、何时发货、订单详情时调用此工具。',
  inputSchema: z.object({
    orderId: z.string().describe('订单号，5-12 位数字，例如：12345'),
  }),
  execute: async ({ context }) => {
    const { orderId } = context;
    const order = MOCK_ORDERS[orderId];

    if (!order) {
      return {
        found: false,
        error: `订单 #${orderId} 不存在，请确认订单号是否正确。`,
      };
    }
    return { found: true, order };
  },
});

/** Mock 订单库导出，便于在 README 测试时确认可用订单号 */
export const MOCK_ORDER_IDS = Object.keys(MOCK_ORDERS);
