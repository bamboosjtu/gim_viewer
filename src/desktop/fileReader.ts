/**
 * 在 Tauri 环境下通过 Rust command 读取文件内容为 ArrayBuffer。
 * 仅在 Tauri 环境可用，浏览器环境不应调用此函数。
 */
export async function readFileBytes(path: string): Promise<ArrayBuffer> {
  const { invoke } = await import('@tauri-apps/api/core');
  const bytes = await invoke<number[]>('read_file_bytes', { path });
  return new Uint8Array(bytes).buffer;
}
