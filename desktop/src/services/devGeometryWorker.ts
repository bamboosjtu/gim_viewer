import { serializeDevToGlbDetailed } from './glbCacheService.js';
import { parseWorkerXmlMod } from '../gim/geometry/xmlModWorkerParser.js';
import { buildDevSourceBounds } from './devSpatialCatalog.js';
import { ByteLru } from '../utils/byteLru.js';
import type { XmlModDocument } from '../gim/geometry/xmlModParser.js';
import { parseDev } from '../gim/geometry/devParser.js';
import { parsePhm } from '../gim/geometry/phmParser.js';
import { trimSharedXmlModGeometries, disposeSharedXmlModMaterials } from '../viewer/xmlModGeometry.js';
const scope = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void };
const pending = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>();
const inflight = new Map<string, Promise<ArrayBuffer>>();
const blobs = new Map<string, File>();
const bytesCache = new ByteLru<ArrayBuffer>(64 * 1024 * 1024);
const texts = new ByteLru<string>(32 * 1024 * 1024);
const documents = new ByteLru<{ text: string; doc: XmlModDocument }>(48 * 1024 * 1024);
const assemblies = new ByteLru<{ text: string; doc: ReturnType<typeof parseDev> | ReturnType<typeof parsePhm> }>(12 * 1024 * 1024);
function assemblyParser<T>(parser: (text: string, path: string) => T): (text: string, path: string) => T {
  return (text, path) => {
    const key = path.toLowerCase(), old = assemblies.get(key);
    if (old?.text === text) { stats.documentHits++; return old.doc as T; }
    const started = performance.now(), doc = parser(text, path);
    stages.assemblyParseMs = (stages.assemblyParseMs ?? 0) + performance.now() - started;
    assemblies.set(key, { text, doc: doc as ReturnType<typeof parseDev> }, text.length * 8);
    return doc;
  };
}
const discovery = { parseDev: assemblyParser(parseDev), parsePhm: assemblyParser(parsePhm) };
let readId = 0, running = false;
const files = new Map<string, File>();
let stages: Record<string, number> = {};
let stats = { readRpcMs: 0, blobReadMs: 0, decodeMs: 0, validateParseMs: 0, reads: 0, rpcReads: 0, sourceHits: 0, documentHits: 0 };
async function read(path: string): Promise<ArrayBuffer> {
  const key = path.toLowerCase(), cached = bytesCache.get(key);
  if (cached) { stats.sourceHits++; return cached; }
  const old = inflight.get(key); if (old) return old;
  const started = performance.now(); stats.reads++;
  const blob = blobs.get(key);
  if (blob) {
    const promise = blob.arrayBuffer().then(bytes => { stats.blobReadMs += performance.now() - started; bytesCache.set(key, bytes, bytes.byteLength); return bytes; });
    inflight.set(key, promise);
    try { return await promise; } finally { inflight.delete(key); }
  }
  stats.rpcReads++;
  const promise = new Promise<ArrayBuffer>((resolve, reject) => {
    const id = ++readId; pending.set(id, { resolve, reject }); scope.postMessage({ kind: 'read', id, path });
  }).then(bytes => { stats.readRpcMs += performance.now() - started; bytesCache.set(key, bytes, bytes.byteLength); return bytes; });
  inflight.set(key, promise);
  try { return await promise; } finally { inflight.delete(key); }
}
async function text(path: string): Promise<string> {
  const key = path.toLowerCase(), cached = texts.get(key); if (cached !== undefined) return cached;
  const bytes = await read(path), started = performance.now();
  const value = new TextDecoder().decode(bytes); stats.decodeMs += performance.now() - started;
  texts.set(key, value, value.length * 2); return value;
}
function parse(text: string, path: string): XmlModDocument {
  const key = path.toLowerCase(), cached = documents.get(key);
  if (cached?.text === text) { stats.documentHits++; return cached.doc; }
  const started = performance.now(), doc = parseWorkerXmlMod(text, path, stages);
  stats.validateParseMs += performance.now() - started;
  documents.set(key, { text, doc }, text.length * 8); return doc;
}
self.onmessage = async ({ data }) => {
  if (data.kind === 'read-result') {
    const task = pending.get(data.id); pending.delete(data.id);
    if (data.error) task?.reject(new Error(data.error)); else task?.resolve(data.bytes); return;
  }
  if (data.kind === 'init') {
    const divisor = Math.min(2, Math.max(1, Number(data.cacheDivisor) || 1));
    bytesCache.budget /= divisor; texts.budget /= divisor; documents.budget /= divisor; assemblies.budget /= divisor;
    for (const [path, size, blob] of data.files as [string, number, File | null][]) {
      if (blob instanceof File) blobs.set(path.toLowerCase(), blob);
      files.set(path, {
      name: path.split('/').pop()!, size, arrayBuffer: () => read(path), text: () => text(path),
      } as File);
    }
    return;
  }
  if (data.kind === 'sources') {
    for (const [path, , blob] of data.files as [string, number, File][]) {
      if (blob instanceof File && files.has(path)) blobs.set(path.toLowerCase(), blob);
    }
    return;
  }
  if (!['compile', 'bounds'].includes(data.kind) || running) {
    scope.postMessage({kind:'result',id:data.id,session:data.session,key:data.key,path:data.path,
      error:running?'DEV worker already running':`Unsupported DEV worker task: ${String(data.kind)}`});return;
  }
  running = true; const started = performance.now();
  stages = {};
  stats = { readRpcMs: 0, blobReadMs: 0, decodeMs: 0, validateParseMs: 0, reads: 0, rpcReads: 0, sourceHits: 0, documentHits: 0 };
  try {
    const result = data.kind === 'bounds' ? await buildDevSourceBounds(data.path, files, parse, discovery)
      : await serializeDevToGlbDetailed(data.path, files, { parseXml: parse, discovery, lod: data.lod, timings: stages });
    const bytes = 'bytes' in result ? result.bytes : null;
    if (bytes && 'bytes' in result) result.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(v => v.toString(16).padStart(2,'0')).join('');
    scope.postMessage({ kind: 'result', id: data.id, session: data.session, key: data.key, path: data.path,
      result, wallMs: performance.now() - started, stages: { ...stats, ...stages } }, bytes ? [bytes.buffer as ArrayBuffer] : []);
  } catch (error) {
    scope.postMessage({ kind: 'result', id: data.id, session: data.session, key: data.key, path: data.path,
      error: error instanceof Error ? error.message : String(error), sourceEvidence: (error as { sourceEvidence?: string })?.sourceEvidence,
      wallMs: performance.now() - started, stages: { ...stats, ...stages } });
  } finally {
    // Worker owns these resources; GLB bytes have already been exported and transferred.
    // Do not retain an unbounded primitive/material cache alongside the bounded source IR caches.
    try {trimSharedXmlModGeometries(16 * 1024 * 1024);disposeSharedXmlModMaterials();}
    catch(error){console.warn('[DEV worker] resource cleanup failed',error);}
    finally {running=false;}
  }
};
