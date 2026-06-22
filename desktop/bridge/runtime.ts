/**
 * 判断当前是否运行在 Tauri 桌面环境
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined'
    && '__TAURI_INTERNALS__' in window;
}
