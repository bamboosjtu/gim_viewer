/**
 * Vitest 全局 setup（jsdom 环境）。
 *
 * 主要用途：为 jsdom 25 不完整的 Blob/File 实现补充标准方法。
 *
 * 背景：
 * - jsdom 25 的 Blob 只实现了 size/type/slice，缺少标准的 text()/arrayBuffer()/stream()
 * - 真实浏览器（含 Tauri WebView）原生支持这些方法
 * - 生产代码使用 file.text() / file.arrayBuffer()（与 IFC 加载器一致）
 * - 测试在 jsdom 环境运行，需要 polyfill 才能调用这些方法
 *
 * 实现策略：
 * - jsdom Blob 内部通过 Symbol(impl) 暴露 FileImpl/BlobImpl，其 _buffer 字段为 Node Buffer
 * - 通过私有 symbol 访问 _buffer，实现 text()/arrayBuffer()
 * - 仅在方法缺失时 polyfill，不覆盖原生实现（Node 20+ 原生 Blob 已有这些方法）
 */

type BlobImpl = { _buffer?: Buffer };

function getImplBuffer(blob: Blob): Buffer | null {
  const symbols = Object.getOwnPropertySymbols(blob);
  for (const sym of symbols) {
    const impl = (blob as unknown as Record<symbol, unknown>)[sym];
    if (impl && typeof impl === 'object' && '_buffer' in (impl as BlobImpl)) {
      return (impl as BlobImpl)._buffer ?? null;
    }
  }
  return null;
}

if (typeof Blob !== 'undefined') {
  const proto = Blob.prototype as unknown as {
    text?: () => Promise<string>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };

  if (typeof proto.text !== 'function') {
    proto.text = async function (this: Blob): Promise<string> {
      const buf = getImplBuffer(this);
      if (buf) return buf.toString('utf8');
      throw new Error('Blob.text() polyfill: cannot access jsdom Blob internal buffer');
    };
  }

  if (typeof proto.arrayBuffer !== 'function') {
    proto.arrayBuffer = async function (this: Blob): Promise<ArrayBuffer> {
      const buf = getImplBuffer(this);
      if (buf) {
        // 复制底层 buffer 为独立 ArrayBuffer（避免共享 Node Buffer 的内存）
        const copy = buf.slice(0);
        return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
      }
      throw new Error('Blob.arrayBuffer() polyfill: cannot access jsdom Blob internal buffer');
    };
  }
}
