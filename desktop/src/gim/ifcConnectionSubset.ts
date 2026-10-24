import { decodeIfcString } from './ifcSpatialParser.js';

interface RecordSpan { id: number; start: number; body: number; end: number; typeStart: number; typeEnd: number }
export interface IndexedOpening { id: number; host: number; opening: number; start: number; end: number }
export interface EarlyConnectionInput {
  bytes: Uint8Array<ArrayBuffer>;
  expressId: number;
  indexedRecords: number;
  subsetRecords: number;
  indexBytes: number;
  indexingMs: number;
  buildMs: number;
  openings: IndexedOpening[];
}
const decode = new TextDecoder();
const ascii = new TextDecoder('latin1');
const space = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
const digit = (c: number): boolean => c >= 48 && c <= 57;
const letter = (c: number): boolean => c >= 65 && c <= 90 || c >= 97 && c <= 122 || digit(c) || c === 95;

/** Quoted text and block comments cannot end a STEP statement. */
function statementEnd(bytes: Uint8Array, start: number, limit: number): number {
  let quoted = false, comment = false;
  for (let p = start; p < limit; p++) {
    const c = bytes[p], next = bytes[p + 1];
    if (comment) { if (c === 42 && next === 47) { comment = false; p++; } continue; }
    if (quoted) { if (c === 39) { if (next === 39) p++; else quoted = false; } continue; }
    if (c === 47 && next === 42) { comment = true; p++; }
    else if (c === 39) quoted = true;
    else if (c === 59) return p + 1;
  }
  throw Error('Incomplete IFC STEP statement');
}
function dataStart(bytes: Uint8Array): number {
  let p = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? 3 : 0;
  const limit = Math.min(bytes.length, 65536);
  let header = false, ended = false;
  while (p < limit) {
    const end = statementEnd(bytes, p, limit);
    const text = ascii.decode(bytes.subarray(p, end)).replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
    if (text === 'HEADER;') header = true;
    if (text === 'ENDSEC;' && header) ended = true;
    if (text === 'DATA;' && ended) return end;
    p = end;
  }
  throw Error('Standard IFC HEADER/DATA boundary unavailable');
}
function isType(bytes: Uint8Array, row: RecordSpan, type: string): boolean {
  if (row.typeEnd - row.typeStart !== type.length) return false;
  for (let i = 0; i < type.length; i++) if ((bytes[row.typeStart + i] & 223) !== type.charCodeAt(i)) return false;
  return true;
}
/** Native indexOf handles ordinary numeric geometry records. Only records
 * containing strings/comments need a byte-by-byte lexical walk. */
function scan(bytes: Uint8Array, start: number, limit: number, visit: (row: RecordSpan) => boolean): number {
  let p = start, quote = bytes.indexOf(39, p), slash = bytes.indexOf(47, p), count = 0;
  while (p < limit) {
    while (space(bytes[p])) p++;
    if (bytes[p] === 47 && bytes[p + 1] === 42) {
      let end = bytes.indexOf(42, p + 2);
      while (end >= 0 && bytes[end + 1] !== 47) end = bytes.indexOf(42, end + 1);
      if (end < 0) throw Error('Unclosed IFC comment');
      p = end + 2; continue;
    }
    if (p >= limit) break;
    if (bytes[p] !== 35) {
      // Additional DATA sections and non-record syntax are not optimized.
      if (bytes.length - p > 65536) throw Error('Unsupported IFC DATA syntax');
      const tail = ascii.decode(bytes.subarray(p)).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (limit === bytes.length && !/^ENDSEC\s*;\s*END-ISO-10303-21\s*;\s*$/i.test(tail)) throw Error('Unsupported IFC DATA trailer');
      break;
    }
    const recordStart = p++;
    let id = 0;
    if (!digit(bytes[p])) throw Error('Invalid IFC STEP identity');
    while (digit(bytes[p])) id = id * 10 + bytes[p++] - 48;
    if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff) throw Error('IFC STEP identity exceeds index range');
    while (space(bytes[p])) p++;
    if (bytes[p++] !== 61) throw Error('Invalid IFC STEP record');
    while (space(bytes[p])) p++;
    const typeStart = p;
    while (letter(bytes[p])) p++;
    const typeEnd = p;
    while (space(bytes[p])) p++;
    if (bytes[p++] !== 40 || typeEnd === typeStart) throw Error('Unsupported IFC complex record');
    const body = p;
    let end = bytes.indexOf(59, p);
    if (end < 0) throw Error('Unclosed IFC STEP record');
    if (quote >= 0 && quote < end || slash >= 0 && slash < end) end = statementEnd(bytes, recordStart, bytes.length) - 1;
    end++;
    if (end > limit) break;
    const row = {id, start: recordStart, body, end, typeStart, typeEnd};
    count++;
    if (!visit(row)) return count;
    p = end;
    if (quote >= 0 && quote < p) quote = bytes.indexOf(39, p);
    if (slash >= 0 && slash < p) slash = bytes.indexOf(47, p);
  }
  return count;
}
/** Split only a selected record. Preserve source bytes for output; comments
 * and quoted references are excluded from graph traversal. */
