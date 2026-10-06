import type { CbmNode, FileDevEntry, IfcEntry } from '../gim/types.js';
import { buildSubstationSpatialIndexFromFiles, type SubstationSpatialIndex,
  type SubstationSpatialIndexObserver } from '../gim/ifcSpatialParser.js';
import type { SpatialWorkerRequest, SpatialWorkerResponse } from './substationSpatialWorker.js';

const active=new Set<()=>void>();
export function cancelSubstationSpatialWorkers():void {
  for(const cancel of [...active])cancel();
}

/** Keep the existing builder and per-file read/error semantics; isolate STEP
 * scan/finalize only. No cache format, spatial identity or property reduction. */
export async function buildSubstationSpatialIndexInWorker(
  files:Map<string,File>,entries:IfcEntry[],tree:CbmNode|null,relations:FileDevEntry[],
  observer:SubstationSpatialIndexObserver,isCurrent:()=>boolean,
):Promise<SubstationSpatialIndex> {
  if(typeof Worker==='undefined') return buildSubstationSpatialIndexFromFiles(files,entries,tree,relations,observer);
  const worker=new Worker(new URL('./substationSpatialWorker.ts',import.meta.url),{type:'module'});
  let pending:{resolve:(result?:SubstationSpatialIndex)=>void;reject:(error:Error)=>void}|undefined;
  let terminated=false;
  const cancel=()=>{
    terminated=true;worker.terminate();active.delete(cancel);
    pending?.reject(new DOMException('Spatial parse belongs to an obsolete project','AbortError'));pending=undefined;
  };
  active.add(cancel);
  worker.onmessage=(event:MessageEvent<SpatialWorkerResponse>)=>{
    if(!isCurrent()){cancel();return;}
    const response=event.data;
    if(response.type==='diagnostic') {
      // The protocol carries the existing observer's plain profile records.
      const callback=observer[response.event] as ((profile:unknown)=>void)|undefined;
      callback?.(response.profile);return;
    }
    const request=pending;pending=undefined;
    if(response.type==='error')request?.reject(new Error(response.message));
    else request?.resolve(response.type==='complete'?response.index:undefined);
  };
  worker.onerror=event=>{pending?.reject(new Error(event.message||'Spatial worker failed'));pending=undefined;};
  worker.onmessageerror=()=>{pending?.reject(new Error('Spatial worker returned unreadable data'));pending=undefined;};
  const send=(request:SpatialWorkerRequest,transfer:Transferable[]=[])=>new Promise<SubstationSpatialIndex|undefined>((resolve,reject)=>{
    if(terminated||!isCurrent()){reject(new DOMException('Spatial parse belongs to an obsolete project','AbortError'));return;}
    pending={resolve,reject};
    try {worker.postMessage(request,transfer);} catch(error){pending=undefined;reject(error instanceof Error?error:new Error(String(error)));}
  });
  try {
    await send({type:'init',tree,relations});
    const canonical=(path:string)=>path.replace(/\\/g,'/').toLowerCase();
    const sources=new Map([...files].map(([path,file])=>[canonical(path),file]));
    for(const entry of entries) {
      if(!isCurrent())throw new DOMException('Spatial parse belongs to an obsolete project','AbortError');
      const file=sources.get(canonical(entry.path)),started=performance.now();
      let bytes:ArrayBuffer|null=null,text:string|null=null,error:string|undefined;
      try {
        if(file){
          if(typeof file.arrayBuffer==='function')bytes=await file.arrayBuffer();
          else if(typeof file.text==='function')text=await file.text();
          else throw new Error('IFC 文件对象不支持 arrayBuffer/text');
        }
      } catch(cause){error=cause instanceof Error?cause.message:String(cause);}
      const read={modelId:entry.modelId,entryPath:entry.path,bytes:bytes?.byteLength ??
        (text===null ? file?.size??0:new TextEncoder().encode(text).byteLength),readMs:performance.now()-started,
        decodeMs:0,found:file!=null,...(error?{error}:{})};
      await send({type:'model',entry,bytes,text,read},bytes?[bytes]:[]);
    }
    return (await send({type:'finish'}))!;
  } finally {cancel();worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;}
}
