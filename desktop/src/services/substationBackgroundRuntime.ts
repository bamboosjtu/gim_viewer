import type { PerfSession } from '../utils/perfTimings.js';

export type SubstationBackgroundTaskName =
  | 'remainingIfc'
  | 'spatialSemanticCacheRestore'
  | 'spatialSemanticRebuild'
  | 'stdSld'
  | 'cachePersistence'
  | 'devGeometry';
export type SubstationBackgroundGate = 'interactive' | 'coordinateAnchorReady' | 'allIfcReady' | 'allIfcPreviewsReady';

export type SubstationBackgroundTaskState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface SubstationBackgroundTaskEvent {
  task: SubstationBackgroundTaskName;
  state: SubstationBackgroundTaskState;
  priority: number;
  heavy: boolean;
  queueWaitMs?: number;
  durationMs?: number;
  error?: string;
  sessionId: number;
}

export interface SubstationBackgroundTaskSpec {
  task: SubstationBackgroundTaskName;
  /** Lower values run first within the same scheduler lane. */
  priority: number;
  /** Heavy tasks never run together; each task retains its explicit readiness gate. */
  heavy: boolean;
  startAfter: SubstationBackgroundGate;
  /** A cheap cache restore gates heavy scheduling until it has classified hit/miss. */
  blocksHeavy?: boolean;
  /** Manually driven lifecycle marker, never selected by a drain. */
  manual?: boolean;
  run: () => Promise<void> | void;
}

interface TaskRecord {
  spec: SubstationBackgroundTaskSpec;
  state: SubstationBackgroundTaskState;
  queuedAt: number;
  startedAt?: number;
}

export interface SubstationBackgroundCoordinatorOptions {
  session: PerfSession;
  isCurrent: () => boolean;
  onEvent?: (event: SubstationBackgroundTaskEvent) => void;
  onFineEvent?: (event: { key: string; state: 'queued'|'running'|'completed'|'failed'|'cancelled'; atMs: number; queueWaitMs?: number; durationMs?: number; checkpoint?: string }) => void;
  onCheckpoint?: (unit: DevWorkCheckpoint & { serviced: boolean; resumeAtMs: number; pauseMs: number }) => void;
}

/** Completed work only; duration excludes time servicing a user request. */
export interface DevWorkCheckpoint { phase: 'cold-dev'|'warm-dev'|'warm-glb-read'|'raw-prepare'|'raw-commit'|'cache-repair'; path: string; durationMs: number }
export type DevCheckpointHandler = (unit: DevWorkCheckpoint) => Promise<void>;

/**
 * Small, substation-only post-interactive scheduler.
 *
 * This is intentionally not a general task framework.  It has two explicit
 * lanes: light post-interactive work (cache classification and STD/SLD) and a
 * serialized heavy lane (spatial rebuild / DEV geometry).  Remaining IFC is
 * still parsed by the existing sequential loop; the coordinator only owns
 * its lifecycle markers so all background work has one observable owner.
 */
export class SubstationBackgroundCoordinator {
  private readonly tasks = new Map<SubstationBackgroundTaskName, TaskRecord>();
  private interactive = false;
  private coordinateAnchorReady = false;
  private allIfcReady = false;
  private allIfcPreviewsReady = false;
  private lightRunning = false;
  private heavyRunning = false;
  private drainScheduled = false;
  private priorityWork = new Map<string, {run:()=>Promise<void>;promise:Promise<void>;resolve:()=>void;reject:(error:unknown)=>void;priority:number;order:number;queuedAt:number;state:'queued'|'running'}>();
  private priorityOrder=0;
  private priorityRunning=false;
  private activeHeavyTask: SubstationBackgroundTaskName | null = null;

  constructor(private readonly options: SubstationBackgroundCoordinatorOptions) {}

  enqueue(spec: SubstationBackgroundTaskSpec): boolean {
    const existing = this.tasks.get(spec.task);
    if (existing && (existing.state === 'queued' || existing.state === 'running')) return false;
    const record: TaskRecord = {
      spec,
      state: 'queued',
      queuedAt: performance.now(),
    };
    this.tasks.set(spec.task, record);
    this.emit(record);
    this.scheduleDrain();
    return true;
  }

  /** Register the sequential IFC tail before interactive is reached. */
  registerRemainingIfc(): void {
    this.enqueue({
      task: 'remainingIfc',
      priority: 0,
      heavy: false,
      startAfter: 'interactive',
      blocksHeavy: true,
      manual: true,
      run: () => undefined,
    });
  }

  startRemainingIfc(): void {
    this.startManual('remainingIfc');
  }

  completeRemainingIfc(): void {
    this.completeManual('remainingIfc');
  }

  markInteractive(): void {
    if (this.interactive) return;
    this.interactive = true;
    this.scheduleDrain();
  }

