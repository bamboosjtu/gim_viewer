import type {Collector,MeasurementEvent} from './core.js';
import {observeMeasurementCollectors} from './runtime.js';

/** CDP binding transport: 16 acknowledged batches, at most 128 events each. */
export function installMeasurementStream(send:(json:string)=>void){
  const runs=new Map<string,{collector:Collector;next:number;pending:Set<number>}>();
  observeMeasurementCollectors(collector=>{
    const runId=collector.identity.runId,row={collector,next:0,pending:new Set<number>()};runs.set(runId,row);
    collector.setDetailSink({available:()=>row.pending.size<16,send(events:MeasurementEvent[]){
      const batchId=++row.next;row.pending.add(batchId);
      // Events share their task context in transport; sequence and clock stay exact.
      const contexts:MeasurementEvent['context'][]=[];const ids=new Map<string,number>();
      const compact=events.map(({context,...event})=>{const key=JSON.stringify(context);let id=ids.get(key);
        if(id===undefined){id=contexts.length;contexts.push(context);ids.set(key,id);}return {...event,contextIndex:id};});
      send(JSON.stringify({runId,batchId,contexts,events:compact}));
    }});
    for(const [id,old]of runs)if(runs.size>4&&!old.pending.size&&old.collector.snapshot().activeTasks.length===0){old.collector.setDetailSink(undefined);runs.delete(id);}
  });
  const timer=setInterval(()=>{for(const row of runs.values())row.collector.flushDetails();},100);
  return {
    acknowledge(runId:string,batchId:number){const row=runs.get(runId);if(row?.pending.delete(batchId))row.collector.flushDetails();},
    status(){return [...runs].map(([runId,row])=>({runId,pending:row.pending.size,buffered:row.collector.snapshot().bufferedEvents}));},
    close(){clearInterval(timer);for(const row of runs.values())row.collector.setDetailSink(undefined);runs.clear();},
  };
}
