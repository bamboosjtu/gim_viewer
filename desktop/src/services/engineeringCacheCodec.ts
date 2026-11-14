import {engineeringSourceRecords} from '../gim/engineering/sourceGraph.js';
import { ENGINEERING_SOURCE_VERSION, type EngineeringSources } from '../gim/engineering/buildSources.js';
import { ENGINEERING_RECOGNITION_VERSION as ENGINEERING_RULES_VERSION } from '../gim/engineering/sourceEvidence.js';
import { assertEngineeringPartition } from '../engineering/validate.js';
import type { EngineeringSnapshot } from '../engineering/types.js';
import { ENGINEERING_NAVIGATION_VERSION } from '../gim/engineering/navigation.js';
import { SPATIAL_PROJECTION_POLICY } from './projections/compositionSpatial.js';
import { ENGINEERING_COMPOSITION_VERSION } from '../engineering/composition.js';
import { INVENTORY_TEMPLATE_VERSION } from '../engineering/inventoryTemplate.js';
import { SOURCE_TREE_TEMPLATE_VERSION } from '../gim/engineering/sourceProjection.js';
import { ENGINEERING_CATALOG_VERSION } from '../engineering/catalogLabels.js';
import { packEngineeringSource, unpackEngineeringSourceAsync } from './engineeringSourceCodec.js';
import {engineeringTableChunks,parseEngineeringTable,releaseEngineeringBytes,yieldEngineeringCodec} from './engineeringTableJson.js';

export const ENGINEERING_ENTITY_SCHEMA = 'engineering-entity-v1';
export const MAX_ENGINEERING_CACHE_BYTES = 384 * 1024 * 1024;
/** JSON bodies above this size are split into independently compressed parts.
 * The compressed artifact still respects MAX_ENGINEERING_CACHE_BYTES. */
export const MAX_ENGINEERING_CACHE_PLAIN_BYTES = 1024 * 1024 * 1024;
const CACHE_PART_BYTES = 64 * 1024 * 1024;
export interface EngineeringCacheIdentity {
  sourceSha256: string;
  /** Source decoding / IFC semantic parser contracts, independent of geometry. */
  parserVersion: string;
  entries: readonly string[];
}
export interface EngineeringSourceArtifact { sources: EngineeringSources; digest: string }
type Kind = 'sources' | 'entities' | 'navigation';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
const requireValid = (ok: unknown, reason: string): void => { if (!ok) throw Error(`工程缓存无效：${reason}`); };
const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(v => v.toString(16).padStart(2, '0')).join('');
const contract = (kind: Kind) => kind === 'sources' ? ENGINEERING_SOURCE_VERSION : kind === 'entities' ? `${ENGINEERING_ENTITY_SCHEMA}|${ENGINEERING_RULES_VERSION}|${ENGINEERING_CATALOG_VERSION}` : `${ENGINEERING_NAVIGATION_VERSION}|${ENGINEERING_RULES_VERSION}|${ENGINEERING_COMPOSITION_VERSION}|${INVENTORY_TEMPLATE_VERSION}|${SOURCE_TREE_TEMPLATE_VERSION}|${ENGINEERING_CATALOG_VERSION}|${SPATIAL_PROJECTION_POLICY.version}`;
const manifestDigest = (id: EngineeringCacheIdentity) => sha(encoder.encode(JSON.stringify([...id.entries].sort())));

export function engineeringCacheEntry(id: EngineeringCacheIdentity, kind: Kind): string {
  requireValid(/^[a-f\d]{64}$/i.test(id.sourceSha256), 'source identity');
  return `__derived__/${kind === 'sources' ? ENGINEERING_SOURCE_VERSION : kind === 'entities' ? ENGINEERING_ENTITY_SCHEMA : ENGINEERING_NAVIGATION_VERSION}/${id.sourceSha256.toLowerCase()}.bin`;
}

