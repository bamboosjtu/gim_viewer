/** 简易日志工具 */
export function logInfo(msg: string, ...args: unknown[]) {
  console.log(`[GIM] ${msg}`, ...args);
}

export function logWarn(msg: string, ...args: unknown[]) {
  console.warn(`[GIM] ${msg}`, ...args);
}

export function logError(msg: string, ...args: unknown[]) {
  console.error(`[GIM] ${msg}`, ...args);
}
