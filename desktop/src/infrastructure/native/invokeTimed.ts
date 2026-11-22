/**
 * Tauri invoke 统一计时入口。
 *
 * 所有 bridge command 都应经由此函数调用，避免性能分析只看到某一条
 * 读取路径。统计由 src/utils/perfTimings.ts 持有，因此会随 perfReset
 * 自动按工程 session 清空；await 期间切换工程时，旧响应不会提交指标。
 */

import { invoke } from '@tauri-apps/api/core';
import { nativeError } from '@desktop/contracts.js';
import { perfCurrentSession, perfRecordInvoke } from '../../utils/perfTimings.js';
import { StaleSessionError } from '../../shared/sessionScope.js';

export type NativeOwner = () => boolean;

export function requireNativeOwner(isCurrent?: NativeOwner): void {
  if (isCurrent && !isCurrent()) throw new StaleSessionError();
}

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
  if (typeof value === 'string')
    return { bytes: textEncoder.encode(value).byteLength, measured: true };
  if (value instanceof ArrayBuffer) return { bytes: value.byteLength, measured: true };
  if (ArrayBuffer.isView(value)) return { bytes: value.byteLength, measured: true };
  if (typeof Blob !== 'undefined' && value instanceof Blob)
    return { bytes: value.size, measured: true };
  // 普通对象由 Tauri 内部序列化。这里不再 JSON.stringify，避免性能探针
  // 复制大型 graph/index payload 并改变被测 command 的耗时。
  return { bytes: 0, measured: false };
}

export interface InvokeTimedOptions {
  /** File requests reject a reply once its owning project or open intent expires. */
  isCurrent?: NativeOwner;
  /** 需要显式绑定旧异步任务时传入；默认捕获当前 perf session。 */
  sessionId?: number;
  /** 请求体已知大小时显式传入，避免对大型对象做 JSON.stringify。 */
  requestBytes?: number;
  /** 响应体已知大小时显式传入，适用于后端返回普通对象但调用方已有大小。 */
  responseBytes?: number;
}

/**
 * 统一包装 Tauri invoke。执行失败按生成的 v1 错误契约映射。
 * 参数可以是 Tauri args 对象或原始二进制 payload。
 */
export async function invokeTimed<T>(
  command: DesktopCommand,
  args?: unknown,
  options: InvokeTimedOptions = {},
): Promise<T> {
  requireNativeOwner(options.isCurrent);
  const session = perfCurrentSession();
  const sessionId = options.sessionId ?? session.id;
  const requestMeasurement =
    options.requestBytes === undefined
      ? measureByteLength(args)
      : measuredBytes(options.requestBytes);
  const start = performance.now();
  let result: T;
  try {
    // Tauri invoke 的 payload 类型在运行时可为对象或 Uint8Array；桥接层
    // 保持原始值，不额外 structured clone / JSON stringify。
    result =
      args === undefined
        ? await invoke<T>(command)
        : await invoke<T>(command, args as Record<string, unknown>);
  } catch (error) {
    perfRecordInvoke(
      command,
      performance.now() - start,
      requestMeasurement.bytes,
      sessionId,
      true,
      requestMeasurement.measured,
    );
    requireNativeOwner(options.isCurrent);
    throw nativeError(error);
  }
  const responseMeasurement =
    options.responseBytes === undefined
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
  requireNativeOwner(options.isCurrent);
  return result;
}
import type { DesktopCommand } from '@desktop/contracts.js';
