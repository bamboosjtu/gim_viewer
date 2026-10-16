import { SubstationSpatialIndexBuilder, type SubstationSpatialIndex,
  type SubstationSpatialIndexObserver, type IfcSpatialReadProfile } from '../gim/ifcSpatialParser.js';
import type { CbmNode, FileDevEntry, IfcEntry } from '../gim/types.js';

export type SpatialWorkerRequest =
  | { type:'init'; tree:CbmNode|null; relations:FileDevEntry[] }
  | { type:'model'; entry:IfcEntry; bytes:ArrayBuffer|null; text:string|null; blob?:Blob; read:IfcSpatialReadProfile }
  | { type:'finish' };
export type SpatialWorkerResponse =
  | { type:'ready' }
  | { type:'complete'; index:SubstationSpatialIndex }
  | { type:'error'; message:string }
  | { type:'diagnostic'; event:keyof SubstationSpatialIndexObserver; profile:unknown };

let builder:SubstationSpatialIndexBuilder;
const observer:SubstationSpatialIndexObserver={
  onStepScan:profile=>self.postMessage({type:'diagnostic',event:'onStepScan',profile} satisfies SpatialWorkerResponse),
  onModelParsed:profile=>self.postMessage({type:'diagnostic',event:'onModelParsed',profile} satisfies SpatialWorkerResponse),
  onFinalize:profile=>self.postMessage({type:'diagnostic',event:'onFinalize',profile} satisfies SpatialWorkerResponse),
};
self.onmessage=async (event:MessageEvent<SpatialWorkerRequest>)=>{
  try {
    const request=event.data;
    if(request.type==='init') builder=new SubstationSpatialIndexBuilder(request.tree,request.relations,observer);
    else if(request.type==='model') {
      let bytes=request.bytes,readMs=request.read.readMs,error=request.read.error;
      if(request.blob){const started=performance.now();try{bytes=await request.blob.arrayBuffer();}catch(cause){error=String(cause);}readMs+=performance.now()-started;}
      const started=performance.now();
      const text=request.text ?? (bytes===null ? null:new TextDecoder().decode(bytes));
      const sourceBytes=bytes?.byteLength ?? request.read.bytes;
      self.postMessage({type:'diagnostic',event:'onModelRead',profile:{...request.read,bytes:sourceBytes,readMs,decodeMs:performance.now()-started,...(error?{error}:{})}} satisfies SpatialWorkerResponse);
      builder.addIfcModel(request.entry,text,sourceBytes);
    } else {
      self.postMessage({type:'complete',index:builder.finalize()} satisfies SpatialWorkerResponse);
      return;
    }
    self.postMessage({type:'ready'} satisfies SpatialWorkerResponse);
  } catch(error) {
    self.postMessage({type:'error',message:error instanceof Error?error.message:String(error)} satisfies SpatialWorkerResponse);
  }
};
