import { MEASUREMENT_VERSION, type TraceContext, type MetricsSink, type MeasurementEvent, type PhaseScope, type TaskStatus, type Workload, type MeasurementMode, type MemoryMetric } from './types.js';

import {captureContext,spanId} from './context.js';
import type {TraceRecord,EventRef} from './types.js';
/** Clock and transport are injected. No browser, Node, renderer or application state. */
export class Probe {
  private sequence = 0;
  private spanSequence = 0;
  private traceSequence = 0;
  constructor(readonly producerId: string, readonly clockId: string, readonly mode: MeasurementMode,
    private readonly now: () => number, private readonly sink: MetricsSink, private readonly executorId?:string) {}
  event(context: TraceContext, event: Omit<MeasurementEvent, 'version' | 'context' | 'producerId' | 'sequence' | 'clockId' | 'atMs'>): void {
    if (this.mode === 'off') return;
    this.sink.emit({ ...event, version: MEASUREMENT_VERSION, context: { ...context,...(this.executorId?{executorId:this.executorId}:{}) }, producerId: this.producerId,
      sequence: ++this.sequence, clockId: this.clockId, atMs: this.now() });
  }
  trace(context:TraceContext,trace:TraceRecord,atMs=this.now()):EventRef|undefined {
    if(this.mode!=='diagnostic'||!Number.isFinite(atMs))return;
    const producerId=this.producerId+':trace',sequence=++this.traceSequence;
    this.sink.emit({version:MEASUREMENT_VERSION,context:{...context,...(this.executorId?{executorId:this.executorId}:{})},producerId,ownerProducerId:this.producerId,sequence,
      clockId:this.clockId,atMs,kind:'trace',name:'trace.'+trace.type,trace});
    return {runId:context.runId,producerId,sequence};
  }
  phase(context: TraceContext, name: string, parentSpanId: string | null = null,options:{summary?:boolean}={}): PhaseScope {
    const captured=captureContext(context);
    if (this.mode === 'off') return {id:'off',context:captured,end(){}};
    const started = this.now(), id = `${captured.runId}:${this.producerId}:${++this.spanSequence}`; let ended = false;
    const parent=parentSpanId??captured.activeSpanId??null;
    const summary=options.summary!==false;
    const child=captureContext({...captured,activeSpanId:spanId(id)});
    const startedEventRef=this.trace(captured,{type:'span',action:'started',id,name,parentSpanId:parent},started);
    return { id, startedEventRef,context:child, end: (status: TaskStatus = 'completed', workload?: Workload) => {
      if (ended) return; ended = true;
      const finished=this.now();
      this.trace(captured,{type:'span',action:'ended',id,name,endMs:finished,status},finished);
      if(summary)this.event(captured, { kind: 'phase', name, spanId: id, parentSpanId:parent, startMs: started,endMs:finished,
        durationMs: Math.max(0, finished - started), timing: 'interval', status, workload });
    } };
  }
  record(context: TraceContext, name: string, durationMs: number, workload?: Workload): void {
    this.event(context, { kind: 'phase', name, durationMs, timing: 'aggregate', status: 'completed', workload });
  }
  memory(context: TraceContext, metric: MemoryMetric): void { this.event(context, { kind: 'memory', name: metric.name, memory: metric }); }
  async measure<T>(context: TraceContext, name: string, work: (context:Readonly<TraceContext>) => Promise<T>): Promise<T> {
    const phase = this.phase(context, name);
    try { const result = await work(phase.context); phase.end(); return result; }
    catch (error) { phase.end((error as { name?: string })?.name === 'AbortError' ? 'cancelled' : 'failed'); throw error; }
  }
  measureSync<T>(context: TraceContext, name: string, work: (context:Readonly<TraceContext>) => T): T {
    const phase = this.phase(context, name);
    try { const result = work(phase.context); phase.end(); return result; }
    catch (error) { phase.end((error as { name?: string })?.name === 'AbortError' ? 'cancelled' : 'failed'); throw error; }
  }
}
