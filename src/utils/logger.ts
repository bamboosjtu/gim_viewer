/**
 * 调试日志工具。
 *
 * 用法：
 *   import { debugLog, debugWarn, debugError } from '../utils/logger.js';
 *   import { DEBUG_IFC_LOAD } from '../config/debug.js';
 *
 *   debugLog(DEBUG_IFC_LOAD, '[IFC Engine] init start', { href });
 *   debugWarn(DEBUG_FRAGMENTS, '[Fragments] update failed', err);
 *   debugError(DEBUG_FRAGMENTS, '[Fragments] full stack', err);
 *
 * 设计原则：
 * - enabled=false 时无任何输出（连函数调用开销都极小，仅一次布尔判断）
 * - 不改变原有行为，仅控制是否输出
 * - 错误仍可定位：生产环境保留 console.error 和关键 warning
 * - debugError 仅用于 debug 级别的错误详情（如完整堆栈），不替代真正的 console.error
 */

/**
 * 条件日志输出。
 * @param enabled 是否启用（通常来自 config/debug.ts）
 * @param args 透传给 console.log 的参数
 */
export function debugLog(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.log(...args);
}

/**
 * 条件警告输出。
 * @param enabled 是否启用
 * @param args 透传给 console.warn 的参数
 */
export function debugWarn(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.warn(...args);
}

/**
 * 条件错误详情输出。
 *
 * 仅用于 debug 级别的错误详情（如 Fragments 完整堆栈）。
 * 不替代真正的 console.error —— 致命错误仍应直接 console.error，
 * 确保生产环境不受 debug 开关影响。
 *
 * @param enabled 是否启用
 * @param args 透传给 console.error 的参数
 */
export function debugError(enabled: boolean, ...args: unknown[]): void {
  if (enabled) console.error(...args);
}
