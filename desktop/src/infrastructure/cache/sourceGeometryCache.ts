import type { SourceGeometryOccurrenceCatalog } from '../../gim/engineering/geometryOccurrences.js';
import { isUsableAffineMatrix } from '../../gim/geometry/affineMatrix.js';
import { yieldEngineeringCodec } from './engineeringTableJson.js';

const CONTRACT = 'source-geometry-v1';
const MAX_BYTES = 32 * 1024 * 1024;
const ENCODING = 'physical-occurrence-table-v1';
export const sourceGeometryCacheEntry = (scope: string) => `__derived__/${CONTRACT}/${scope}.bin`;
/** Source SHA and inventory bind this directory; no category/rule/tree versions. */
export async function encodeSourceGeometryCache(
  scope: string,
  catalog: SourceGeometryOccurrenceCatalog,
): Promise<Uint8Array | undefined> {
  const encoder = new TextEncoder(),
    strings: string[] = [],
    indices = new Map<string, number>();
  let characters = 0;
  const intern = (value: string) => {
    let index = indices.get(value);
    if (index === undefined) {
      index = strings.length;
      indices.set(value, index);
      strings.push(value);
      characters += value.length;
    }
    return index;
  };
  const occurrences = [];
  for (const row of catalog.occurrences) {
    occurrences.push([
      intern(row.id),
      intern(row.sourceId),
      intern(row.sourceContextId),
      intern(row.devPath),
      intern(row.name),
      row.placementMatrix,
    ]);
    if (characters > MAX_BYTES) return; // UTF-8/JSON cannot be shorter than this lower bound.
  }
  const diagnostics = catalog.diagnostics.map((row) => [
    intern(row.sourceContextId),
    intern(row.documentPath),
    intern(row.reason),
  ]);
  if (characters > MAX_BYTES) return;
  const reservedHeader = encoder.encode(
    JSON.stringify({ contract: CONTRACT, scope, bodyBytes: MAX_BYTES }),
  ).length;
  if (reservedHeader > 4096) return;
  const chunks: Uint8Array[] = [];
  let bodyBytes = 0;
  const append = (text: string) => {
    const bytes = encoder.encode(text);
    bodyBytes += bytes.length;
    if (bodyBytes + reservedHeader + 4 > MAX_BYTES) return false;
    chunks.push(bytes);
    return true;
  };
  if (!append(`{"encoding":"${ENCODING}","strings":[`)) return;
  for (const [name, rows] of [
    ['strings', strings],
    ['occurrences', occurrences],
    ['diagnostics', diagnostics],
  ] as const) {
    if (name !== 'strings' && !append(`],"${name}":[`)) return;
    for (let i = 0; i < rows.length; i++) {
      if (!append((i ? ',' : '') + JSON.stringify(rows[i]))) return;
      if (i > 0 && i % 256 === 0) await yieldEngineeringCodec();
    }
  }
  if (!append(']}')) return;
  const header = encoder.encode(JSON.stringify({ contract: CONTRACT, scope, bodyBytes }));
  const bytes = new Uint8Array(4 + header.length + bodyBytes);
  new DataView(bytes.buffer).setUint32(0, header.length, true);
  bytes.set(header, 4);
  let offset = 4 + header.length;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export function decodeSourceGeometryCache(
  bytes: Uint8Array,
  scope: string,
  entries: ReadonlyMap<string, unknown>,
): SourceGeometryOccurrenceCatalog {
  if (bytes.byteLength < 4 || bytes.byteLength > MAX_BYTES)
    throw Error('Physical source cache exceeds budget');
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (size > 4096 || size > bytes.length - 4) throw Error('Invalid physical source cache header');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + size))) as {
      contract?: unknown;
      scope?: unknown;
      bodyBytes?: unknown;
    } | null,
    body = bytes.subarray(4 + size);
  if (
    header?.contract !== CONTRACT ||
    header.scope !== scope ||
    header.bodyBytes !== body.byteLength
  )
    throw Error('Physical source cache identity / length mismatch');
  const table = JSON.parse(new TextDecoder().decode(body)) as {
    encoding?: unknown;
    strings?: unknown[];
    occurrences?: unknown[];
    diagnostics?: unknown[];
  } | null;
  if (
    table?.encoding !== ENCODING ||
    !Array.isArray(table.strings) ||
    !Array.isArray(table.occurrences) ||
    !Array.isArray(table.diagnostics)
  )
    throw Error('Invalid physical source cache table');
  const { strings, occurrences, diagnostics } = table;
  const string = (index: unknown): string => {
    if (!Number.isSafeInteger(index) || (index as number) < 0)
      throw Error('Invalid physical source string reference');
    const value = strings[index as number];
    if (typeof value !== 'string') throw Error('Invalid physical source string reference');
    return value;
  };
  const catalog: SourceGeometryOccurrenceCatalog = {
    occurrences: occurrences.map((row) => {
      if (!Array.isArray(row) || row.length !== 6) throw Error('Invalid physical source row');
      return {
        id: string(row[0]),
        sourceId: string(row[1]),
        sourceContextId: string(row[2]),
        devPath: string(row[3]),
        name: string(row[4]),
        placementMatrix:
          row[5] as SourceGeometryOccurrenceCatalog['occurrences'][number]['placementMatrix'],
      };
    }),
    diagnostics: diagnostics.map((row) => {
      if (!Array.isArray(row) || row.length !== 3)
        throw Error('Invalid physical source diagnostic row');
      return {
        sourceContextId: string(row[0]),
        documentPath: string(row[1]),
        reason: string(row[2]) as SourceGeometryOccurrenceCatalog['diagnostics'][number]['reason'],
      };
    }),
  };
  const ids = new Set<string>();
  for (const row of catalog.occurrences) {
    if (
      typeof row.id !== 'string' ||
      ids.has(row.id) ||
      row.sourceId !== row.id ||
      typeof row.sourceContextId !== 'string' ||
      typeof row.name !== 'string' ||
      !entries.has(row.devPath) ||
      !isUsableAffineMatrix(row.placementMatrix)
    )
      throw Error('Invalid physical source cache occurrence');
    ids.add(row.id);
  }
  for (const row of catalog.diagnostics)
    if (
      typeof row.sourceContextId !== 'string' ||
      typeof row.documentPath !== 'string' ||
      typeof row.reason !== 'string'
    )
      throw Error('Invalid physical source diagnostic');
  return catalog;
}
