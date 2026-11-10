import {measurementRun,measurementContext} from './runtime.js';
import type {TraceContext,TaskStatus,EventRef} from './core.js';
/** Observes existing scheduler decisions; never grants a slot or submits a result. */
export function measureQueuedTask(id:string,resourceId:string){
  const run=measurementRun(),context={...measurementContext(run.collector),taskId:id,attemptId:1};
  const phase=run.probe.phase(context,'host.scheduled-task'),waitId=phase.id+':queue';
  const start=run.probe.trace(phase.context,{type:'wait',action:'started',id:waitId,resourceId,reason:'dispatch-admission'});
  let granted=false,ended=false,slot:string|undefined,terminalRef:EventRef|undefined;
  return {context:phase.context,spanId:phase.id,
    get terminalRef(){return terminalRef;},
    grant(slotId:string,capacity:number){if(granted)return;granted=true;slot=slotId;
      const end=run.probe.trace(phase.context,{type:'resource',action:'granted',id:waitId,resourceId,slotId,capacity});
      run.probe.trace(phase.context,{type:'wait',action:'ended',id:waitId,resourceId,eventRefs:[start,end].filter((r):r is EventRef=>!!r)});
    },
    end(status:TaskStatus='completed'){if(ended)return;ended=true;
      if(!granted)run.probe.trace(phase.context,{type:'wait',action:'ended',id:waitId,resourceId,reason:'cancelled'});
      terminalRef=run.probe.trace(phase.context,{type:'resource',action:'released',id:waitId,resourceId,slotId:slot});phase.end(status);},
    dependency(fromSpanId:string,eventRefs:EventRef[]){run.probe.trace(phase.context,{type:'dependency',action:'required',
      fromSpanId,toSpanId:phase.id,eventRefs:[...eventRefs,...(phase.startedEventRef?[phase.startedEventRef]:[])]});}};
}
export function measureConsumption(context:TraceContext,name:string,work:()=>Promise<void>){
  const run=measurementRun();return run.probe.measure(context,name,work);
}
