/**
 * Code Skill 沙箱实现
 *
 * 使用 isolated-vm 在独立的 V8 Isolate 中执行用户代码。
 * 安全策略：
 * 1. 内存限制（memoryLimit）：防止 Isolate 堆无限增长导致 OOM
 * 2. CPU 时间限制（timeout）：防止无限循环耗尽 CPU
 * 3. 白名单函数注入：沙箱内只能调用明确允许的外部函数
 * 4. 通过 ExternalCopy 传递数据：防止沙箱对象引用泄漏到外部
 *
 * 生产架构说明：
 * 此文件应运行在独立的 Node.js 子进程（apps/sandbox）中，
 * 通过 IPC 与主进程通信，而不是直接在 API 进程内调用。
 * 独立进程 + seccomp 限制系统调用，构成双层沙箱防护。
 */

import ivm from 'isolated-vm';
import type { CodeSkillConfig, SkillContext } from './types.js';

// ─── URL 白名单检查 ───────────────────────────────────────────────

/**
 * 检查 URL 是否在白名单内。
 *
 * 沙箱内的 fetch 调用必须经过这个检查。
 * 白名单在 CodeSkillConfig.allowedUrls 中定义，由租户在注册 Skill 时填写。
 * 平台审核 allowedUrls，防止企业代码访问非业务域名。
 */
function isUrlWhitelisted(url: string, allowedUrls: string[]): boolean {
  try {
    const parsed = new URL(url);
    // 禁止访问内网地址（RFC 1918 私有段 + loopback + link-local）
    const hostname = parsed.hostname;
    // 172.16.0.0/12 覆盖 172.16.x.x ~ 172.31.x.x，不能只检查 "172." 前缀
    // （172.0.x.x ~ 172.15.x.x 是公网地址）
    const is172Private = (() => {
      const parts = hostname.split('.');
      if (parts[0] !== '172') return false;
      const second = parseInt(parts[1], 10);
      return second >= 16 && second <= 31;
    })();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('169.254.') || // link-local
      is172Private
    ) {
      return false;
    }
    // 检查是否匹配白名单前缀
    return allowedUrls.some((prefix) => url.startsWith(prefix));
  } catch {
    return false;
  }
}

// ─── 沙箱执行结果类型 ─────────────────────────────────────────────

interface SandboxResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** 沙箱内实际消耗的 CPU 时间（毫秒） */
  cpuTimeMs?: number;
  /** Isolate 峰值堆内存（字节） */
  heapUsedBytes?: number;
}

// ─── 核心沙箱执行函数 ─────────────────────────────────────────────

/**
 * 在 isolated-vm 沙箱中执行用户的 Code Skill。
 *
 * 每次调用创建新的 Isolate 和 Context，执行完毕后立即 dispose。
 * 不复用 Isolate 的原因：每次执行后 Isolate 的状态（全局变量等）
 * 可能被用户代码修改，复用会导致跨调用的状态污染。
 * 代价是每次有 <5ms 的冷启动开销，这在大多数场景下可接受。
 */
