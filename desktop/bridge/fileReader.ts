import {DESKTOP_COMMANDS} from './contracts.js';
import type {FileInfo} from './contracts.js';
export type {FileInfo} from './contracts.js';
import { invokeTimed } from './invokeTimed.js';

/**
 * 在 Tauri 环境下通过 Rust command 读取文件内容为 ArrayBuffer。
 * 仅在 Tauri 环境可用，浏览器环境不应调用此函数。
 */
export async function readFileBytes(path: string): Promise<ArrayBuffer> {
  const bytes = await invokeTimed<ArrayBuffer | Uint8Array>(DESKTOP_COMMANDS.read_file_bytes, { path });
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 文件元信息（含 sha256） */


/**
 * 在 Tauri 环境下获取文件元信息（路径、文件名、大小、修改时间、sha256）。
 * 仅在 Tauri 环境可用，浏览器环境不应调用此函数。
 */
export async function getFileInfo(path: string): Promise<FileInfo> {
  return invokeTimed<FileInfo>(DESKTOP_COMMANDS.get_file_info, { path });
}

/**
 * Read only the bounded GIM header prefix. The Rust command enforces the same
 * upper bound regardless of the caller-provided value.
 */
export async function readFileHead(path: string, maxBytes = 1024 * 1024): Promise<ArrayBuffer> {
  const bytes = await invokeTimed<ArrayBuffer | Uint8Array>(DESKTOP_COMMANDS.read_file_head, { path, maxBytes });
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
