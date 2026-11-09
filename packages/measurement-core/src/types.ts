import {MEASUREMENT_VERSION} from './version.mjs';
export {MEASUREMENT_VERSION} from './version.mjs';
export type MeasurementMode = 'off' | 'summary' | 'benchmark' | 'diagnostic';
export type WorkerFamily = 'host' | 'measurement-probe' | 'dev' | 'ifc-conversion' | 'ifc-regional' | 'ifc-fine' | 'spatial' | 'engineering' | 'line';
export type TaskStatus = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'aborted';
export type LifecycleReasonCode = 'abort-error' | 'worker-exception' | 'request-superseded' | 'user-cancelled'
  | 'project-closed' | 'project-replaced' | 'cancelled-before-start';
export type Availability = 'available' | 'unavailable' | 'unsupported' | 'not-applicable';
export type MemoryQuality = 'measured-capacity' | 'runtime-sampled' | 'estimated' | 'budget';

export interface RunIdentity {
  runId: string;
  sampleId: string | null;
  sourceSha256: string | null;
  buildId: string | null;
  generation: number | null;
  geometryToken: number | null;
  requestId: string | null;
}
export interface TraceContext extends RunIdentity {
  workerId: string;
  family: WorkerFamily;
  backend: 'host' | 'web-worker' | 'node-process';
  taskId: string | null;
  attemptId: number;
  parentTaskId: string | null;
  sourceId: string | null;
  geometryLod: number | null;
}
export interface MemoryMetric {
  name: string;
  scope: 'host' | 'worker' | 'isolate' | 'process' | 'process-tree' | 'graphics';
  method: string;
  quality: MemoryQuality;
  availability: Availability;
  bytes: number | null;
  reason?: string;
  sampleDelayMs: number;
}
export type Workload = Record<string, number>;
export type StageObserver = (name:string,durationMs:number,workload?:Workload)=>void;
export type BufferObserver = (role:string,buffers:Iterable<ArrayBufferLike|ArrayBufferView>)=>(()=>void);
export interface MeasurementEvent {
  version: typeof MEASUREMENT_VERSION;
  context: TraceContext;
  producerId: string;
  sequence: number;
  clockId: string;
  atMs: number;
  kind: 'worker' | 'task' | 'phase' | 'memory' | 'counter' | 'clock' | 'loss';
  name: string;
  status?: TaskStatus;
  /** Controlled lifecycle category, never a raw error message or source path. */
  reasonCode?: LifecycleReasonCode;
  workerUrl?:string;
  resource?:{id:string;action:'acquire'|'copy'|'release'|'transfer';owner:string;to?:string;bytes:number};
  startMs?: number;
  durationMs?: number;
  timing?: 'interval' | 'aggregate';
  histogram?:ReturnType<import('./stats.js').DurationStats['histogram']>;
  spanId?: string;
  parentSpanId?: string | null;
  workload?: Workload;
  memory?: MemoryMetric;
  clock?: { remoteClockId: string; offsetMs: number; uncertaintyMs: number };
}
export interface PhaseScope {
  readonly id: string;
  end(status?: TaskStatus, workload?: Workload): void;
}
export interface MetricsSink {
  emit(event: MeasurementEvent): void;
}
export const NOOP_SINK: MetricsSink = { emit() {} };
