import { isTauri } from './runtime.js';

/**
 * 在 Tauri 环境下打开 GIM 文件选择对话框，返回选中的文件路径。
 * 浏览器环境返回 null，由调用方走 input file fallback。
 */
export async function openGimFilePath(): Promise<string | null> {
  if (!isTauri()) return null;
  // 通过后端 picker 选择并登记授权路径；避免把 WebView 任意字符串直接
  // 传给 Rust 文件读取命令。
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('pick_gim_file_path');
}

/**
 * 在 Tauri 环境下打开 IFC 文件选择对话框（多选），返回选中的文件路径数组。
 * 浏览器环境返回 null，由调用方走 input file fallback。
 */
export async function openIfcFilePaths(): Promise<string[] | null> {
  if (!isTauri()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string[] | null>('pick_ifc_file_paths');
}
