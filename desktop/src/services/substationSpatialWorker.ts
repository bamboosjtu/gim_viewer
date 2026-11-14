import { SubstationSpatialIndexBuilder, type SubstationSpatialIndex,
  type SubstationSpatialIndexObserver, type IfcSpatialReadProfile } from '../gim/ifcSpatialParser.js';
import type { CbmNode, FileDevEntry, IfcEntry } from '../gim/types.js';
import { createWorkerProbe } from '../measurement/workerProbe.js';
import {encodeSubstationSpatialCache,SUBSTATION_SPATIAL_SEMANTIC_VERSION,SUBSTATION_PARSER_DOMAIN_VERSION,type SubstationSpatialSnapshotMetadata,type EncodedSpatialCache} from './substationSpatialCodec.js';

export type SpatialWorkerRequest =
  | { type:'init'; tree:CbmNode|null; relations:FileDevEntry[];propertyNames?:readonly string[] }
  | { type:'model'; entry:IfcEntry; bytes:ArrayBuffer|null; text:string|null; blob?:Blob; read:IfcSpatialReadProfile }
  | { type:'finish'; cacheMetadata?:SubstationSpatialSnapshotMetadata };
export type SpatialWorkerResponse =
  | { type:'ready' }
  | { type:'complete'; index:SubstationSpatialIndex; cache?:EncodedSpatialCache }
  | { type:'error'; message:string }
  | { type:'diagnostic'; event:keyof SubstationSpatialIndexObserver; profile:unknown };

let builder:SubstationSpatialIndexBuilder;
const observer:SubstationSpatialIndexObserver={
  onStepScan:profile=>self.postMessage({type:'diagnostic',event:'onStepScan',profile} satisfies SpatialWorkerResponse),
  onModelParsed:profile=>self.postMessage({type:'diagnostic',event:'onModelParsed',profile} satisfies SpatialWorkerResponse),
  onFinalize:profile=>self.postMessage({type:'diagnostic',event:'onFinalize',profile} satisfies SpatialWorkerResponse),
};
self.onmessage=createWorkerProbe().wrap(async (event:MessageEvent<SpatialWorkerRequest>, trace)=>{
  try {
    const request=event.data;
    if(request.type==='init') builder=new SubstationSpatialIndexBuilder(request.tree,request.relations,observer,request.propertyNames);
    else if(request.type==='model') {
      let bytes=request.bytes,readMs=request.read.readMs,error=request.read.error;
      if(request.blob){const started=performance.now();try{bytes=await request.blob.arrayBuffer();}catch(cause){error=String(cause);}readMs+=performance.now()-started;}
      const started=performance.now();
      const text=request.text ?? (bytes===null ? null:new TextDecoder().decode(bytes));
      const sourceBytes=bytes?.byteLength ?? request.read.bytes;
      self.postMessage({type:'diagnostic',event:'onModelRead',profile:{...request.read,bytes:sourceBytes,readMs,decodeMs:performance.now()-started,...(error?{error}:{})}} satisfies SpatialWorkerResponse);
      trace.record('spatial.source-read', readMs, { bytes: sourceBytes });
      trace.sync('spatial.scan-and-model', () => builder.addIfcModel(request.entry,text,sourceBytes));
    } else {
      const index = trace.sync('spatial.finalize', () => builder.finalize());
      let cache:EncodedSpatialCache|undefined;
      if(request.cacheMetadata){
        try{cache=trace.sync('spatial.cache-encode',()=>encodeSubstationSpatialCache(index,request.cacheMetadata!));}
        catch(error){cache={sourceSha256:request.cacheMetadata.sourceSha256.trim(),parserVersion:request.cacheMetadata.parserVersion??SUBSTATION_PARSER_DOMAIN_VERSION,
          cacheVersion:SUBSTATION_SPATIAL_SEMANTIC_VERSION,error:String(error)};}
      }
      trace.produced();
      trace.reply({type:'complete',index,...(cache?{cache}:{})} satisfies SpatialWorkerResponse,cache?.bytes?[cache.bytes.buffer]:undefined);
      return;
    }
    trace.produced();
    trace.reply({type:'ready'} satisfies SpatialWorkerResponse);
  } catch(error) {
    trace.fail(error);
    self.postMessage({type:'error',message:error instanceof Error?error.message:String(error)} satisfies SpatialWorkerResponse);
  }
});
