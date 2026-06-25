/**
 * web-ifc WASM 资源路径辅助。
 *
 * WASM 文件由 scripts/copy-web-ifc-wasm.mjs 复制到 public/wasm/，
 * 运行时通过 `${origin}/wasm/web-ifc.wasm` 访问。
 */

/** 获取 WASM 基础 URL（始终以 / 结尾） */
export function getWebIfcWasmBaseUrl(): string {
  return `${window.location.origin}/wasm/`;
}

/**
 * 校验 web-ifc.wasm 是否可访问。
 * 在 initEngine 前调用，提前暴露 fetch 失败问题。
 */
export async function assertWebIfcWasmAvailable(): Promise<void> {
  const url = `${getWebIfcWasmBaseUrl()}web-ifc.wasm`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`web-ifc.wasm 不可访问: ${url}, status=${res.status}`);
  }
  const len = Number(res.headers.get('content-length') || '0');
  console.log('[WASM] web-ifc.wasm 可访问:', { url, status: res.status, contentLength: len });
}