export async function executeInSandbox(
  config: CodeSkillConfig,
  input: unknown,
  context: SkillContext
): Promise<SandboxResult> {
  let isolate: ivm.Isolate | null = null;
  const startTime = Date.now();

  try {
    // 第一层隔离：创建独立的 V8 Isolate
    // memoryLimit 单位 MB，超出后抛出 RangeError（而不是让整个 Node 进程 OOM）
    isolate = new ivm.Isolate({ memoryLimit: config.memoryLimitMb });

    // 创建执行上下文（每次执行创建新 Context，全局状态互相隔离）
    const vmContext = await isolate.createContext();
    const jail = vmContext.global;

    // 注入只读的输入数据
    // 使用 ExternalCopy 进行深拷贝，防止沙箱代码持有外部对象的引用
    // ExternalCopy 把数据序列化后传入 Isolate，外部修改不影响沙箱内的副本
    await jail.set('__input__', new ivm.ExternalCopy(input).copyInto(), { copy: true });

    // 注入沙箱上下文（只读，提供租户信息给用户代码）
    await jail.set(
      '__context__',
      new ivm.ExternalCopy({
        tenantId: context.tenantId,
        sessionId: context.sessionId,
      }).copyInto(),
      { copy: true }
    );

    // 注入白名单 fetch 函数
    // 用 ivm.Reference 包装外部函数，沙箱内调用时会跨 Isolate 边界执行
    // 外部函数运行在主 Isolate 里，享有完整的 Node.js 权限，但我们在这里做白名单检查
    await jail.set(
      '__fetch__',
      new ivm.Reference(async (url: string, optionsJson?: string) => {
        // 白名单检查（在外部执行，沙箱无法绕过）
        if (!isUrlWhitelisted(url, config.allowedUrls)) {
          throw new Error(`[沙箱] URL 不在白名单内，拒绝访问: ${url}`);
        }

        const options = optionsJson ? (JSON.parse(optionsJson) as RequestInit) : {};
        const response = await fetch(url, options);

        if (!response.ok) {
          throw new Error(`[沙箱] HTTP 请求失败: ${response.status} ${response.statusText}`);
        }

        // 返回响应文本（沙箱内通过 __fetch__.apply 调用，结果自动序列化）
        return response.text();
      })
    );

    // 注入简单的 console.log（输出到主进程日志，不影响沙箱安全性）
    await jail.set(
      '__log__',
      new ivm.Reference((...args: unknown[]) => {
        console.log(`[sandbox:${context.tenantId}]`, ...args);
      })
    );

    // 构造包装代码：
    // 1. 把白名单函数重新包装为普通 async 函数（对用户代码透明）
    // 2. 把用户代码包裹在 IIFE 里，防止污染全局作用域
    // 3. 捕获用户代码的返回值
    const wrappedCode = `
      (async function() {
        // 把 Reference 包装成普通 async 函数，对用户代码透明
        // 注意：在 async 上下文中必须用 applySyncPromise 而不是 applySync，
        // 否则会阻塞 V8 事件循环导致 Promise 永远无法 resolve。
        // applySyncPromise 会挂起当前 Isolate，等待外部 Promise 完成后继续执行。
        const fetch = async (url, options) => {
          return __fetch__.applySyncPromise(undefined, [url, options ? JSON.stringify(options) : undefined], { timeout: 10000 });
        };
        const console = {
          log: (...args) => __log__.applySync(undefined, args.map(a => String(a))),
        };

        // 执行用户代码
        ${config.code}

        // 调用入口函数，传入 __input__
        const entryFn = ${config.entrypoint};
        if (typeof entryFn !== 'function') {
          throw new Error('入口函数 ${config.entrypoint} 不存在或不是函数');
        }
        return entryFn(__input__);
      })()
    `;

    // 编译用户代码（编译阶段做语法检查，语法错误在这里抛出）
    const script = await isolate.compileScript(wrappedCode);

    // 执行脚本，设置 CPU 时间上限
    // timeout 超出后抛出 "Script execution timed out."
    // 注意：timeout 是 CPU 时间，不是挂钟时间（wall clock time）
    // 如果用户代码在 await 上等待，CPU 时间不计入，但挂钟时间照算
    // 因此 fetch 调用的等待时间受外部 fetch 超时控制，不受 sandbox timeout 影响
    const resultRef = await script.run(vmContext, {
      timeout: config.cpuTimeLimitMs,
      // promise: true 允许返回 Promise，等待 Promise 完成
      promise: true,
    });

    // 从 Isolate 内取出结果（序列化拷贝，防止 Isolate 对象泄漏）。
    // script.run() 在 promise: true 模式下返回 ivm.Reference（指向沙箱内的 Promise）。
    // 必须调用 .copy() 将结果从 Isolate 堆拷贝到外部，如果包含函数等不可序列化内容会抛出。
    const result = resultRef instanceof ivm.Reference
      ? await resultRef.copy()
      : resultRef;

    // 记录资源使用（用于监控和限额调整）
    const heapStats = isolate.getHeapStatisticsSync();

    return {
      success: true,
      data: result,
      cpuTimeMs: Date.now() - startTime,
      heapUsedBytes: heapStats.used_heap_size,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // 区分超时错误和其他错误，方便上层决定是否重试
    const isTimeout = errorMessage.includes('timed out');
    const isMemoryError =
      errorMessage.includes('RangeError') || errorMessage.includes('memory');

    console.error(
      `[sandbox] 执行失败 (租户 ${context.tenantId}):`,
      errorMessage
    );

    return {
      success: false,
      error: isTimeout
        ? `代码执行超时（限制 ${config.cpuTimeLimitMs}ms）`
        : isMemoryError
          ? `内存超限（限制 ${config.memoryLimitMb}MB）`
          : errorMessage,
      cpuTimeMs: Date.now() - startTime,
    };
  } finally {
    // 无论成功失败，都必须 dispose Isolate 释放 V8 堆内存
    // 不 dispose 会导致内存泄漏，因为 Isolate 的堆不受 Node.js GC 管理
    if (isolate && !isolate.isDisposed) {
      isolate.dispose();
    }
  }
}

// ─── 辅助：验证用户代码（注册时调用）────────────────────────────

/**
 * 在沙箱内编译用户代码，检查语法错误。
 * 注册 Code Skill 时调用，提前发现错误，避免运行时才报错。
 */
export async function validateCodeSkill(code: string, entrypoint: string): Promise<void> {
  let isolate: ivm.Isolate | null = null;
  try {
    isolate = new ivm.Isolate({ memoryLimit: 64 });
    // 只编译，不执行
    await isolate.compileScript(`
      (function() {
        ${code}
        if (typeof ${entrypoint} !== 'function') {
          throw new Error('入口函数 ${entrypoint} 不存在');
        }
      })()
    `);
  } finally {
    if (isolate && !isolate.isDisposed) {
      isolate.dispose();
    }
  }
}