  markAllIfcReady(): void {
    if (this.allIfcReady) return;
    this.allIfcReady = true;
    this.scheduleDrain();
  }

  markAllIfcPreviewsReady():void {if(this.allIfcPreviewsReady)return;this.allIfcPreviewsReady=true;this.scheduleDrain();}

  markCoordinateAnchorReady():void {if(this.coordinateAnchorReady)return;this.coordinateAnchorReady=true;this.scheduleDrain();}

  enqueueUserIfcFine(key:string,run:()=>Promise<void>):{promise:Promise<void>;cancel:()=>boolean} {
    const existing=this.priorityWork.get(key);
    if(existing)return {promise:existing.promise,cancel:()=>this.cancelUserIfcFine(key)};
    let resolve!:()=>void,reject!:(error:unknown)=>void;
    const promise=new Promise<void>((res,rej)=>{resolve=res;reject=rej;});
    this.priorityWork.set(key,{run,promise,resolve,reject,priority:0,order:this.priorityOrder++,queuedAt:performance.now(),state:'queued'});
    this.options.onFineEvent?.({key,state:'queued',atMs:performance.now()});
    this.scheduleDrain();
    return {promise,cancel:()=>this.cancelUserIfcFine(key)};
  }

  cancelUserIfcFine(key:string):boolean {
    const task=this.priorityWork.get(key);if(!task||task.state!=='queued')return false;
    this.priorityWork.delete(key);const error=new Error('精细几何请求已取消排队');error.name='AbortError';task.reject(error);
    this.options.onFineEvent?.({key,state:'cancelled',atMs:performance.now(),queueWaitMs:performance.now()-task.queuedAt});this.scheduleDrain();return true;
  }

  /** The DEV caller awaits this at an atomic boundary. Keep its heavy lease
   * held while servicing exactly one Fine request; no second heavy drain can
   * start. A subsequent DEV unit always gets a turn before another yield. */
  async servicePendingUserFineAtCheckpoint(unit: DevWorkCheckpoint): Promise<void> {
    if (!this.options.isCurrent()) { this.cancelPending(); return; }
    const started = performance.now();
    const next = this.interactive && this.heavyRunning && this.activeHeavyTask === 'devGeometry'
      && !this.priorityRunning ? this.nextUserFine() : undefined;
    if (next) await this.runUserFine(next[0], next[1], `${unit.phase}:${unit.path}`);
    this.options.onCheckpoint?.({...unit,serviced:!!next,resumeAtMs:performance.now(),pauseMs:performance.now()-started});
  }

  private nextUserFine() {
    return [...this.priorityWork.entries()].filter(([,task])=>task.state==='queued')
      .sort((a,b)=>a[1].order-b[1].order)[0];
  }

  private async runUserFine(key:string, task: NonNullable<ReturnType<SubstationBackgroundCoordinator['nextUserFine']>>[1], checkpoint?:string):Promise<void> {
    task.state='running';this.priorityRunning=true;
    const started=performance.now();
    try {
      this.options.onFineEvent?.({key,state:'running',atMs:started,queueWaitMs:started-task.queuedAt,checkpoint});
      await task.run(); task.resolve();
      this.options.onFineEvent?.({key,state:this.options.isCurrent()?'completed':'cancelled',atMs:performance.now(),durationMs:performance.now()-started,checkpoint});
    } catch(error) {
      task.reject(error);
      this.options.onFineEvent?.({key,state:this.options.isCurrent()?'failed':'cancelled',atMs:performance.now(),durationMs:performance.now()-started,checkpoint});
    } finally {
      this.priorityWork.delete(key);this.priorityRunning=false;
      if(!this.options.isCurrent())this.cancelPending();
    }
  }

  /** Mark all not-yet-started tasks cancelled when a session becomes stale. */
  cancelPending(): void {
    for (const record of this.tasks.values()) {
      if (record.state !== 'queued') continue;
      record.state = 'cancelled';
      this.emit(record);
    }
    this.cancelPendingUserIfcFine();
  }

  cancelPendingUserIfcFine():void {
    for(const [key,task] of this.priorityWork)if(task.state==='queued')this.cancelUserIfcFine(key);
  }

  snapshot(): Array<SubstationBackgroundTaskEvent & { queuedMs?: number }> {
    const now = performance.now();
    return Array.from(this.tasks.values()).map((record) => ({
      task: record.spec.task,
      state: record.state,
      priority: record.spec.priority,
      heavy: record.spec.heavy,
      ...(record.state === 'queued' ? { queuedMs: Math.max(0, now - record.queuedAt) } : {}),
      sessionId: this.options.session.id,
    }));
  }

  private startManual(task: SubstationBackgroundTaskName): void {
    const record = this.tasks.get(task);
    if (!record || record.state !== 'queued') return;
    if (!this.options.isCurrent()) {
      record.state = 'cancelled';
      this.emit(record);
      return;
    }
    record.state = 'running';
    record.startedAt = performance.now();
    this.emit(record);
  }

