import { MEASUREMENT_VERSION, type TraceContext, type MetricsSink, type MeasurementEvent, type PhaseScope, type TaskStatus, type Workload, type MeasurementMode, type MemoryMetric } from './types.js';

const noopPhase: PhaseScope = { id: 'off', end() {} };
/** Clock and transport are injected. No browser, Node, renderer or application state. */
export class Probe {
  private sequence = 0;
  private spanSequence = 0;
  constructor(readonly producerId: string, readonly clockId: string, readonly mode: MeasurementMode,
    private readonly now: () => number, private readonly sink: MetricsSink) {}
  event(context: TraceContext, event: Omit<MeasurementEvent, 'version' | 'context' | 'producerId' | 'sequence' | 'clockId' | 'atMs'>): void {
    if (this.mode === 'off') return;
    this.sink.emit({ ...event, version: MEASUREMENT_VERSION, context: { ...context }, producerId: this.producerId,
      sequence: ++this.sequence, clockId: this.clockId, atMs: this.now() });
  }
  phase(context: TraceContext, name: string, parentSpanId: string | null = null): PhaseScope {
    if (this.mode === 'off') return noopPhase;
    const started = this.now(), id = `${this.producerId}:${++this.spanSequence}`; let ended = false;
    return { id, end: (status: TaskStatus = 'completed', workload?: Workload) => {
      if (ended) return; ended = true;
      this.event(context, { kind: 'phase', name, spanId: id, parentSpanId, startMs: started,
        durationMs: Math.max(0, this.now() - started), timing: 'interval', status, workload });
    } };
  }
  record(context: TraceContext, name: string, durationMs: number, workload?: Workload): void {
    this.event(context, { kind: 'phase', name, durationMs, timing: 'aggregate', status: 'completed', workload });
  }
  memory(context: TraceContext, metric: MemoryMetric): void { this.event(context, { kind: 'memory', name: metric.name, memory: metric }); }
  async measure<T>(context: TraceContext, name: string, work: () => Promise<T>): Promise<T> {
    const phase = this.phase(context, name);
    try { const result = await work(); phase.end(); return result; }
    catch (error) { phase.end((error as { name?: string })?.name === 'AbortError' ? 'cancelled' : 'failed'); throw error; }
  }
  measureSync<T>(context: TraceContext, name: string, work: () => T): T {
    const phase = this.phase(context, name);
    try { const result = work(); phase.end(); return result; }
    catch (error) { phase.end((error as { name?: string })?.name === 'AbortError' ? 'cancelled' : 'failed'); throw error; }
  }
}
