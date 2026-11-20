export interface IfcSpatialSourceRead {
  text: string | null;
  sourceBytes: number;
  readMs: number;
  decodeMs: number;
  found: boolean;
  error?: string;
}

/**
 * Read and decode one IFC source for spatial indexing.
 *
 * The caller must consume `text` and drop it before reading the next model;
 * this function never retains the ArrayBuffer or decoded text.
 */
export async function readIfcSpatialSource(file: File | undefined): Promise<IfcSpatialSourceRead> {
  const readStarted = performance.now();
  let bytes: ArrayBuffer | null = null;
  let fallbackText: string | null = null;
  let readError: string | undefined;
  if (file) {
    try {
      // Production uses Blob.arrayBuffer(); keep the text-only File contract
      // used by sample regressions and minimal hosts.
      const readable = file as File & {
        arrayBuffer?: () => Promise<ArrayBuffer>;
        text?: () => Promise<string>;
      };
      if (typeof readable.arrayBuffer === 'function') {
        bytes = await readable.arrayBuffer();
      } else if (typeof readable.text === 'function') {
        fallbackText = await readable.text();
      } else {
        throw new Error('IFC 文件对象不支持 arrayBuffer/text');
      }
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
  }
  const readMs = performance.now() - readStarted;
  const decodeStarted = performance.now();
  const text = fallbackText ?? (bytes == null ? null : new TextDecoder().decode(bytes));
  const decodeMs = performance.now() - decodeStarted;
  const sourceBytes =
    bytes?.byteLength ??
    (fallbackText == null ? (file?.size ?? 0) : new TextEncoder().encode(fallbackText).byteLength);
  // Drop the raw ArrayBuffer before the caller parses the next model.
  bytes = null;
  return {
    text,
    sourceBytes,
    readMs,
    decodeMs,
    found: file != null,
    ...(readError ? { error: readError } : {}),
  };
}
