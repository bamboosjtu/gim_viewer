import { BUSINESS_TREE_VERSION, rebuildBusinessMembers, type BusinessTreeProjection, type BusinessObject, type BusinessRegion, type BusinessUnit } from '../gim/businessTree.js';
import type { CbmNode } from '../gim/types.js';
import { readCachedEntry, writeCacheFile } from '@desktop/database.js';
import { SUBSTATION_SPATIAL_SEMANTIC_VERSION, SUBSTATION_PARSER_DOMAIN_VERSION } from './substationSpatialSemanticCache.js';

export const BUSINESS_SNAPSHOT_VERSION='business-snapshot-v3';
export const MAX_BUSINESS_SNAPSHOT_BYTES=64*1024*1024;
export interface BusinessCacheIdentity {sourceSha256:string;semanticVersion:string;modelIds:string[]}
interface Snapshot {objects:BusinessObject[];regions:BusinessRegion[];units:BusinessUnit[]}
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const contract=`${BUSINESS_SNAPSHOT_VERSION}|${BUSINESS_TREE_VERSION}|${SUBSTATION_SPATIAL_SEMANTIC_VERSION}|${SUBSTATION_PARSER_DOMAIN_VERSION}`;
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(s=>typeof s==='string');
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const requireValid=(ok:unknown,reason:string):void=>{if(!ok)throw Error(`业务缓存无效：${reason}`);};
const digest=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))].map(v=>v.toString(16).padStart(2,'0')).join('');
const models=(id:BusinessCacheIdentity)=>[...id.modelIds].sort().join('\0');
/** Fixed columns plus shared strings avoid parsing the same long source identities per object. */
function pack(p:BusinessTreeProjection):unknown {
  const strings:string[]=[],ids=new Map<string,number>();
  const s=(value:string):number=>{let index=ids.get(value);if(index===undefined){index=strings.length;strings.push(value);ids.set(value,index);}return index;};
  const opt=(value:string|undefined)=>value===undefined?null:s(value),list=(values:string[])=>values.map(s);
  const objects=[...p.objects.values()].map(o=>{
    const a=o.assignment,refs=o.ifcRefs??[];
    requireValid(refs.length===o.ifcKeys.length&&refs.every((r,i)=>r.key===o.ifcKeys[i]),'IFC identity');
    return [s(o.key),s(o.name),s(o.kind),list(o.cbmPaths),refs.map(r=>[s(r.key),s(r.modelId),s(r.globalId),r.expressId]),opt(o.subtype),o.featureKeys?list(o.featureKeys):null,opt(o.ownerKey),o.voltage??null,o.voltageConflict,list(o.context),
      [s(a.status),s(a.unitKey),list(a.evidence),s(a.reason),a.candidates?.map(c=>[s(c.unitKey),c.distance])??null,a.relatedUnitKeys?list(a.relatedUnitKeys):null]];
  });
  const regions=[...p.regions.values()].map(r=>[s(r.key),s(r.title),s(r.domain),r.voltage??null]);
  const units=[...p.units.values()].map(u=>[s(u.key),s(u.title),s(u.regionKey),s(u.kind),opt(u.parentKey)]);
  return {strings,objects,regions,units};
}
function unpack(value:unknown):Snapshot {
  requireValid(record(value)&&strings(value.strings)&&Array.isArray(value.objects)&&value.objects.length<=500000&&Array.isArray(value.regions)&&Array.isArray(value.units),'shape');
  const data=value as {strings:string[];objects:unknown[];regions:unknown[];units:unknown[]};
  const s=(index:unknown):string=>{requireValid(Number.isSafeInteger(index)&&(index as number)>=0&&(index as number)<data.strings.length,'string reference');return data.strings[index as number];};
  const list=(v:unknown):string[]=>{requireValid(Array.isArray(v),'string list');return (v as unknown[]).map(s);};
  const row=(v:unknown,length:number):unknown[]=>{requireValid(Array.isArray(v)&&v.length===length,'columns');return v as unknown[];};
  const opt=(v:unknown)=>v===null?undefined:s(v);
  const objects=data.objects.map(value=>{
    const r=row(value,12),a=row(r[11],6);requireValid(Array.isArray(r[4]),'IFC references');
    const refs=(r[4] as unknown[]).map(value=>{const ref=row(value,4);return {key:s(ref[0]),modelId:s(ref[1]),globalId:s(ref[2]),expressId:ref[3] as number};});
    requireValid((a[4]===null||Array.isArray(a[4])),'candidates');
    return {key:s(r[0]),name:s(r[1]),kind:s(r[2]) as BusinessObject['kind'],cbmPaths:list(r[3]),ifcKeys:refs.map(ref=>ref.key),ifcRefs:refs.length?refs:undefined,subtype:opt(r[5]),featureKeys:r[6]===null?undefined:list(r[6]),ownerKey:opt(r[7]),voltage:r[8]===null?undefined:r[8] as number,voltageConflict:r[9] as boolean,context:list(r[10]),
      assignment:{status:s(a[0]) as BusinessObject['assignment']['status'],unitKey:s(a[1]),evidence:list(a[2]),reason:s(a[3]),candidates:a[4]===null?undefined:(a[4] as unknown[]).map(value=>{const c=row(value,2);return {unitKey:s(c[0]),distance:c[1] as number};}),relatedUnitKeys:a[5]===null?undefined:list(a[5])}};
  });
  const regions=data.regions.map(value=>{const r=row(value,4);return {key:s(r[0]),title:s(r[1]),domain:s(r[2]) as BusinessRegion['domain'],voltage:r[3]===null?undefined:r[3] as number};});
  const units=data.units.map(value=>{const r=row(value,5);return {key:s(r[0]),title:s(r[1]),regionKey:s(r[2]),kind:s(r[3]) as BusinessUnit['kind'],parentKey:opt(r[4])};});
  return {objects,regions,units};
}
/** Repetitive source paths/evidence compress well; keep IPC and disk copies bounded. */
async function gzip(bytes:Uint8Array,decompress=false,limit=MAX_BUSINESS_SNAPSHOT_BYTES):Promise<Uint8Array> {
  const source=new ReadableStream<BufferSource>({start(controller){controller.enqueue(bytes as BufferSource);controller.close();}});
  const reader=source.pipeThrough(decompress?new DecompressionStream('gzip'):new CompressionStream('gzip')).getReader();
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('业务缓存无效：expanded size');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
}
export function businessCacheEntry(id:BusinessCacheIdentity):string {
  requireValid(/^[a-f\d]{64}$/i.test(id.sourceSha256),'source-sha');
  requireValid(typeof id.semanticVersion==='string'&&id.semanticVersion.length>0&&strings(id.modelIds),'input-version');
  return `__derived__/${BUSINESS_TREE_VERSION}/${id.sourceSha256.toLowerCase()}.bin`;
}
/** One complete, atomic derived artifact. Runtime maps and CBM trees are not duplicated on disk. */
export async function encodeBusinessTree(p:BusinessTreeProjection,id:BusinessCacheIdentity):Promise<Uint8Array> {
  const plain=encoder.encode(JSON.stringify(pack(p)));
  requireValid(plain.byteLength<=MAX_BUSINESS_SNAPSHOT_BYTES,'size');
  const body=await gzip(plain);
  const header=encoder.encode(JSON.stringify({contract,source:id.sourceSha256.toLowerCase(),semantic:id.semanticVersion,models:await digest(encoder.encode(models(id))),complete:true,encoding:'gzip',plainBytes:plain.length,bytes:body.byteLength,sha:await digest(body)}));
  const bytes=new Uint8Array(4+header.length+body.length);new DataView(bytes.buffer).setUint32(0,header.length,true);bytes.set(header,4);bytes.set(body,4+header.length);return bytes;
}
export type BusinessTreeReader=(id:BusinessCacheIdentity,cbm:Map<string,CbmNode>)=>Promise<BusinessTreeProjection>;
/** Decode while the independent semantic index is being read. Binding still validates the final model manifest. */
async function prepareBytes(bytes:Uint8Array,id:BusinessCacheIdentity):Promise<BusinessTreeReader> {
  requireValid(bytes.length>=4&&bytes.length<=MAX_BUSINESS_SNAPSHOT_BYTES+4100,'size');
  const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
  requireValid(length>0&&length<=4096&&4+length<bytes.length,'header');
  const header=JSON.parse(decoder.decode(bytes.subarray(4,4+length))),body=bytes.subarray(4+length);
  requireValid(record(header)&&header.contract===contract&&header.source===id.sourceSha256.toLowerCase()&&header.semantic===id.semanticVersion&&header.complete===true&&header.bytes===body.length,'identity/version');
  requireValid(header.encoding==='gzip'&&Number.isSafeInteger(header.plainBytes)&&header.plainBytes>0&&header.plainBytes<=MAX_BUSINESS_SNAPSHOT_BYTES,'encoding/size');
  requireValid(header.sha===await digest(body),'checksum');
  const plain=await gzip(body,true,header.plainBytes);requireValid(plain.length===header.plainBytes,'expanded size');
  const data=unpack(JSON.parse(decoder.decode(plain)));
  requireValid(record(data)&&Array.isArray(data.objects)&&data.objects.length<=500000&&Array.isArray(data.regions)&&Array.isArray(data.units),'shape');
  return async(id,cbm)=>{
  requireValid(header.source===id.sourceSha256.toLowerCase()&&header.semantic===id.semanticVersion&&header.models===await digest(encoder.encode(models(id))),'identity/version');
  const p:BusinessTreeProjection={version:BUSINESS_TREE_VERSION,objects:new Map(),regions:new Map(),units:new Map(),objectBySource:new Map(),cbmByPath:cbm,members:new Map()};
  for(const r of data.regions){requireValid(record(r)&&typeof r.key==='string'&&typeof r.title==='string'&&['installation','construction','unknown'].includes(r.domain)&&!p.regions.has(r.key)&&(r.voltage==null||Number.isFinite(r.voltage)&&r.voltage>0),'region');p.regions.set(r.key,r);}
  for(const u of data.units){requireValid(record(u)&&typeof u.key==='string'&&typeof u.title==='string'&&['bus','coupler','section','bay','transformer','shared','unresolved','building'].includes(u.kind)&&p.regions.has(u.regionKey)&&!p.units.has(u.key),'unit');p.units.set(u.key,u);}
  const modelIds=new Set(id.modelIds),kinds=new Set(['device','component','building','structure','foundation','plumbing','lighting','fire','other','导线','母线','金具','绝缘子','套管','电缆','接地材料','其他材料']);
  for(const o of data.objects){
    requireValid(record(o)&&typeof o.key==='string'&&typeof o.name==='string'&&kinds.has(o.kind)&&!p.objects.has(o.key)&&strings(o.cbmPaths)&&strings(o.ifcKeys)&&strings(o.context)&&typeof o.voltageConflict==='boolean'&&(o.voltage==null||Number.isFinite(o.voltage)&&o.voltage>0)&&record(o.assignment)&&p.units.has(o.assignment.unitKey)&&['confirmed','inferred','shared','unresolved'].includes(o.assignment.status)&&strings(o.assignment.evidence)&&typeof o.assignment.reason==='string','object');
    requireValid((!o.cbmPaths.length||cbm.has(o.cbmPaths[0]))&&o.cbmPaths.every(path=>cbm.has(path)||path.startsWith(o.cbmPaths[0]+'#dev:'))&&strings(o.featureKeys??[])&&Array.isArray(o.ifcRefs??[]),'source');
    const refs=o.ifcRefs??[];requireValid(refs.length===o.ifcKeys.length&&refs.every((ref,i)=>record(ref)&&ref.key===o.ifcKeys[i]&&modelIds.has(ref.modelId)&&typeof ref.globalId==='string'&&Number.isSafeInteger(ref.expressId)&&ref.expressId>0),'IFC identity');
    p.objects.set(o.key,o);
    for(const source of [...o.cbmPaths,...o.ifcKeys,...(o.featureKeys??[])]){requireValid(!p.objectBySource.has(source),'duplicate source');p.objectBySource.set(source,o.key);}
  }
  for(const o of p.objects.values())requireValid((!o.ownerKey||p.objects.has(o.ownerKey))&&(!o.assignment.relatedUnitKeys||strings(o.assignment.relatedUnitKeys)&&o.assignment.relatedUnitKeys.every(k=>p.units.has(k)))&&(!o.assignment.candidates||Array.isArray(o.assignment.candidates)&&o.assignment.candidates.every(c=>p.units.has(c.unitKey)&&Number.isFinite(c.distance)&&c.distance>=0)),'assignment reference');
  rebuildBusinessMembers(p);return p;
  };
}
/** Hydration only: validate source/contracts/content, restore maps and identity indexes; no classification. */
export async function decodeBusinessTree(bytes:Uint8Array,id:BusinessCacheIdentity,cbm:Map<string,CbmNode>):Promise<BusinessTreeProjection> {
  return (await prepareBytes(bytes,id))(id,cbm);
}
export async function prepareBusinessTreeRead(projectId:number,id:BusinessCacheIdentity):Promise<BusinessTreeReader> {
  return prepareBytes(await readCachedEntry(projectId,businessCacheEntry(id)),id);
}
export async function readBusinessTree(projectId:number,id:BusinessCacheIdentity,cbm:Map<string,CbmNode>):Promise<BusinessTreeProjection> {
  return decodeBusinessTree(await readCachedEntry(projectId,businessCacheEntry(id)),id,cbm);
}
export async function writeBusinessTree(projectId:number,id:BusinessCacheIdentity,p:BusinessTreeProjection):Promise<number> {
  const bytes=await encodeBusinessTree(p,id);await writeCacheFile(projectId,businessCacheEntry(id),bytes,id.sourceSha256);return bytes.length;
}
