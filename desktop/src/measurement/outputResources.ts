import {type TraceContext} from './core.js';
import {measurementRun,measurementContext,measurementSourceId,sampleHostBuffers} from './runtime.js';

/** Tracks actual returned/Part backing buffers until consumer ack or transfer. */
export class OutputResources {
  private run=measurementRun();
  private buffers=this.run.buffers;
  private owners=new Map<string,{id:string;owner:string;bytes:number;at:number;context:TraceContext}>();
  hold(key:string,value:Uint8Array,task:{taskId:string;sourcePath:string;context?:TraceContext},role:'output'|'part'):void {
    if(this.run.collector.mode==='off')return;
    this.release(key,'replaced');
    const owner=this.run.newOwner(role),id=this.buffers.retain(value,owner),bytes=value.buffer.byteLength;
    const context=task.context??{...measurementContext(this.run.collector),taskId:task.taskId,sourceId:measurementSourceId(task.sourcePath,this.run.collector)};
    this.owners.set(key,{id,owner,bytes,at:performance.now(),context});
    this.run.probe.event(context,{kind:'counter',name:'resource.acquire',resource:{id:`${context.runId}:host:${id}`,action:'acquire',owner,bytes},workload:{buffers:1,referencedBytes:bytes}});this.sample();
  }
  release(key:string,reason='consumed',to?:string):void {
    const row=this.owners.get(key);if(!row)return;
    this.buffers.releaseId(row.id,row.owner);this.owners.delete(key);
    this.run.probe.event(row.context,{kind:'counter',name:`resource.${reason}`,resource:{id:`${row.context.runId}:host:${row.id}`,action:to?'transfer':'release',owner:row.owner,bytes:row.bytes,...(to?{to}:{})},workload:{buffers:1,referencedBytes:row.bytes}});
    this.run.probe.record(row.context,'host.output-retention',performance.now()-row.at);this.sample();
  }
  budget(bytes:number){if(this.run.collector.mode!=='off')this.run.probe.memory(measurementContext(this.run.collector),{name:'dev-merge-reservation',scope:'host',method:'scheduler-reservation',quality:'budget',availability:'available',bytes,sampleDelayMs:0});}
  clear(){for(const key of this.owners.keys())this.release(key,'cancelled');this.budget(0);}
  private sample(){sampleHostBuffers(this.run);}
}