function fields(bytes: Uint8Array, row: Pick<RecordSpan, 'body' | 'end'>): string[] {
  const text = decode.decode(bytes.subarray(row.body, row.end));
  let quote = false, comment = false, depth = 0, field = '', closed = false;
  const result: string[] = [];
  for (let p = 0; p < text.length; p++) {
    const c = text[p], next = text[p + 1];
    if (comment) { if (c === '*' && next === '/') { comment = false; p++; } continue; }
    if (quote) { field += c; if (c === "'") { if (next === "'") field += text[++p]; else quote = false; } continue; }
    if (c === '/' && next === '*') { comment = true; p++; continue; }
    if (c === "'") { quote = true; field += c; continue; }
    if (c === '(') depth++;
    if (c === ')') { if (!depth) { result.push(field.trim()); closed = true; break; } depth--; }
    if (c === ',' && !depth) { result.push(field.trim()); field = ''; } else field += c;
  }
  if (!closed || quote || comment || depth) throw Error('Malformed IFC dependency record');
  return result;
}
function refs(text: string): number[] {
  return [...text.replace(/'(?:[^']|'')*'/g, "''").matchAll(/#(\d+)/g)].map(match => Number(match[1]));
}
function nameOf(args: string[]): string {
  const value = args[2] ?? '';
  return /^'(?:[^']|'')*'$/.test(value) ? decodeIfcString(value.slice(1, -1).replace(/''/g, "'")) : '';
}

/** Optional bounded first-object acceleration, never a replacement parser.
 * No source file, ID, unit, placement or numeric token is rewritten. Unsupported
 * syntax, closure/budget failure or absence of a cheap candidate uses full IFC. */
