import { MEASUREMENT_VERSION, type MeasurementEvent, type MeasurementMode, type RunIdentity, type MetricsSink, type MemoryMetric, type TaskStatus, type LifecycleReasonCode } from './types.js';
import { DurationStats } from './stats.js';

const validName = /^[a-zA-Z0-9_.:-]{1,96}$/;
export class Collector implements MetricsSink {
  private sequence = new Map<string, number>();
  private phases = new Map<string, { stats: DurationStats; failed: number; cancelled: number; workload: Record<string, number> }>();
  private slowestPhases:Array<{family:string;stage:string;workerId:string;sourceId:string|null;durationMs:number}>=[];
  private slowestTasks:Array<{family:string;workerId:string;sourceId:string|null;status:TaskStatus;durationMs:number}>=[];
  private workers = new Map<string, { family: string; state: string; createdMs: number; endedMs?: number; tasks: number }>();
  private active = new Map<string, MeasurementEvent>();
  private finished = new Map<string,{status:TaskStatus;reasonCode?:LifecycleReasonCode}>();
  private intentionalTasks = new Map<string,LifecycleReasonCode>();
  private cancellationReasons:Record<string,number>={};
  private outcomes: Record<string, number> = {};
  private counters = new Map<string, Record<string, number>>();
  private occupancy = new Map<string,{clockId:string;firstMs:number;lastMs:number;depth:number;startMs:number;occupiedMs:number;peakConcurrentTasks:number}>();
  private memory = new Map<string, { latest: MemoryMetric; atMs: number; observedPeakBytes: number | null; samples: number }>();
  private events: MeasurementEvent[] = [];
  private traceEvents:MeasurementEvent[]=[];
  private traceActive=new Set<string>();
  private traceProducers=new Map<string,string>();
  private traceHealth={produced:0,dropped:0,queuePeak:0,activeOverflow:0,duplicate:0,sequenceGaps:0,invalid:0,foreignRun:0,droppedByType:{} as Record<string,number>};
  private detailSink?:{ available():boolean; send(events:MeasurementEvent[]):void };
  private clock = new Map<string, NonNullable<MeasurementEvent['clock']>>();
  private loss = { sequenceGaps: 0, invalid: 0, duplicate: 0, foreignRun: 0, detailEvents: 0, aggregateGroups: 0, transportFailures: 0,
    interruptedTasks: 0, intentionalInterruptedTasks: 0, cancelledBeforeStart: 0, unexpectedWorkerTerminations: 0, cancelledWithoutReason: 0,
    lateEvents: 0, lateEventsUnexpected: 0, lateCancelledAcks: 0 };
  private aggregatedDetail={memory:0,counter:0};
  constructor(readonly identity: RunIdentity, readonly mode: MeasurementMode, private readonly detailLimit = mode==='benchmark'?32768:8192) {}
  emit(event: MeasurementEvent): void { this.accept(event); }
  noteTraceLoss(count=1):void {this.traceHealth.dropped+=count;}
  accept(event: MeasurementEvent): void {
    if (this.mode === 'off') return;
    if(event?.kind==='trace'){
      this.traceHealth.produced++;
      if(event.version!==MEASUREMENT_VERSION||event.context?.runId!==this.identity.runId||!event.trace
        ||!Number.isFinite(event.atMs)||!Number.isSafeInteger(event.sequence)||event.sequence<1){
        this.traceHealth.dropped++;
        if(event.context?.runId&&event.context.runId!==this.identity.runId){this.traceHealth.foreignRun++;this.loss.foreignRun++;}
        else {this.traceHealth.invalid++;this.loss.invalid++;}
        return;
      }
      const owner=event.ownerProducerId,worker=event.context.workerId;
      const prefix=worker+':producer-';
      const hostOwner=owner===`${this.identity.runId}:host`||worker==='host'&&owner==='host';
      const workerOwner=owner===worker||typeof owner==='string'&&owner.startsWith(prefix)&&/^\d+$/.test(owner.slice(prefix.length));
      const binding=JSON.stringify([owner,event.clockId,event.context.executorId??worker]);
      if(!owner||event.producerId!==owner+':trace'||!hostOwner&&!workerOwner||
        this.traceProducers.has(event.producerId)&&this.traceProducers.get(event.producerId)!==binding||
        event.trace.type==='span'&&(typeof event.trace.id!=='string'||!event.trace.id)){
        this.traceHealth.invalid++;this.traceHealth.dropped++;this.loss.invalid++;return;
      }
      this.traceProducers.set(event.producerId,binding);
      const previous=this.sequence.get(event.producerId)??0;
      if(event.sequence<=previous){this.traceHealth.duplicate++;this.traceHealth.dropped++;this.loss.duplicate++;return;}
      const gap=event.sequence-previous-1;
      this.traceHealth.sequenceGaps+=gap;this.loss.sequenceGaps+=gap;
      this.sequence.set(event.producerId,event.sequence);
      const key=event.context.runId+'\0'+event.trace.id;
      if(event.trace.type==='span'&&event.trace.action==='started'){
        if(this.traceActive.size<4096)this.traceActive.add(key);else this.traceHealth.activeOverflow++;
      }else if(event.trace.type==='span'&&event.trace.action==='ended')this.traceActive.delete(key);
      const critical=['operation','scope','health'].includes(event.trace.type)||event.trace.type==='span'&&event.trace.action==='ended';
      // Preserve order; reserve credit for terminal/control records rather than dropping Ended first.
      if(this.traceEvents.length<(critical?8192:8064))this.traceEvents.push(event);
      else {this.traceHealth.dropped++;const category=event.trace.type;
        this.traceHealth.droppedByType[category]=(this.traceHealth.droppedByType[category]??0)+1;}
      this.traceHealth.queuePeak=Math.max(this.traceHealth.queuePeak,this.traceEvents.length);
      if(this.traceEvents.length>=128||event.trace.type==='span'&&event.trace.action==='started')this.flushDetails();
      return;
    }
    if (!event || event.version !== MEASUREMENT_VERSION || !event.context || !validName.test(event.name)
      || !Number.isFinite(event.atMs) || !Number.isSafeInteger(event.sequence) || event.sequence < 1) { this.loss.invalid++; return; }
    if (event.context.runId !== this.identity.runId) { this.loss.foreignRun++; return; }
    const previous = this.sequence.get(event.producerId) ?? 0;
    if (event.sequence <= previous) { this.loss.duplicate++; return; }
    if (event.sequence !== previous + 1) this.loss.sequenceGaps += event.sequence - previous - 1;
    this.sequence.set(event.producerId, event.sequence);
    const context = event.context, taskKey = `${context.workerId}\0${context.taskId}\0${context.attemptId}`;
    if (event.kind === 'worker') {
      let worker = this.workers.get(context.workerId);
      if (!worker) {
        if (this.workers.size >= 1024) { this.loss.aggregateGroups++; return; }
        worker = { family: context.family, state: event.name, createdMs: event.startMs??event.atMs, tasks: 0 }; this.workers.set(context.workerId, worker);
      }
      worker.state = event.name;
      if (event.name === 'terminated' || event.name === 'failed') {
        const pendingTasks=[...this.active].filter(([,pending])=>pending.context.workerId===context.workerId);
        const controlled=event.name==='terminated'&&event.status==='aborted'&&
          (['project-closed','project-replaced'].includes(event.reasonCode??'')||
            event.reasonCode==='worker-idle'&&pendingTasks.length===0||
            pendingTasks.length>0&&pendingTasks.every(([key])=>this.intentionalTasks.has(key)));
        if(!controlled)this.loss.unexpectedWorkerTerminations++;
        worker.endedMs = event.atMs;
        for (const [key, pending] of pendingTasks) {
          const reason=this.intentionalTasks.get(key)??(controlled?event.reasonCode:undefined);
          if(reason&&event.name==='terminated'&&event.status==='aborted'){
            this.settle(key,'cancelled',reason);
            if(pending.name==='queued')this.loss.cancelledBeforeStart++;else this.loss.intentionalInterruptedTasks++;
          }else{this.settle(key,event.status??'aborted');this.loss.interruptedTasks++;}
        }
      }
    } else if (event.kind === 'task') {
      const prefix=context.workerId+':producer-';
      const workerProducer=event.producerId===context.workerId||event.producerId.startsWith(prefix)&&/^\d+$/.test(event.producerId.slice(prefix.length));
      if(workerProducer&&(event.name==='started'||event.name==='ended')){
        let row=this.occupancy.get(context.workerId);
        if(!row&&this.occupancy.size<1024){row={clockId:event.clockId,firstMs:event.atMs,lastMs:event.atMs,depth:0,startMs:event.atMs,occupiedMs:0,peakConcurrentTasks:0};this.occupancy.set(context.workerId,row);}
        if(row&&row.clockId===event.clockId&&!this.finished.has(taskKey)){
          row.lastMs=event.atMs;
          if(event.name==='started'){if(row.depth===0)row.startMs=event.atMs;row.depth++;row.peakConcurrentTasks=Math.max(row.peakConcurrentTasks,row.depth);}
          else if(row.depth>0){row.depth--;if(row.depth===0)row.occupiedMs+=Math.max(0,event.atMs-row.startMs);}
        }
      }
      if (event.name === 'queued' || event.name === 'started') {
        if (this.finished.has(taskKey)) { this.loss.lateEvents++;this.loss.lateEventsUnexpected++; return; }
        const old = this.active.get(taskKey);
        if (old && !(old.name === 'queued' && event.name === 'started')) this.loss.invalid++;
        else if (this.active.size >= 4096) this.loss.aggregateGroups++;
        else { this.active.set(taskKey, event); const worker = this.workers.get(context.workerId); if (worker && event.name === 'started') { worker.tasks++; worker.state = 'running'; } }
      } else if (event.name === 'ended') {
        const finished=this.finished.get(taskKey);
        if (finished) {
          this.loss.lateEvents++;
          if(finished.status==='cancelled'&&['cancelled','aborted'].includes(event.status??'')&&
            (['abort-error','request-superseded','user-cancelled'].includes(event.reasonCode??'')||
              ['project-closed','project-replaced'].includes(finished.reasonCode??'')))this.loss.lateCancelledAcks++;
          else this.loss.lateEventsUnexpected++;
          return;
        }
        if (!this.active.has(taskKey)) this.loss.invalid++;
        else {
          const started=this.active.get(taskKey)!;
          if(started.name==='started'&&started.clockId===event.clockId&&event.atMs>=started.atMs){
            const row={family:context.family,workerId:context.workerId,sourceId:context.sourceId,
              status:event.status??'aborted' as TaskStatus,durationMs:event.atMs-started.atMs};
            if(this.slowestTasks.length<10||row.durationMs>this.slowestTasks[this.slowestTasks.length-1].durationMs){
              this.slowestTasks.push(row);this.slowestTasks.sort((a,b)=>b.durationMs-a.durationMs);
              if(this.slowestTasks.length>10)this.slowestTasks.pop();
            }
          }
          if(event.status==='cancelled'&&!['abort-error','request-superseded','user-cancelled'].includes(event.reasonCode??''))
            this.loss.cancelledWithoutReason++;
          this.settle(taskKey, event.status ?? 'aborted', event.reasonCode);
        }
        const worker = this.workers.get(context.workerId);
        if (worker && !worker.endedMs && ![...this.active.values()].some(row => row.context.workerId === context.workerId)) worker.state = 'idle';
      }
    } else if (event.kind === 'phase') {
      if (typeof event.durationMs !== 'number' || !Number.isFinite(event.durationMs) || event.durationMs < 0) { this.loss.invalid++; return; }
      const key = `${context.family}:${event.name}`;
      let phase = this.phases.get(key);
      if (!phase) {
        if (this.phases.size >= 512) { this.loss.aggregateGroups++; return; }
        phase = { stats: new DurationStats(), failed: 0, cancelled: 0, workload: {} }; this.phases.set(key, phase);
      }
      try{if(event.histogram)phase.stats.merge(event.histogram);else phase.stats.add(event.durationMs);}
      catch{this.loss.invalid++;return;}
      if(event.timing!=='aggregate'){
        const row={family:context.family,stage:event.name,workerId:context.workerId,sourceId:context.sourceId,durationMs:event.durationMs};
        if(this.slowestPhases.length<10||row.durationMs>this.slowestPhases[this.slowestPhases.length-1].durationMs){
          this.slowestPhases.push(row);this.slowestPhases.sort((a,b)=>b.durationMs-a.durationMs);
          if(this.slowestPhases.length>10)this.slowestPhases.pop();
        }
      }
      if (event.status === 'failed' || event.status === 'timeout') phase.failed++;
      if (event.status === 'cancelled' || event.status === 'aborted') phase.cancelled++;
      for (const [name, count] of Object.entries(event.workload ?? {})) if (validName.test(name) && Number.isFinite(count) && count >= 0) {
        if (Object.keys(phase.workload).length < 32 || name in phase.workload) phase.workload[name] = (phase.workload[name] ?? 0) + count;
      }
    } else if (event.kind === 'counter') {
      if(event.name==='lifecycle.cancel-requested'){
        const projectCancellation=['project-closed','project-replaced'].includes(event.reasonCode??'');
        const taskCancellation=event.reasonCode==='request-superseded'&&context.workerId!=='host'&&
          context.taskId!==null&&context.attemptId>0;
        if(event.producerId!==`${this.identity.runId}:host`||!projectCancellation&&!taskCancellation||
          projectCancellation&&(context.workerId!=='host'||context.family!=='host'||context.backend!=='host')){
          this.loss.invalid++;return;
        }
        const reason=event.reasonCode!;this.cancellationReasons[reason]=(this.cancellationReasons[reason]??0)+1;
        if(projectCancellation){for(const key of this.active.keys())this.intentionalTasks.set(key,reason);}
        else if(this.active.has(taskKey))this.intentionalTasks.set(taskKey,reason);
      }
      const key = `${context.family}:${event.name}`;
      if (!this.counters.has(key) && this.counters.size >= 512) { this.loss.aggregateGroups++; return; }
      const values = this.counters.get(key) ?? {};
      for (const [name, value] of Object.entries(event.workload ?? {}).slice(0,32)) if (validName.test(name) && Number.isFinite(value)) values[name] = (values[name] ?? 0) + value;
      this.counters.set(key, values);
    } else if (event.kind === 'memory' && event.memory) {
      const metric = event.memory;
      if (!validName.test(metric.name) || (metric.availability === 'available' ? (metric.bytes === null || !Number.isFinite(metric.bytes) || metric.bytes < 0) : metric.bytes !== null)) { this.loss.invalid++; return; }
      const key = `${context.workerId}:${metric.scope}:${metric.name}:${metric.method}`;
      const old = this.memory.get(key);
      if (!old && this.memory.size >= 4096) { this.loss.aggregateGroups++; return; }
      this.memory.set(key, { latest: { ...metric }, atMs: event.atMs, samples: (old?.samples ?? 0) + 1,
        observedPeakBytes: metric.bytes === null ? old?.observedPeakBytes ?? null : Math.max(old?.observedPeakBytes ?? 0, metric.bytes) });
    } else if (event.kind === 'clock' && event.clock) {
      this.clock.set(event.clock.remoteClockId, { ...event.clock });
    } else if (event.kind === 'loss') {
      this.loss.detailEvents += Math.max(0, event.workload?.events ?? 0);
      this.loss.transportFailures++;
    }
    if(this.mode==='benchmark'&&(event.kind==='memory'||event.kind==='counter')){
      this.aggregatedDetail[event.kind]++;
      return;
    }
    if (this.mode === 'benchmark' || this.mode === 'diagnostic') {
      if (this.events.length >= this.detailLimit) this.loss.detailEvents++;
      else this.events.push(event);
      if(this.events.length>=128)this.flushDetails();
    }
  }
  setDetailSink(sink:typeof this.detailSink):void {this.detailSink=sink;this.flushDetails();}
  flushDetails():void {
    while(this.events.length && this.detailSink?.available()) {
      const batch=this.events.splice(0,128);
      try{this.detailSink.send(batch);}catch{this.loss.detailEvents+=batch.length;break;}
    }
    while(this.traceEvents.length&&this.detailSink?.available()){
      const batch=this.traceEvents.splice(0,128);
      try{this.detailSink.send(batch);}catch{this.traceHealth.dropped+=batch.length;break;}
    }
  }
  private settle(key: string, status: TaskStatus, reasonCode?:LifecycleReasonCode): void {
    this.active.delete(key); this.intentionalTasks.delete(key); this.finished.set(key,{status,reasonCode});
    // A Collector belongs to one run. Retain compact terminal tombstones for
    // that lifetime so late acknowledgements cannot become new task outcomes.
    this.outcomes[status] = (this.outcomes[status] ?? 0) + 1;
  }
  drain(): MeasurementEvent[] { const result = [...this.events,...this.traceEvents]; this.events = [];this.traceEvents=[]; return result; }
  intentionalTermination(workerId:string):boolean {
    const keys=[...this.active].filter(([,event])=>event.context.workerId===workerId).map(([key])=>key);
    return keys.length>0&&keys.every(key=>this.intentionalTasks.has(key));
  }
  terminationReason(workerId:string):LifecycleReasonCode|undefined {
    const keys=[...this.active].filter(([,event])=>event.context.workerId===workerId).map(([key])=>key);
    if(!keys.length)return 'worker-idle';
    return keys.every(key=>this.intentionalTasks.has(key))?this.intentionalTasks.get(keys[0]):undefined;
  }
  resourceState(){
    return {pendingTasks:this.active.size,activeWorkerIds:[...this.workers].filter(([,worker])=>
      worker.state!=='terminated'&&worker.state!=='failed').map(([id])=>id)};
  }
  snapshot() {
    const lifecycleIssues=[
      this.active.size?'active-tasks':null,
      this.loss.interruptedTasks?'worker-interrupted-tasks':null,
      this.loss.unexpectedWorkerTerminations?'unexpected-worker-termination':null,
      this.loss.cancelledWithoutReason?'cancellation-reason-missing':null,
      this.loss.lateEventsUnexpected?'unexpected-late-events':null,
      (this.outcomes.timeout??0)>0?'task-timeout':null,
      (this.outcomes.aborted??0)>0?'unexplained-task-abort':null,
    ].filter((value):value is string=>!!value);
    return { version: MEASUREMENT_VERSION, identity: { ...this.identity }, mode: this.mode,
      traceHealth:{...this.traceHealth,droppedByType:{...this.traceHealth.droppedByType},buffered:this.traceEvents.length,
        activeSpanCount:this.traceActive.size,activeSpans:[...this.traceActive].slice(0,64)},
      traceComplete:this.traceHealth.dropped===0&&this.traceHealth.activeOverflow===0&&this.traceHealth.sequenceGaps===0&&this.traceHealth.duplicate===0&&this.traceHealth.invalid===0&&this.traceHealth.foreignRun===0&&this.traceActive.size===0,
      phases: Object.fromEntries([...this.phases].map(([key, value]) => [key, { ...value.stats.snapshot(), failed: value.failed, cancelled: value.cancelled, workload: { ...value.workload } }])),
      slowestPhases:this.slowestPhases.map(row=>({...row})),
      slowestTasks:this.slowestTasks.map(row=>({...row})),
      workers: Object.fromEntries([...this.workers].map(([key, value]) => [key, { ...value }])),
      workerOccupancy:Object.fromEntries([...this.occupancy].map(([key,row])=>[key,{...row,idleBetweenTasksMs:Math.max(0,row.lastMs-row.firstMs-row.occupiedMs),scope:'first-task-start-to-last-task-end',includesReadAndBackpressureWait:true,incomplete:row.depth>0}])),
      memory: Object.fromEntries([...this.memory].map(([key, value]) => [key, { ...value, latest: { ...value.latest } }])),
      activeTasks: [...this.active.values()].map(event => ({ ...event.context })),
      taskOutcomes: { ...this.outcomes }, counters: Object.fromEntries([...this.counters].map(([key,values]) => [key,{...values}])),
      bufferedEvents:this.events.length,
      detailPolicy:this.mode==='benchmark'?'task-phase-timeline-v1':'full-detail',aggregatedDetail:{...this.aggregatedDetail},
      clockCalibration: Object.fromEntries(this.clock), loss: { ...this.loss },
      lifecycleComplete:lifecycleIssues.length===0,lifecycleIssues,
      lifecycleCancellationReasons:{...this.cancellationReasons},
      detailComplete: this.loss.detailEvents === 0 && this.loss.sequenceGaps === 0 && this.loss.invalid === 0 &&
        this.loss.aggregateGroups === 0 && this.loss.foreignRun === 0 && this.loss.duplicate === 0 && this.loss.transportFailures===0 &&
        this.traceHealth.dropped===0&&this.traceHealth.activeOverflow===0,
      aggregateComplete:this.loss.sequenceGaps===0&&this.loss.invalid===0&&this.loss.aggregateGroups===0&&
        this.loss.foreignRun===0&&this.loss.duplicate===0&&this.loss.transportFailures===0,
      cpuTimeAvailable: false, memoryTotalsAreAdditive: false };
  }
}
