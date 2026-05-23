/**
 * 漏桶算法（Leaky Bucket）
 *
 * 工作原理：
 *   - 请求进入一个 FIFO 队列
 *   - 一个独立的"漏水"定时器以恒定速率从队列里取出请求处理
 *   - 队列满了之后新请求直接拒绝
 *
 * 适用场景：需要完全平滑流量、对下游施加恒定速率的场合。比如 AgentFlow 调用
 * 第三方 ERP 系统时，对方明确要求"每秒最多 5 次"，多了直接封 IP——这时不能
 * 用令牌桶，因为令牌桶允许突发会触发对方风控。
 *
 * 单机演示版本。生产中如果要跨 Pod 共享同一个漏桶，用 BullMQ 的 limiter 选项
 * 实现，原理一致但状态在 Redis。
 */

/** 队列里的一个任务 */
interface QueuedTask<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export class LeakyBucket {
  private queue: QueuedTask<unknown>[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** 任务之间的最小间隔（毫秒） */
  private readonly intervalMs: number;

  constructor(
    /** 队列最大长度，超出直接拒绝 */
    private readonly capacity: number,
    /** 每秒漏出的请求数 */
    leakRatePerSec: number,
  ) {
    if (capacity <= 0 || leakRatePerSec <= 0) {
      throw new Error('capacity 和 leakRatePerSec 必须为正数');
    }
    this.intervalMs = 1000 / leakRatePerSec;
  }

  /**
   * 提交一个任务
   * @returns 任务的 Promise，被拒绝时 reject('BUCKET_FULL')
   */
  submit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.queue.length >= this.capacity) {
        reject(new Error('BUCKET_FULL'));
        return;
      }
      this.queue.push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.ensureLeaking();
    });
  }

  /** 当前队列长度 */
  get pending(): number {
    return this.queue.length;
  }

  /** 启动定时漏水 */
  private ensureLeaking(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      const next = this.queue.shift();
      if (!next) {
        // 队列空了，暂停定时器节省 CPU
        clearInterval(this.timer!);
        this.timer = null;
        return;
      }
      // 任务在独立的微任务里执行，不要让一个慢任务拖累漏水节奏
      void next
        .task()
        .then((v) => next.resolve(v))
        .catch((e) => next.reject(e));
    }, this.intervalMs);
  }

  /** 优雅关闭，释放定时器 */
  shutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// --- 演示 ---
async function demo(): Promise<void> {
  console.log('=== 漏桶演示：每秒漏 2 个，容量 5 ===');
  const bucket = new LeakyBucket(5, 2);

  // 瞬间提交 8 个任务
  const start = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      bucket.submit(async () => {
        const elapsed = Date.now() - start;
        console.log(`任务 ${i + 1} 在 ${elapsed}ms 执行`);
        return i + 1;
      }),
    ),
  );

  // 前 5 个进队列，后 3 个被拒绝
  const accepted = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;
  console.log(`接受 ${accepted}，拒绝 ${rejected}`);
  bucket.shutdown();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
