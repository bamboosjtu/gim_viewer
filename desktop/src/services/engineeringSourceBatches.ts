import {decodeGimText} from '../shared/textDecode.js';
import {ENGINEERING_SOURCE_BATCH_BYTES,ENGINEERING_SOURCE_BATCH_FILES,type EngineeringSourceBatch} from './engineeringWorkerProtocol.js';
import {NOOP_TASK,type WorkerTaskProbe} from '../measurement/workerProbe.js';

interface Batch {blob?:Blob;bytes?:Promise<ArrayBuffer>}
interface Source {batch:Batch;offset:number;length:number;error?:unknown}

/** Each carrier is read once and retained until its entries are consumed or
 * extraction ends. Decode only requested files; unreferenced entries cannot
 * fail the graph or allocate decoded strings. */
export class EngineeringSourceBatches {
  private sources=new Map<string,Source>();
  clear():void {this.sources.clear();}
  retain(paths:ReadonlySet<string>):void{for(const path of this.sources.keys())if(!paths.has(path))this.sources.delete(path);}
  add(input:EngineeringSourceBatch):void {
    if(!input.entries.length||input.entries.length>ENGINEERING_SOURCE_BATCH_FILES||input.blob.size>ENGINEERING_SOURCE_BATCH_BYTES)
      throw Error('Engineering source batch exceeds bounds');
    let end=0;const paths=new Set<string>();
    for(const entry of input.entries){
      if(!entry.path||paths.has(entry.path)||this.sources.has(entry.path)||!Number.isSafeInteger(entry.offset)||!Number.isSafeInteger(entry.length)||
        entry.length<0||entry.offset!==end||entry.length>input.blob.size-end)throw Error('Invalid engineering source batch range');
      paths.add(entry.path);end+=entry.length;
    }
    if(end!==input.blob.size)throw Error('Incomplete engineering source batch');
    const batch:Batch={blob:input.blob};for(const entry of input.entries)this.sources.set(entry.path,{batch,offset:entry.offset,length:entry.length});
  }
  has(path:string):boolean {return this.sources.has(path);}
  async read(path:string,trace:WorkerTaskProbe=NOOP_TASK):Promise<string> {
    const source=this.sources.get(path);if(!source)throw Error('Engineering source unavailable: '+path);
    if(source.error)throw source.error;
    const batch=source.batch;
    batch.bytes??=trace.measureObserved('engineering.source-read',()=>batch.blob!.arrayBuffer()).finally(()=>{batch.blob=undefined;});
    const bytes=await batch.bytes;
    try{
      const text=trace.syncObserved('engineering.decode',()=>decodeGimText(new Uint8Array(bytes,source.offset,source.length)).text);
      this.sources.delete(path);return text;
    }catch(error){source.error=error;throw error;}
  }
}