async function gzipStream(input:ReadableStream<BufferSource>,limit=MAX_ENGINEERING_CACHE_BYTES):Promise<Uint8Array>{
  const reader = input.pipeThrough(new CompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw Error('工程缓存无效：expanded size');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Restore into the validated final allocation. Retaining every expanded
 * part and then concatenating them doubles the largest warm input. */
async function expandInto(bytes:Uint8Array,target:Uint8Array,offset:number):Promise<number>{
  const input=new ReadableStream<BufferSource>({start(controller){controller.enqueue(bytes as BufferSource);controller.close();}});
  const reader=input.pipeThrough(new DecompressionStream('gzip')).getReader();
  try{
    for(;;){
      const next=await reader.read();if(next.done)return offset;
      if(next.value.length>target.length-offset)throw Error('工程缓存无效：expanded size');
      target.set(next.value,offset);offset+=next.value.length;
    }
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
}

async function encode(kind: Kind, payload: unknown, id: EngineeringCacheIdentity, sourceDigest?: string): Promise<{ bytes: Uint8Array; digest: string }> {
  engineeringCacheEntry(id, kind);
  requireValid(id.parserVersion.length > 0, 'parser contract');
  // Compression consumes canonical chunks directly. Only one 64 MiB logical
  // part is active; there is no model-sized plain buffer or final plain copy.
  const chunks=engineeringTableChunks(packEngineeringSource(payload),MAX_ENGINEERING_CACHE_PLAIN_BYTES,undefined,undefined,undefined,true);
  let next=await chunks.next(),plainBytes=0,bodyLength=0;
  const parts:Uint8Array[]=[];
  while(!next.done){
    let remaining=CACHE_PART_BYTES;
    const input=new ReadableStream<BufferSource>({async pull(controller){
      try{
        if(next.done||remaining===0){controller.close();return;}
        const length=Math.min(remaining,next.value.length),piece=next.value.subarray(0,length);
        controller.enqueue(piece as BufferSource);plainBytes+=length;remaining-=length;
        if(length===next.value.length)next=await chunks.next();
        else next={done:false,value:next.value.subarray(length)};
      }catch(error){controller.error(error);}
    }});
    const part=await gzipStream(input);parts.push(part);bodyLength+=part.length;
    requireValid(bodyLength<=MAX_ENGINEERING_CACHE_BYTES,'encoded size');
  }
  const body=parts.length===1?parts[0]:new Uint8Array(bodyLength);
  if(parts.length>1){let offset=0;for(const part of parts){body.set(part,offset);offset+=part.length;}}
  const partSizes=parts.length>1?parts.map(part=>part.length):undefined;
  requireValid(body.length <= MAX_ENGINEERING_CACHE_BYTES, 'encoded size');
  const digest = await sha(body);
  const header = encoder.encode(JSON.stringify({ kind, contract: contract(kind), source: id.sourceSha256.toLowerCase(), parser: id.parserVersion,
    manifest: await manifestDigest(id), complete: true, encoding: kind==='sources'?'gzip':'gzip-table-v1', plainBytes, bytes: body.length,
    ...(partSizes && partSizes.length > 1 ? { parts: partSizes } : {}), digest, sourceDigest }));
  const bytes = new Uint8Array(4 + header.length + body.length);
  new DataView(bytes.buffer).setUint32(0, header.length, true); bytes.set(header, 4); bytes.set(body, 4 + header.length);
  return { bytes, digest };
}

async function decode(kind: Kind, bytes: Uint8Array, id: EngineeringCacheIdentity, sourceDigest?: string): Promise<{ payload: unknown; digest: string }> {
  engineeringCacheEntry(id, kind);
  requireValid(bytes.length >= 4 && bytes.length <= MAX_ENGINEERING_CACHE_BYTES + 4100, 'size');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  requireValid(length > 0 && length <= 4096 && 4 + length < bytes.length, 'header length');
  const header: unknown = JSON.parse(decoder.decode(bytes.subarray(4, 4 + length)));
  requireValid(record(header), 'header');
  const meta = header as Record<string, unknown>, body = bytes.subarray(4 + length);
  requireValid(meta.kind === kind && meta.contract === contract(kind) && meta.source === id.sourceSha256.toLowerCase() && meta.parser === id.parserVersion && meta.complete === true && meta.encoding === (kind==='sources'?'gzip':'gzip-table-v1'), 'identity / version');
  requireValid(meta.manifest === await manifestDigest(id) && meta.sourceDigest === sourceDigest, 'input dependencies');
  requireValid(meta.bytes === body.length && Number.isSafeInteger(meta.plainBytes) && (meta.plainBytes as number) > 0 && (meta.plainBytes as number) <= MAX_ENGINEERING_CACHE_PLAIN_BYTES, 'body length');
  requireValid(meta.digest === await sha(body), 'checksum');
  const partSizes = meta.parts as number[] | undefined;
  if(partSizes!==undefined){
    requireValid(Array.isArray(partSizes) && partSizes.length > 1 && partSizes.length <= 128
      && partSizes.every(size => Number.isSafeInteger(size) && size > 0 && size <= MAX_ENGINEERING_CACHE_BYTES)
      && partSizes.reduce((sum, size) => sum + (size as number), 0) === body.length, 'parts');
  }
  let plain=new Uint8Array(meta.plainBytes as number),expanded=0;
  if (partSizes === undefined) expanded=await expandInto(body,plain,0);
  else {
    let offset = 0;
    for (const size of partSizes) {
      expanded=await expandInto(body.subarray(offset,offset+(size as number)),plain,expanded);
      offset+=size as number;
    }
  }
  requireValid(expanded === meta.plainBytes, 'expanded length');
  const parsed=await parseEngineeringTable(plain);
  releaseEngineeringBytes(plain);
  plain=new Uint8Array();
  return { payload: await unpackEngineeringSourceAsync(parsed,()=>true,yieldEngineeringCodec,true), digest: meta.digest as string };
}

/** Sizes of a newly encoded artifact, without decoding its model again. */
export function engineeringCacheSizes(bytes:Uint8Array):{plainBytes:number;encodedBytes:number}{
  const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
  const header=JSON.parse(decoder.decode(bytes.subarray(4,4+length))) as {plainBytes:number};
  return {plainBytes:header.plainBytes,encodedBytes:bytes.byteLength};
}

export function assertEngineeringSources(value: unknown): asserts value is EngineeringSources {
  requireValid(record(value) && value.version === ENGINEERING_SOURCE_VERSION && value.complete === true && Array.isArray(value.incompleteReasons) && value.incompleteReasons.length === 0, 'incomplete sources');
  const data = value as EngineeringSources;
  requireValid(record(data.graph)&&(data.graph.attributeRecords===undefined||Array.isArray(data.graph.attributeRecords)&&data.graph.attributeRecords.every(r=>r.attributeOnly===true&&r.track==='dev'&&!r.devOccurrence&&typeof r.attributeContextId==='string')),'attribute source addresses');
  requireValid(record(data.graph) && Array.isArray(data.graph.records) && Array.isArray(data.graph.documents) && Array.isArray(data.graph.cbmOccurrences) && Array.isArray(data.graph.aliases) && Array.isArray(data.graph.references) && strings(data.graph.ifcPaths) && Array.isArray(data.graph.diagnostics) && Array.isArray(data.ifcRecords) && Array.isArray(data.ifcMatches) && Array.isArray(data.models) && Array.isArray(data.spatialNodes), 'source graph');
  const ids = new Set<string>();
  for (const source of engineeringSourceRecords(data.graph,data.ifcRecords)) {
    requireValid(record(source) && typeof source.id === 'string' && source.id && !ids.has(source.id) && typeof source.name === 'string' && typeof source.source === 'string' && typeof source.source_type === 'string' && typeof source.parent === 'string' && Array.isArray(source.properties) && strings(source.sources) && strings(source.context), 'source record');
    requireValid(source.properties.every(p => record(p) && typeof p.value === 'string' && (p.keys === undefined || strings(p.keys))), 'source properties');
    requireValid(source.nameEvidence === undefined || Array.isArray(source.nameEvidence) && source.nameEvidence.every(n => record(n)
      && ['object','engineering','family','source'].includes(n.kind) && typeof n.value === 'string' && typeof n.evidenceId === 'string' && n.evidenceId.length > 0), 'source name evidence');
    ids.add(source.id);
  }
  const cbm = new Set(data.graph.cbmOccurrences.map(node => node.id)), modelIds = new Set(data.models.map(model => model.modelId));
  const spatialIds = new Set<string>();
  for (const node of data.spatialNodes) {
    requireValid(record(node) && typeof node.key === 'string' && !spatialIds.has(node.key) && typeof node.name === 'string' && typeof node.ifcType === 'string' && typeof node.kind === 'string' && typeof node.globalId === 'string' && typeof node.sourcePath === 'string' && (node.parentKey === null || typeof node.parentKey === 'string') && modelIds.has(node.modelId) && Number.isSafeInteger(node.expressId), 'spatial context');
    spatialIds.add(node.key);
  }
  for (const source of engineeringSourceRecords(data.graph,data.ifcRecords)) {
    requireValid(!source.parent || ids.has(source.parent), 'source parent');
    if(source.attributeOnly){
      requireValid(source.track==='dev'&&!source.devOccurrence&&cbm.has(source.attributeContextId!),'attribute-only occurrence');
      requireValid(source.relations?.every(r=>r.kind==='host'&&ids.has(r.targetSourceId))??true,'attribute host reference');
    }else if (source.track === 'dev') {
      const address = source.devOccurrence;
      requireValid(record(address) && ids.has(address.rootSourceId) && cbm.has(address.cbmOccurrenceId) && typeof address.assemblyPath === 'string', 'DEV occurrence address');
    } else {
      const address = source.ifcOccurrence;
      requireValid(record(address) && modelIds.has(address.modelId) && Number.isSafeInteger(address.expressId) && address.expressId > 0 && typeof address.globalId === 'string' && source.context.every(key => spatialIds.has(key)), 'IFC occurrence address');
    }
  }
  requireValid(data.graph.records.every(r => r.track === 'dev'&&!r.attributeOnly) && data.ifcRecords.every(r => r.track === 'ifc'&&!r.attributeOnly), 'source tracks');
  requireValid(data.models.every(m => record(m) && typeof m.modelId === 'string' && typeof m.path === 'string'), 'model identities');
  const expected = new Set(data.graph.ifcPaths.map(p => p.replace(/\\/g, '/').toLowerCase()));
  const actual = new Set(data.models.map(m => m.path.replace(/\\/g, '/').toLowerCase()));
  requireValid(expected.size === data.models.length && expected.size === actual.size && [...expected].every(p => actual.has(p)) && data.models.every(m => !m.error), 'IFC manifest');
  requireValid(data.graph.diagnostics.length === 0 && !data.graph.references.some(r => r.status !== 'resolved' && /\.(?:cbm|dev|fam|ifc)\$?$/i.test(r.value)), 'source coverage');
}

function assertSourceInventory(sources: EngineeringSources, id: EngineeringCacheIdentity): void {
  requireValid(strings(id.entries) && id.entries.length === new Set(id.entries).size, 'inventory identities');
  const paths = new Set(id.entries);
  requireValid(sources.graph.documents.every(doc => typeof doc.path === 'string' && paths.has(doc.path) && strings(doc.rawLines) && Array.isArray(doc.fields)), 'source documents');
  requireValid(engineeringSourceRecords(sources.graph,sources.ifcRecords).every(r => r.sources.every(path => paths.has(path))), 'source file references');
  requireValid(sources.spatialNodes.every(node => paths.has(node.sourcePath)), 'spatial source files');
  const ifc = id.entries.filter(path => /\.ifc$/i.test(path));
  requireValid(ifc.length === sources.graph.ifcPaths.length && sources.graph.ifcPaths.every(path => paths.has(path)), 'delivered IFC inventory');
}

/** A source cache may decode successfully yet be a DEV-only snapshot written
 * before IFC spatial evidence existed. Check the delivered IFC inventory and
 * outward records before treating it as a hit. */
export function engineeringSourceCacheMatchesFiles(sources: EngineeringSources, files: Iterable<string>): boolean {
  const normalize = (path: string) => path.replace(/\\/g, '/').toLowerCase();
  const delivered = new Set([...files].filter(path => /\.ifc$/i.test(path)).map(normalize));
  const cached = new Set(sources.graph.ifcPaths.map(normalize));
  return delivered.size === cached.size && [...delivered].every(path => cached.has(path))
    && (delivered.size === 0 || (sources.models.length === delivered.size && sources.ifcRecords.length > 0));
}

export async function encodeEngineeringSources(sources: EngineeringSources, id: EngineeringCacheIdentity): Promise<{ bytes: Uint8Array; digest: string }> {
  assertEngineeringSources(sources);
  assertSourceInventory(sources, id);
  return encode('sources', sources, id);
}
export async function decodeEngineeringSources(bytes: Uint8Array, id: EngineeringCacheIdentity): Promise<EngineeringSourceArtifact> {
  const result = await decode('sources', bytes, id);
  assertEngineeringSources(result.payload);
  assertSourceInventory(result.payload, id);
  return { sources: result.payload, digest: result.digest };
}
export async function encodeEngineeringEntities(snapshot: EngineeringSnapshot, sources: EngineeringSourceArtifact, id: EngineeringCacheIdentity): Promise<Uint8Array> {
  requireValid(snapshot.evidenceBinding?.scope===id.sourceSha256&&snapshot.evidenceBinding.sourceRevision===(sources.sources.graph.revision??0),'entity evidence revision');
  requireValid(snapshot.scope === id.sourceSha256 && snapshot.rulesVersion === ENGINEERING_RULES_VERSION, 'entity scope / rules');
  assertEngineeringPartition(snapshot, engineeringSourceRecords(sources.sources.graph,sources.sources.ifcRecords).map(r => r.id));
  return (await encode('entities', snapshot, id, sources.digest)).bytes;
}
export async function decodeEngineeringEntities(bytes: Uint8Array, sources: EngineeringSourceArtifact, id: EngineeringCacheIdentity): Promise<EngineeringSnapshot> {
  const result = await decode('entities', bytes, id, sources.digest);
  const value = result.payload;
  requireValid(record(value) && value.scope === id.sourceSha256 && value.rulesVersion === ENGINEERING_RULES_VERSION && Array.isArray(value.entities) && Array.isArray(value.memberships) && Array.isArray(value.pending) && Array.isArray(value.relationships) && Array.isArray(value.aliases), 'entity snapshot');
  const snapshot = value as EngineeringSnapshot;
  requireValid(snapshot.evidenceBinding?.scope===id.sourceSha256&&snapshot.evidenceBinding.sourceRevision===(sources.sources.graph.revision??0),'entity evidence revision');
  assertEngineeringPartition(snapshot, engineeringSourceRecords(sources.sources.graph,sources.sources.ifcRecords).map(r => r.id));
  return snapshot;
}
export { encode as encodeEngineeringArtifact, decode as decodeEngineeringArtifact };
