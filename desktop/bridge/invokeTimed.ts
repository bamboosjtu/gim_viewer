/**
 * Tauri invoke 统一计时入口。
 *
 * 所有 bridge command 都应经由此函数调用，避免性能分析只看到某一条
 * 读取路径。统计由 src/utils/perfTimings.ts 持有，因此会随 perfReset
 * 自动按工程 session 清空；await 期间切换工程时，旧响应不会提交指标。
 */

import { invoke } from '@tauri-apps/api/core';
import { perfCurrentSession, perfRecordInvoke } from '../src/utils/perfTimings.js';

function byteLength(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

/** 估算一次 command 的请求 + 响应字节量。可由调用方覆盖请求大小。 */
export function estimateInvokeBytes(request: unknown, response: unknown): number {
  const requestSize = typeof request === 'number' ? request : byteLength(request);
  return requestSize + byteLength(response);
}

export interface InvokeTimedOptions {
  /** 需要显式绑定旧异步任务时传入；默认捕获当前 perf session。 */
  sessionId?: number;
  /** 请求体已知大小时可覆盖自动 JSON 估算。 */
  requestBytes?: number;
}

/**
 * 统一包装 Tauri invoke。
 *
 * 失败调用也会计数，并在 failures 中体现；异常继续原样抛出，保持原有
 * bridge API 行为。第二个参数既支持 Tauri 的 args 对象，也支持二进制
 * payload（write_*_binary command）。
 */
export async function invokeTimed<T>(
  command: string,
  args?: unknown,
  options: InvokeTimedOptions = {},
): Promise<T> {
  const session = perfCurrentSession();
  const sessionId = options.sessionId ?? session.id;
  const requestBytes = options.requestBytes ?? byteLength(args);
  const start = performance.now();
  let failed = false;
  try {
    // Tauri invoke 的 payload 类型在运行时可为对象或 Uint8Array；桥接层
    // 保持原始值，不额外 structured clone / JSON stringify。
    const result = args === undefined
      ? await invoke<T>(command)
      : await invoke<T>(command, args as Record<string, unknown>);
    perfRecordInvoke(command, performance.now() - start, estimateInvokeBytes(requestBytes, result), sessionId, false);
    return result;
  } catch (error) {
    failed = true;
    perfRecordInvoke(command, performance.now() - start, requestBytes, sessionId, failed);
    throw error;
  }
}
