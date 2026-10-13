import { invokeTimed } from './invokeTimed.js';

export interface ParseCopyReceipt { size: number; sha256: string }
interface CopyEntry { path: string; offset: number; size: number }
const MAX_BYTES = 32 * 1024 * 1024 + 4;

/** Receipt is captured from this extraction, never restored as an authoritative source. */
export async function decodeSubstationParseCopy(
  buffer: ArrayBuffer, receipt: ParseCopyReceipt, expected: Map<string, File>,
): Promise<Map<string, Uint8Array>> {
  if (buffer.byteLength !== receipt.size || buffer.byteLength < 4 || buffer.byteLength > MAX_BYTES) throw Error('parse copy size mismatch');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
  if (hash !== receipt.sha256) throw Error('parse copy identity mismatch');
  const indexBytes = new DataView(buffer).getUint32(0, true);
  if (indexBytes > 16 * 1024 * 1024 || 4 + indexBytes > buffer.byteLength) throw Error('parse copy index truncated');
  const entries: CopyEntry[] = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, indexBytes)));
  if (!Array.isArray(entries) || entries.length > 65536) throw Error('parse copy index invalid');
  const base = 4 + indexBytes, result = new Map<string, Uint8Array>();
  let nextOffset = 0;
  for (const entry of entries) {
    const file = expected.get(entry.path);
    if (!file || /\.ifc$/i.test(entry.path) || file.size > 256 * 1024 || file.size !== entry.size
      || !Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.size)
      || entry.offset !== nextOffset || entry.size < 0 || base + entry.offset + entry.size > buffer.byteLength
      || result.has(entry.path)) throw Error('parse copy entry mismatch');
    result.set(entry.path, new Uint8Array(buffer, base + entry.offset, entry.size));
    nextOffset += entry.size;
  }
  if (base + nextOffset !== buffer.byteLength) throw Error('parse copy trailing bytes');
  return result;
}

export async function readSubstationParseCopy(projectId: number, receipt: ParseCopyReceipt, expected: Map<string, File>) {
  return decodeSubstationParseCopy(await invokeTimed<ArrayBuffer>('read_substation_parse_copy', { projectId }), receipt, expected);
}
