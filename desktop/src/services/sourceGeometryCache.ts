import type {SourceGeometryOccurrenceCatalog} from '../gim/engineering/geometryOccurrences.js';
import {isUsableAffineMatrix} from '../gim/geometry/affineMatrix.js';

const CONTRACT='source-geometry-v1';
const MAX_BYTES=32*1024*1024;
export const sourceGeometryCacheEntry=(scope:string)=>`__derived__/${CONTRACT}/${scope}.bin`;
/** Source SHA and inventory bind this directory; no category/rule/tree versions. */
export async function encodeSourceGeometryCache(scope:string,catalog:SourceGeometryOccurrenceCatalog):Promise<Uint8Array|undefined> {
  // Reject oversized optional artifacts before creating a model-sized JSON string.
  const estimate=catalog.occurrences.reduce((n,row)=>n+512+3*(row.id.length+row.sourceId.length+row.sourceContextId.length+row.devPath.length+row.name.length),0)
    +catalog.diagnostics.reduce((n,row)=>n+128+3*(row.sourceContextId.length+row.documentPath.length+row.reason.length),0);
  if(estimate>MAX_BYTES)return;
  const body=new TextEncoder().encode(JSON.stringify(catalog));
  const header=new TextEncoder().encode(JSON.stringify({contract:CONTRACT,scope,bodyBytes:body.byteLength}));
  if(body.byteLength+header.byteLength+4>MAX_BYTES)return;
  const bytes=new Uint8Array(4+header.length+body.length);new DataView(bytes.buffer).setUint32(0,header.length,true);bytes.set(header,4);bytes.set(body,4+header.length);return bytes;
}
export async function decodeSourceGeometryCache(bytes:Uint8Array,scope:string,entries:ReadonlyMap<string,unknown>):Promise<SourceGeometryOccurrenceCatalog> {
  if(bytes.byteLength<4||bytes.byteLength>MAX_BYTES)throw Error('Physical source cache exceeds budget');
  const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
  if(size>4096||size>bytes.length-4)throw Error('Invalid physical source cache header');
  const header=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+size))),body=bytes.subarray(4+size);
  if(header.contract!==CONTRACT||header.scope!==scope||header.bodyBytes!==body.byteLength)throw Error('Physical source cache identity / length mismatch');
  const catalog=JSON.parse(new TextDecoder().decode(body));
  if(!Array.isArray(catalog?.occurrences)||!Array.isArray(catalog?.diagnostics))throw Error('Invalid physical source cache');
  const ids=new Set<string>();
  for(const row of catalog.occurrences){
    if(typeof row.id!=='string'||ids.has(row.id)||row.sourceId!==row.id||typeof row.sourceContextId!=='string'||typeof row.name!=='string'||!entries.has(row.devPath)||!isUsableAffineMatrix(row.placementMatrix))throw Error('Invalid physical source cache occurrence');
    ids.add(row.id);
  }
  for(const row of catalog.diagnostics)if(typeof row.sourceContextId!=='string'||typeof row.documentPath!=='string'||typeof row.reason!=='string')throw Error('Invalid physical source diagnostic');
  return catalog;
}
