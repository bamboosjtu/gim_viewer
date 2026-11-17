/**
 * 调试日志工具。
 *
 * 用法：
 *   import { debugLog, debugWarn } from '../utils/logger.js';
 *   import { DEBUG_IFC_LOAD } from '../config/debug.js';
 *
 *   debugLog(DEBUG_IFC_LOAD, '[IFC Engine] init start', { href });
 *   debugWarn(DEBUG_FRAGMENTS, '[Fragments] update failed', err);
 *
 * 设计原则：
 * - enabled=false 时无任何输出（连函数调用开销都极小，仅一次布尔判断）
 * - 不改变原有行为，仅控制是否输出
 * - 错误仍可定位：生产环境保留 console.error 和关键 warning
 */

/**
 * 条件日志输出。
 * @param enabled 是否启用（通常来自 config/debug.ts）
 * @param args 透传给 console.log 的参数
 */
export function debugLog(enabled: boolean, ...args: unknown[]): void {
  if (enabled) logger.log(...args);
}

/**
 * 条件警告输出。
 * @param enabled 是否启用
 * @param args 透传给 console.warn 的参数
 */
export function debugWarn(enabled: boolean, ...args: unknown[]): void {
  if (enabled) logger.warn(...args);
}

type LogLevel = 'log' | 'info' | 'warn' | 'error';
type LogSink = (level: LogLevel, args: readonly unknown[]) => void;
let sink: LogSink | undefined;
/** A host can capture structured errors and context without classifying message text. */
export function setLogSink(next?: LogSink): void {
  sink = next;
}
function emit(level: LogLevel, args: unknown[]): void {
  if (sink) sink(level, args);
  else console[level](...args);
}
export const logger = {
  log: (...args: unknown[]) => emit('log', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};
