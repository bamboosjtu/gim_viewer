import { SubstationSpatialIndexBuilder, type SubstationSpatialIndex,
  type SubstationSpatialIndexObserver, type IfcSpatialReadProfile } from '../gim/ifcSpatialParser.js';
import type { CbmNode, FileDevEntry, IfcEntry } from '../gim/types.js';

export type SpatialWorkerRequest =
  | { type:'init'; tree:CbmNode|null; relations:FileDevEntry[] }
  | { type:'model'; entry:IfcEntry; bytes:ArrayBuffer|null; text:string|null; read:IfcSpatialReadProfile }
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
self.onmessage=(event:MessageEvent<SpatialWorkerRequest>)=>{
  try {
    const request=event.data;
    if(request.type==='init') builder=new SubstationSpatialIndexBuilder(request.tree,request.relations,observer);
    else if(request.type==='model') {
      const started=performance.now();
      const text=request.text ?? (request.bytes===null ? null:new TextDecoder().decode(request.bytes));
      self.postMessage({type:'diagnostic',event:'onModelRead',profile:{...request.read,decodeMs:performance.now()-started}} satisfies SpatialWorkerResponse);
      builder.addIfcModel(request.entry,text,request.read.bytes);
    } else {
      self.postMessage({type:'complete',index:builder.finalize()} satisfies SpatialWorkerResponse);
      return;
    }
    self.postMessage({type:'ready'} satisfies SpatialWorkerResponse);
  } catch(error) {
    self.postMessage({type:'error',message:error instanceof Error?error.message:String(error)} satisfies SpatialWorkerResponse);
  }
};
