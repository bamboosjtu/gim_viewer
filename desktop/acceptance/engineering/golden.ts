import { createHash } from 'node:crypto';
import type { EngineeringSnapshot } from '../../src/engineering/types.js';
import type { EngineeringNavigationData } from '../../src/gim/engineering/navigation.js';
import type { EngineeringSources } from '../../src/gim/engineering/buildSources.js';
import type { SourceGeometryOccurrenceCatalog } from '../../src/gim/engineering/geometryOccurrences.js';

export type GoldenRow=[section:string,key:string,value:unknown];
export const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function canonical(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export const goldenLine=(row:GoldenRow)=>JSON.stringify(canonical(row));
export function* engineeringSnapshotRows(snapshot:EngineeringSnapshot):Generator<GoldenRow>{
  for(const e of snapshot.entities)yield ['entities',e.id,e];
  for(const m of snapshot.memberships)yield ['memberships',m.sourceId,m];
  for(const p of snapshot.pending)yield ['pending',p.id,p];
  for(const [i,r]of snapshot.relationships.entries())yield ['relationships',String(i),r];
  for(const a of [...snapshot.aliases].sort((a,b)=>a.sourceId<b.sourceId?-1:1))yield ['aliases',a.sourceId,a];
  for(const [i,d]of snapshot.diagnostics.entries())yield ['diagnostics',String(i),d];
}
export function assertGoldenFresh(expected:{sourceSha256:string;implementationSha256:string},actual:typeof expected):void{
  if(expected.sourceSha256!==actual.sourceSha256)throw Error('Golden source SHA mismatch');
  if(expected.implementationSha256!==actual.implementationSha256)throw Error('Golden fixture is stale: parser/rules/projection fingerprint mismatch');
}

/** Complete semantic/projection rows, not just counters. Arrays of members and
 * ordered children remain inspectable; no geometry meshes enter the oracle. */
export function* engineeringGoldenRows(sources:EngineeringSources,snapshot:EngineeringSnapshot,view:EngineeringNavigationData,geometry:SourceGeometryOccurrenceCatalog):Generator<GoldenRow>{
  const propertyHashes=new WeakMap<object,string>();
  yield ['model','state',{scope:snapshot.scope,sourceVersion:sources.version,complete:sources.complete,incompleteReasons:sources.incompleteReasons,rulesVersion:snapshot.rulesVersion,projectionVersions:view.projectionVersions}];
  for(const r of [...sources.graph.records,...sources.ifcRecords].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)){
    const {properties,...record}=r;
    let propertiesSha256=propertyHashes.get(properties);if(!propertiesSha256){propertiesSha256=hash(JSON.stringify(canonical(properties)));propertyHashes.set(properties,propertiesSha256);}
    yield ['sourceFacts',r.id,{...record,propertyCount:properties.length,propertiesSha256}];
  }
  for(const d of [...sources.graph.documents].sort((a,b)=>a.path<b.path?-1:1))yield ['sourceDocuments',d.path,{lines:d.rawLines.length,fields:d.fields.length,sha256:hash(JSON.stringify(canonical(d)))}];
  for(const [i,r]of sources.graph.references.entries())yield ['sourceReferences',String(i),r];
  for(const a of [...sources.graph.aliases].sort((a,b)=>a.sourceId<b.sourceId?-1:1))yield ['sourceAliases',a.sourceId,a];
  yield* engineeringSnapshotRows(snapshot);
  for(const [name,nodes]of [['composition',view.composition.nodes],['source',view.sourceNodes],['inventory',view.inventory!.nodes]] as const)
    for(const [key,node]of [...nodes].sort(([a],[b])=>a<b?-1:a>b?1:0))yield [name,key,node];
  for(const [name,index]of [['compositionRows',view.composition.rowsByEntity],['sourceRows',view.sourceRows],['inventoryRows',view.inventory!.rowsByEntity],['inventorySources',view.inventory!.rowsBySource]] as const)
    for(const [key,value]of [...index].sort(([a],[b])=>a<b?-1:a>b?1:0))yield [name,key,value];
  for(const [name,rows]of [['compositionSearch',view.compositionSearch],['sourceSearch',view.sourceSearch],['inventorySearch',view.inventorySearch!]] as const)
    for(const row of [...rows].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0))yield [name,row.key,row];
  for(const occurrence of geometry.occurrences)yield ['geometry',occurrence.id,occurrence];
  for(const [i,d]of geometry.diagnostics.entries())yield ['geometryDiagnostics',String(i),d];
}

/** Measure the former flat cache body without allocating a giant JSON string. */
export function flatJsonBytes(value:unknown):number{
  const objects=new WeakMap<object,number>(),strings=new Map<string,number>();
  function count(v:unknown):number{
    if(v==null)return 4;
    if(typeof v==='string'){let n=strings.get(v);if(n===undefined){n=Buffer.byteLength(JSON.stringify(v));strings.set(v,n);}return n;}
    if(typeof v==='number'||typeof v==='boolean')return String(v).length;
    if(typeof v!=='object')throw Error('Unsupported flat JSON value');
    const old=objects.get(v);if(old!==undefined)return old;
    const values=Array.isArray(v)?v.map(x=>count(x)):Object.entries(v).filter(([,x])=>x!==undefined).map(([k,x])=>count(k)+1+count(x));
    const n=2+Math.max(0,values.length-1)+values.reduce((sum,x)=>sum+x,0);objects.set(v,n);return n;
  }
  return count(value);
}
