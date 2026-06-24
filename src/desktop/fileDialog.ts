import { isTauri } from './runtime.js';

/**
 * 在 Tauri 环境下打开 GIM 文件选择对话框，返回选中的文件路径。
 * 浏览器环境返回 null，由调用方走 input file fallback。
 */
export async function openGimFilePath(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: false,
    filters: [{ name: 'GIM 文件', extensions: ['gim'] }],
  });
  if (typeof selected === 'string' && selected.length > 0) return selected;
  return null;
}

/**
 * 在 Tauri 环境下打开 IFC 文件选择对话框（多选），返回选中的文件路径数组。
 * 浏览器环境返回 null，由调用方走 input file fallback。
 */
export async function openIfcFilePaths(): Promise<string[] | null> {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    multiple: true,
    filters: [{ name: 'IFC 文件', extensions: ['ifc'] }],
  });
  if (selected === null) return null;
  // multiple: true 返回 string[]，但类型签名可能包含 string，统一处理
  const paths = Array.isArray(selected) ? selected : [selected];
  return paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
}
