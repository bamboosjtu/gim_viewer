import {decodeGimText} from '../shared/textDecode.js';
import {ENGINEERING_SOURCE_BATCH_BYTES,ENGINEERING_SOURCE_BATCH_FILES,type EngineeringSourceBatch} from './engineeringWorkerProtocol.js';
import {NOOP_TASK,type WorkerTaskProbe} from '../measurement/workerProbe.js';

interface Batch {input?:EngineeringSourceBatch;texts?:Promise<Map<string,string>>}

/** Each carrier is read once. Raw buffers live only during that batch's decode;
 * decoded text is removed as SourceGraph takes ownership of its document. */
export class EngineeringSourceBatches {
  private sources=new Map<string,Batch>();
  clear():void {this.sources.clear();}
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
    const batch:Batch={input};for(const path of paths)this.sources.set(path,batch);
  }
  has(path:string):boolean {return this.sources.has(path);}
  async read(path:string,trace:WorkerTaskProbe=NOOP_TASK):Promise<string> {
    const batch=this.sources.get(path);if(!batch)throw Error('Engineering source unavailable: '+path);
    batch.texts??=(async()=>{
      const input=batch.input!;
      try{
        const bytes=await trace.measureObserved('engineering.source-read',()=>input.blob.arrayBuffer());
        return trace.syncObserved('engineering.decode',()=>{
          const texts=new Map<string,string>();
          for(const entry of input.entries)texts.set(entry.path,decodeGimText(new Uint8Array(bytes,entry.offset,entry.length)).text);
          return texts;
        });
      }finally{batch.input=undefined;}
    })();
    const texts=await batch.texts,text=texts.get(path);
    if(text===undefined)throw Error('Engineering source already consumed: '+path);
    texts.delete(path);this.sources.delete(path);return text;
  }
}