export function buildEarlyConnectionInput(bytes: Uint8Array, connectionTypes: ReadonlySet<string>,
  accepts: (type: string, name: string) => boolean, minimumBytes = 64 * 1024 * 1024): EarlyConnectionInput | null {
  if (bytes.length < minimumBytes || bytes.length > 512 * 1024 * 1024) return null;
  const start = dataStart(bytes);
  const candidates = [...connectionTypes, 'IFCBUILDINGELEMENTPROXY'];
  const candidate = (row: RecordSpan): string | undefined => candidates.find(type => isType(bytes, row, type));
  let cheap = false;
  scan(bytes, start, Math.min(bytes.length, start + 4 * 1024 * 1024), row => {
    const type = candidate(row);
    if (type && accepts(type, nameOf(fields(bytes, row)))) { cheap = true; return false; }
    return true;
  });
  if (!cheap) return null;
  const began = performance.now(), pages = new Map<number, Uint32Array>();
  const inverse = new Map<number, number[]>(), projects: number[] = [], openings: IndexedOpening[] = [];
  let first = Infinity, inverseEdges = 0;
  const indexedRecords = scan(bytes, start, bytes.length, row => {
    const key = Math.floor(row.id / 65536), offset = row.id % 65536 * 2;
    let page = pages.get(key);
    if (!page) { if (pages.size === 128) throw Error('IFC early index exceeds 64 MiB'); pages.set(key, page = new Uint32Array(131072)); }
    if (page[offset]) throw Error('Duplicate IFC STEP identity');
    page[offset] = row.start; page[offset + 1] = row.end;
    const type = candidate(row);
    if (type && accepts(type, nameOf(fields(bytes, row)))) first = Math.min(first, row.id);
    if (isType(bytes, row, 'IFCPROJECT')) projects.push(row.id);
    if (isType(bytes, row, 'IFCSTYLEDITEM') || isType(bytes, row, 'IFCRELASSOCIATESMATERIAL') || isType(bytes, row, 'IFCRELDEFINESBYTYPE')) {
      const args = fields(bytes, row), targets = refs(args[isType(bytes, row, 'IFCSTYLEDITEM') ? 0 : 4] ?? '');
      for (const target of targets) {
        if (++inverseEdges > 500000) throw Error('IFC early appearance index exceeds budget');
        const values = inverse.get(target) ?? []; values.push(row.id); inverse.set(target, values);
      }
    }
    if (isType(bytes, row, 'IFCRELVOIDSELEMENT')) {
      const args = fields(bytes, row), host = /^#(\d+)$/.exec(args[4] ?? ''), opening = /^#(\d+)$/.exec(args[5] ?? '');
      if (args.length !== 6 || !host || !opening) throw Error('Invalid IFC opening relation');
      openings.push({id: row.id, host: Number(host[1]), opening: Number(opening[1]), start: row.start, end: row.end});
    }
    return true;
  });
  const indexed = performance.now();
  if (!Number.isFinite(first) || projects.length !== 1) throw Error('IFC early source project/candidate unavailable');
  const selected = new Set<number>(), queue = [first, ...projects];
  let outputBytes = start + 64;
  const span = (id: number): readonly [number, number] => {
    const page = pages.get(Math.floor(id / 65536)), offset = id % 65536 * 2;
    if (!page?.[offset] || !page[offset + 1]) throw Error(`Missing IFC dependency #${id}`);
    return [page[offset], page[offset + 1]];
  };
  while (queue.length) {
    const id = queue.pop()!;
    if (selected.has(id)) continue;
    const [from, to] = span(id);
    outputBytes += to - from + 1;
    if (selected.size >= 100000 || outputBytes > 8 * 1024 * 1024) throw Error('IFC early closure exceeds budget');
    selected.add(id);
    const body = bytes.indexOf(40, from) + 1;
    for (const value of refs(fields(bytes, {body, end: to}).join(','))) queue.push(value);
    for (const reverse of inverse.get(id) ?? []) queue.push(reverse);
  }
  const footer = new TextEncoder().encode('\nENDSEC;\nEND-ISO-10303-21;\n');
  const ordered = [...selected].sort((a, b) => a - b);
  const size = start + 1 + footer.length + ordered.reduce((n, id) => { const [a,b] = span(id); return n + b-a+1; }, 0);
  const subset = new Uint8Array(size);
  subset.set(bytes.subarray(0, start)); let offset = start; subset[offset++] = 10;
  for (const id of ordered) { const [a,b] = span(id); subset.set(bytes.subarray(a,b),offset); offset += b-a; subset[offset++] = 10; }
  subset.set(footer, offset);
  return {bytes: subset, expressId: first, indexedRecords, subsetRecords: selected.size,
    indexBytes: pages.size * 524288, indexingMs: indexed-began, buildMs: performance.now()-indexed, openings};
}

/** Apply exactly the indexed derived opening policy after source hashing. */
export function omitIndexedOpenings(bytes: Uint8Array, openings: readonly IndexedOpening[]): void {
  for (const row of openings) for (let p = row.start; p < row.end; p++) if (bytes[p] !== 10 && bytes[p] !== 13) bytes[p] = 32;
}
