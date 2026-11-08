import { analyzeDevCompilation, mergeDevGlbParts, serializeDevToGlbDetailed, type DevGlbSerializationResult } from './glbCacheService.js';
import { createWorkerProbe, NOOP_TASK } from '../measurement/workerProbe.js';
import { BufferLedger } from '../measurement/core.js';
import { parseWorkerXmlMod } from '../gim/geometry/xmlModWorkerParser.js';
import { buildDevSourceBounds, type DevSourceBounds } from './devSpatialCatalog.js';
import { ByteLru } from '../utils/byteLru.js';
import { geometryFailureKind } from '../gim/geometry/sourceGeometryError.js';
import type { XmlModDocument } from '../gim/geometry/xmlModParser.js';
import { parseDev } from '../gim/geometry/devParser.js';
import { parsePhm } from '../gim/geometry/phmParser.js';
import { trimSharedXmlModGeometries, disposeSharedXmlModMaterials } from '../viewer/xmlModGeometry.js';
const scope = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void };
const pending = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>();
const inflight = new Map<string, Promise<ArrayBuffer>>();
const blobs = new Map<string, File>();
const buffers = new BufferLedger();
let activeTrace = NOOP_TASK;
const bytesCache = new ByteLru<ArrayBuffer>(64 * 1024 * 1024, bytes => buffers.release(bytes,'source-cache'));
function cacheBytes(key:string,bytes:ArrayBuffer):void {
  if(activeTrace.enabled)buffers.retain(bytes,'source-cache');
  bytesCache.set(key,bytes,bytes.byteLength);
}
const texts = new ByteLru<string>(32 * 1024 * 1024);
const documents = new ByteLru<{ text: string; doc: XmlModDocument }>(48 * 1024 * 1024);
const assemblies = new ByteLru<{ text: string; doc: ReturnType<typeof parseDev> | ReturnType<typeof parsePhm> }>(12 * 1024 * 1024);
function assemblyParser<T>(parser: (text: string, path: string) => T,name:string): (text: string, path: string) => T {
  return (text, path) => {
    const key = path.toLowerCase(), old = assemblies.get(key);
    if (old?.text === text) { stats.documentHits++; return old.doc as T; }
    const started = performance.now(), doc = parser(text, path);
    const elapsed=performance.now()-started;activeTrace.observe(name,elapsed,{files:1});
    stages.assemblyParseMs = (stages.assemblyParseMs ?? 0) + elapsed;
    assemblies.set(key, { text, doc: doc as ReturnType<typeof parseDev> }, text.length * 8);
    return doc;
  };
}
const discovery = { parseDev: assemblyParser(parseDev,'dev.parse-dev'), parsePhm: assemblyParser(parsePhm,'dev.parse-phm') };
let readId = 0, running = false;
const files = new Map<string, File>();
let referencedFiles=new Set<string>(),fileRequests=0,referencedFileBytes=0;
function reference(path:string):void {if(!activeTrace.enabled)return;fileRequests++;const key=path.toLowerCase();if(!referencedFiles.has(key)){referencedFiles.add(key);referencedFileBytes+=files.get(path)?.size??0;}}
let stages: Record<string, number> = {};
let stats = { readRpcMs: 0, blobReadMs: 0, decodeMs: 0, validateParseMs: 0, reads: 0, rpcReads: 0, sourceHits: 0, documentHits: 0 };
async function read(path: string): Promise<ArrayBuffer> {
  const key = path.toLowerCase(), cached = bytesCache.get(key);
  if (cached) { stats.sourceHits++; return cached; }
  const old = inflight.get(key); if (old) return old;
  const started = performance.now(); stats.reads++;
  const blob = blobs.get(key);
  if (blob) {
    const trace=activeTrace;
    const promise = blob.arrayBuffer().then(bytes => { const elapsed=performance.now()-started;stats.blobReadMs += elapsed;trace.observe('dev.source-blob-wait',elapsed,{files:1,bytes:bytes.byteLength});cacheBytes(key, bytes); return bytes; });
    inflight.set(key, promise);
    try { return await promise; } finally { inflight.delete(key); }
  }
  stats.rpcReads++;
  const promise = new Promise<ArrayBuffer>((resolve, reject) => {
    const id = ++readId; pending.set(id, { resolve, reject }); scope.postMessage({ kind: 'read', id, path });
  }).then(bytes => { const elapsed=performance.now()-started;stats.readRpcMs += elapsed;activeTrace.observe('dev.source-rpc-wait',elapsed,{files:1,bytes:bytes.byteLength});cacheBytes(key, bytes); return bytes; });
  inflight.set(key, promise);
  try { return await promise; } finally { inflight.delete(key); }
}
async function text(path: string): Promise<string> {
  const key = path.toLowerCase(), cached = texts.get(key); if (cached !== undefined) return cached;
  const bytes = await read(path), started = performance.now();
  const value = new TextDecoder().decode(bytes);const elapsed=performance.now()-started;stats.decodeMs += elapsed;activeTrace.observe('dev.decode',elapsed,{bytes:bytes.byteLength});
  texts.set(key, value, value.length * 2); return value;
}
function parse(text: string, path: string): XmlModDocument {
  const key = path.toLowerCase(), cached = documents.get(key);
  if (cached?.text === text) { stats.documentHits++; return cached.doc; }
  const started = performance.now(), doc = parseWorkerXmlMod(text, path, stages);
  const elapsed=performance.now()-started;stats.validateParseMs += elapsed;activeTrace.observe('dev.parse-mod',elapsed,{files:1});
  documents.set(key, { text, doc }, text.length * 8); return doc;
}
self.onmessage = createWorkerProbe().wrap(async ({ data }, trace) => {
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
      name: path.split('/').pop()!, size, arrayBuffer: () => {reference(path);return read(path);}, text: () => {reference(path);return text(path);},
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
  if (!['compile', 'bounds', 'merge'].includes(data.kind) || running) {
    scope.postMessage({kind:'result',id:data.id,session:data.session,key:data.key,path:data.path,
      error:running?'DEV worker already running':`Unsupported DEV worker task: ${String(data.kind)}`});return;
  }
  running = true; const started = performance.now();
  activeTrace = trace;
  referencedFiles=new Set();fileRequests=0;referencedFileBytes=0;
  stages = {};
  stats = { readRpcMs: 0, blobReadMs: 0, decodeMs: 0, validateParseMs: 0, reads: 0, rpcReads: 0, sourceHits: 0, documentHits: 0 };
  try {
    let result: DevGlbSerializationResult | DevSourceBounds;
    if (data.kind === 'bounds') {
      result = await trace.measure('dev.bounds', () => buildDevSourceBounds(data.path, files, parse, discovery));
    } else if (data.kind === 'merge') {
      const bytes = await trace.measure('dev.part-merge', () => mergeDevGlbParts(data.path, data.parts as Uint8Array[]));
      result = { status: 'complete', bytes, diagnostics: {
        status: 'complete', discoveredModCount: 0, discoveredStlCount: 0, renderableModCount: 0,
        renderableStlCount: 0, emptySourceCount: 0, unsupportedSourceCount: 0, partialSourceCount: 0,
        unsupportedPrimitiveTypeCounts: {},
      } };
    } else {
      if (data.partition) {
        // The plan already discovered the whole DEV/PHM graph once. Part
        // workers reuse their exact edge slice instead of re-traversing it.
        const partition = data.partition as { referencePaths: string[]; canonicalDevPath: string; discovered: import('./modGeometryDiscovery.js').DiscoveredGeometries; allowSmallFallback?: boolean };
        result = await serializeDevToGlbDetailed(data.path, files, {
          parseXml: parse, discovery, lod: data.lod, timings: stages, onStage:trace.enabled?trace.observe.bind(trace):undefined,
          canonicalDevPath: partition.canonicalDevPath, discovered: partition.discovered,
          partition: { referencePaths: partition.referencePaths, allowSmallFallback: partition.allowSmallFallback },
        });
      } else {
        const analysis = await trace.measure('dev.discovery', () => analyzeDevCompilation(data.path, files, { discovery }));
        if (!data.noSplit && analysis.plan) {
          // Ask the main thread to run real assembly-subtree parts in parallel.
          // No template bytes are published for the plan itself.
          result = { status: 'empty', bytes: null, plan: analysis.plan, diagnostics: {
            status: 'empty', discoveredModCount: analysis.plan.modCount, discoveredStlCount: analysis.plan.stlCount,
            renderableModCount: 0, renderableStlCount: 0, emptySourceCount: 0, unsupportedSourceCount: 0,
            partialSourceCount: 0, unsupportedPrimitiveTypeCounts: {},
          } };
        } else {
          result = await serializeDevToGlbDetailed(data.path, files, {
            parseXml: parse, discovery, lod: data.lod, timings: stages, onStage:trace.enabled?trace.observe.bind(trace):undefined,
            canonicalDevPath: analysis.canonicalDevPath, discovered: analysis.discovered,
          });
        }
      }
    }
    const bytes = 'bytes' in result ? result.bytes : null;
    if(data.partition?.maxBytes&&bytes&&bytes.byteLength>data.partition.maxBytes)
      throw Error('DEV split part exceeds reserved output budget');
    if (bytes && 'bytes' in result) result.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(v => v.toString(16).padStart(2,'0')).join('');
    for (const [stage, ms] of Object.entries({ ...stats, ...stages })) {
      if (stage.endsWith('Ms')) trace.record(`dev.${stage}`, ms);
    }
    trace.memory({ name: 'source-buffer-capacity', scope: 'worker', method: 'buffer-ownership-ledger', quality: 'measured-capacity', availability: 'available', bytes: buffers.bytes, sampleDelayMs: 0 });
    trace.memory({ name: 'parsed-cache-weight', scope: 'worker', method: 'byte-lru-weight', quality: 'estimated', availability: 'available', bytes: texts.bytes + documents.bytes + assemblies.bytes, sampleDelayMs: 0 });
    trace.produced({ outputBytes: bytes?.byteLength ?? 0, reads: stats.reads, cacheHits: stats.sourceHits,uniqueFiles:referencedFiles.size,fileRequests,referencedFileBytes,
      modOccurrences:'diagnostics'in result?result.diagnostics.discoveredModCount:0,stlOccurrences:'diagnostics'in result?result.diagnostics.discoveredStlCount:0,simplifiedBooleans:stages.simplifiedBooleans??0 });
    scope.postMessage({ kind: 'result', id: data.id, session: data.session, key: data.key, path: data.path,
      result, wallMs: performance.now() - started, stages: { ...stats, ...stages } }, bytes ? [bytes.buffer as ArrayBuffer] : []);
  } catch (error) {
    trace.fail(error);
    scope.postMessage({ kind: 'result', id: data.id, session: data.session, key: data.key, path: data.path,
      error: error instanceof Error ? error.message : String(error),
      sourceErrorKind:geometryFailureKind(error),sourceEvidence: (error as { sourceEvidence?: string })?.sourceEvidence,
      wallMs: performance.now() - started, stages: { ...stats, ...stages } });
  } finally {
    // Worker owns these resources; GLB bytes have already been exported and transferred.
    // Do not retain an unbounded primitive/material cache alongside the bounded source IR caches.
    try {trimSharedXmlModGeometries(16 * 1024 * 1024);disposeSharedXmlModMaterials();}
    catch(error){console.warn('[DEV worker] resource cleanup failed',error);}
    finally {running=false;activeTrace=NOOP_TASK;}
  }
});
