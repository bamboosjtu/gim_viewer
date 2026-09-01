/**
 * Tauri invoke 统一计时入口。
 *
 * 所有 bridge command 都应经由此函数调用，避免性能分析只看到某一条
 * 读取路径。统计由 src/utils/perfTimings.ts 持有，因此会随 perfReset
 * 自动按工程 session 清空；await 期间切换工程时，旧响应不会提交指标。
 */

import { invoke } from '@tauri-apps/api/core';
import { perfCurrentSession, perfRecordInvoke } from '../src/utils/perfTimings.js';

interface ByteMeasurement {
  bytes: number;
  /** false 表示调用参数/结果是普通对象，未为测量而额外 JSON 序列化。 */
  measured: boolean;
}

const textEncoder = new TextEncoder();

function measuredBytes(bytes: number): ByteMeasurement {
  return Number.isFinite(bytes) && bytes >= 0
    ? { bytes, measured: true }
    : { bytes: 0, measured: false };
}

function measureByteLength(value: unknown): ByteMeasurement {
  if (value == null) return { bytes: 0, measured: true };
  if (typeof value === 'string') return { bytes: textEncoder.encode(value).byteLength, measured: true };
  if (value instanceof ArrayBuffer) return { bytes: value.byteLength, measured: true };
  if (ArrayBuffer.isView(value)) return { bytes: value.byteLength, measured: true };
  if (typeof Blob !== 'undefined' && value instanceof Blob) return { bytes: value.size, measured: true };
  // 普通对象由 Tauri 内部序列化。这里不再 JSON.stringify，避免性能探针
  // 复制大型 graph/index payload 并改变被测 command 的耗时。
  return { bytes: 0, measured: false };
}

/** 估算一次 command 的请求 + 响应字节量（不对普通对象做额外序列化）。 */
export function estimateInvokeBytes(request: unknown, response: unknown): number {
  const requestMeasurement = typeof request === 'number' ? measuredBytes(request) : measureByteLength(request);
  return requestMeasurement.bytes + measureByteLength(response).bytes;
}

/** 供埋点/测试查看字节是否完整测得；普通对象会返回 measured=false。 */
export function estimateInvokeByteMeasurement(request: unknown, response: unknown): {
  bytes: number;
  measured: boolean;
} {
  const requestMeasurement = typeof request === 'number' ? measuredBytes(request) : measureByteLength(request);
  const responseMeasurement = measureByteLength(response);
  return {
    bytes: requestMeasurement.bytes + responseMeasurement.bytes,
    measured: requestMeasurement.measured && responseMeasurement.measured,
  };
}

export interface InvokeTimedOptions {
  /** 需要显式绑定旧异步任务时传入；默认捕获当前 perf session。 */
  sessionId?: number;
  /** 请求体已知大小时显式传入，避免对大型对象做 JSON.stringify。 */
  requestBytes?: number;
  /** 响应体已知大小时显式传入，适用于后端返回普通对象但调用方已有大小。 */
  responseBytes?: number;
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
  const requestMeasurement = options.requestBytes === undefined
    ? measureByteLength(args)
    : measuredBytes(options.requestBytes);
  const start = performance.now();
  try {
    // Tauri invoke 的 payload 类型在运行时可为对象或 Uint8Array；桥接层
    // 保持原始值，不额外 structured clone / JSON stringify。
    const result = args === undefined
      ? await invoke<T>(command)
      : await invoke<T>(command, args as Record<string, unknown>);
    const responseMeasurement = options.responseBytes === undefined
      ? measureByteLength(result)
      : measuredBytes(options.responseBytes);
    perfRecordInvoke(
      command,
      performance.now() - start,
      requestMeasurement.bytes + responseMeasurement.bytes,
      sessionId,
      false,
      requestMeasurement.measured && responseMeasurement.measured,
    );
    return result;
  } catch (error) {
    perfRecordInvoke(
      command,
      performance.now() - start,
      requestMeasurement.bytes,
      sessionId,
      true,
      requestMeasurement.measured,
    );
    throw error;
  }
}
