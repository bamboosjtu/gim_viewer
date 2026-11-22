import { DESKTOP_COMMANDS } from '@desktop/contracts.js';
import type { FileInfo } from '@desktop/contracts.js';
export type { FileInfo } from '@desktop/contracts.js';
import { invokeTimed, type NativeOwner } from './invokeTimed.js';

/**
 * 在 Tauri 环境下通过 Rust command 读取文件内容为 ArrayBuffer。
 * 仅在 Tauri 环境可用，浏览器环境不应调用此函数。
 */
export async function readFileBytes(path: string, isCurrent?: NativeOwner): Promise<ArrayBuffer> {
  const bytes = await invokeTimed<ArrayBuffer | Uint8Array>(
    DESKTOP_COMMANDS.read_file_bytes,
    { path },
    { isCurrent },
  );
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 文件元信息（含 sha256） */

/**
 * 在 Tauri 环境下获取文件元信息（路径、文件名、大小、修改时间、sha256）。
 * 仅在 Tauri 环境可用，浏览器环境不应调用此函数。
 */
export function getFileInfo(path: string, isCurrent?: NativeOwner): Promise<FileInfo> {
  return invokeTimed<FileInfo>(DESKTOP_COMMANDS.get_file_info, { path }, { isCurrent });
}

/**
 * Read only the bounded GIM header prefix. The Rust command enforces the same
 * upper bound regardless of the caller-provided value.
 */
export async function readFileHead(
  path: string,
  maxBytes = 1024 * 1024,
  isCurrent?: NativeOwner,
): Promise<ArrayBuffer> {
  const bytes = await invokeTimed<ArrayBuffer | Uint8Array>(
    DESKTOP_COMMANDS.read_file_head,
    { path, maxBytes },
    { isCurrent },
  );
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
