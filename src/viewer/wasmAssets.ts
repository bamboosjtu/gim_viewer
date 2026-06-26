/**
 * web-ifc WASM 资源路径辅助。
 *
 * WASM 文件由 scripts/copy-web-ifc-wasm.mjs 复制到 public/wasm/，
 * 构建后位于 dist/wasm/，通过 document.baseURI 相对路径解析访问。
 *
 * 不使用 window.location.origin —— 在 Tauri 生产环境下 origin 可能为空或不可用。
 */

import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';

const WEB_IFC_WASM_FILE = 'web-ifc.wasm';

let resolvedWasmBaseUrl: string | null = null;

/** 获取 WASM 基础 URL（始终以 / 结尾） */
function getWebIfcWasmBaseUrl(): string {
  if (resolvedWasmBaseUrl) return resolvedWasmBaseUrl;
  return new URL('./wasm/', document.baseURI).toString();
}

/** 获取 web-ifc.wasm 完整 URL */
function getWebIfcWasmUrl(baseUrl = getWebIfcWasmBaseUrl()): string {
  return new URL(WEB_IFC_WASM_FILE, baseUrl).toString();
}

function getWebIfcWasmBaseCandidates(): string[] {
  const candidates = [
    new URL('./wasm/', document.baseURI).toString(),
    new URL('/wasm/', window.location.href).toString(),
    new URL('./wasm/', window.location.href).toString(),
  ];

  if (window.location.origin && window.location.origin !== 'null') {
    candidates.push(`${window.location.origin}/wasm/`);
  }

  return [...new Set(candidates)];
}

/**
 * 校验 web-ifc.wasm 是否可访问。
 * 在 initEngine 前调用，提前暴露 fetch 失败问题。
 */
export async function resolveWebIfcWasmBaseUrl(): Promise<string> {
  const candidates = getWebIfcWasmBaseCandidates();
  let lastError: unknown = null;

  for (const baseUrl of candidates) {
    const url = getWebIfcWasmUrl(baseUrl);
    debugLog(DEBUG_IFC_LOAD, '[WASM] checking web-ifc.wasm:', {
      url,
      baseUrl,
      origin: window.location.origin,
      href: window.location.href,
      baseURI: document.baseURI,
    });

    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`status=${res.status}`);
      }

      const len = Number(res.headers.get('content-length') || '0');
      debugLog(DEBUG_IFC_LOAD, '[WASM] web-ifc.wasm 可访问:', { url, baseUrl, status: res.status, contentLength: len });
      resolvedWasmBaseUrl = baseUrl;
      return baseUrl;
    } catch (err) {
      lastError = err;
      console.warn('[WASM] web-ifc.wasm 候选路径不可访问:', { url, baseUrl, error: err });
    }
  }

  throw new Error(`web-ifc.wasm 不可访问，已尝试: ${candidates.map(getWebIfcWasmUrl).join(', ')}; last=${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