  private completeManual(task: SubstationBackgroundTaskName): void {
    const record = this.tasks.get(task);
    if (!record || record.state !== 'running') return;
    record.state = this.options.isCurrent() ? 'completed' : 'cancelled';
    this.emit(record);
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drainLight();
      this.drainHeavy();
    });
  }

  private drainLight(): void {
    if (!this.interactive || this.lightRunning) return;
    if (!this.options.isCurrent()) {
      this.cancelPending();
      return;
    }
    const candidates = Array.from(this.tasks.values())
      .filter((record) => record.state === 'queued'
        && !record.spec.heavy
        && !record.spec.manual
        && (record.spec.startAfter === 'interactive' || record.spec.startAfter === 'coordinateAnchorReady')
        && this.gateReady(record.spec.startAfter))
      .sort((a, b) => a.spec.priority - b.spec.priority || a.queuedAt - b.queuedAt);
    const next = candidates[0];
    if (!next) return;
    this.lightRunning = true;
    void this.run(next).finally(() => {
      this.lightRunning = false;
      this.scheduleDrain();
    });
  }

  private drainHeavy(): void {
    if (this.heavyRunning || !this.options.isCurrent()) return;
    if(this.interactive&&!this.priorityRunning&&this.priorityWork.size){
      const next=this.nextUserFine();
      if(next){this.heavyRunning=true;
        void this.runUserFine(next[0],next[1]).finally(()=>{this.heavyRunning=false;this.scheduleDrain();});return;}
    }
    // Do not choose DEV geometry before a spatial cache restore has classified
    // hit/miss.  A miss queues the rebuild ahead of DEV geometry.
    const spatialRestore = this.tasks.get('spatialSemanticCacheRestore');
    if (spatialRestore
      && (spatialRestore.state === 'queued' || spatialRestore.state === 'running')
      && spatialRestore.spec.blocksHeavy) return;
    const candidates = Array.from(this.tasks.values())
      .filter((record) => record.state === 'queued'
        && record.spec.heavy
        && this.gateReady(record.spec.startAfter))
      .sort((a, b) => a.spec.priority - b.spec.priority || a.queuedAt - b.queuedAt);
    const next = candidates[0];
    if (next) {
      this.heavyRunning = true;
      this.activeHeavyTask = next.spec.task;
      void this.run(next).finally(() => {
        this.activeHeavyTask = null;
        this.heavyRunning = false;
        this.scheduleDrain();
      });
      return;
    }
    this.drainLowPriority();
  }

  private drainLowPriority(): void {
    if ((!this.allIfcReady&&!this.allIfcPreviewsReady) || this.heavyRunning || this.lightRunning || !this.options.isCurrent()) return;
    const candidates = Array.from(this.tasks.values())
      .filter((record) => record.state === 'queued'
        && !record.spec.heavy
        && this.gateReady(record.spec.startAfter))
      .sort((a, b) => a.spec.priority - b.spec.priority || a.queuedAt - b.queuedAt);
    const next = candidates[0];
    if (!next) return;
    this.lightRunning = true;
    void this.run(next).finally(() => {
      this.lightRunning = false;
      this.scheduleDrain();
    });
  }

  private gateReady(gate:SubstationBackgroundGate):boolean {
    if(gate==='interactive')return this.interactive;
    if(gate==='coordinateAnchorReady')return this.interactive&&this.coordinateAnchorReady;
    if(gate==='allIfcPreviewsReady')return this.allIfcPreviewsReady||this.allIfcReady;
    return this.allIfcReady;
  }

  private async run(record: TaskRecord): Promise<void> {
    if (record.state !== 'queued') return;
    if (!this.options.isCurrent()) {
      record.state = 'cancelled';
      this.emit(record);
      return;
    }
    record.state = 'running';
    record.startedAt = performance.now();
    this.emit(record);
    try {
      await record.spec.run();
      record.state = this.options.isCurrent() ? 'completed' : 'cancelled';
      this.emit(record);
    } catch (error) {
      record.state = this.options.isCurrent() ? 'failed' : 'cancelled';
      this.emit(record, error);
    }
  }

  private emit(record: TaskRecord, error?: unknown): void {
    const now = performance.now();
    this.options.onEvent?.({
      task: record.spec.task,
      state: record.state,
      priority: record.spec.priority,
      heavy: record.spec.heavy,
      ...(record.startedAt != null
        ? { queueWaitMs: Math.max(0, record.startedAt - record.queuedAt) }
        : {}),
      ...(record.startedAt != null && record.state !== 'queued'
        ? { durationMs: Math.max(0, now - record.startedAt) }
        : {}),
      ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}),
      sessionId: this.options.session.id,
    });
  }
}
