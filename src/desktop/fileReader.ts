/**
 * 在 Tauri 环境下通过 Rust command 读取文件内容为 ArrayBuffer。
 * 仅在 Tauri 环境可用，浏览器环境不应调用此函数。
 */
export async function readFileBytes(path: string): Promise<ArrayBuffer> {
  const { invoke } = await import('@tauri-apps/api/core');
  const bytes = await invoke<number[]>('read_file_bytes', { path });
  return new Uint8Array(bytes).buffer;
}

/** 文件元信息（含 sha256） */
export interface FileInfo {
  path: string;
  name: string;
  size: number;
  modified_ms: number;
  sha256: string;
}

/**
 * 在 Tauri 环境下获取文件元信息（路径、文件名、大小、修改时间、sha256）。
 * 仅在 Tauri 环境可用，浏览器环境不应调用此函数。
 */
export async function getFileInfo(path: string): Promise<FileInfo> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<FileInfo>('get_file_info', { path });
}
