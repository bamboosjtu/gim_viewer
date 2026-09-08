import type { PerfSession } from '../utils/perfTimings.js';

export type SubstationBackgroundTaskName =
  | 'remainingIfc'
  | 'spatialSemanticCacheRestore'
  | 'spatialSemanticRebuild'
  | 'stdSld'
  | 'cachePersistence'
  | 'devGeometry';

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
  /** Heavy tasks never run together and only start after all IFC. */
  heavy: boolean;
  startAfter: 'interactive' | 'allIfcReady';
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
}

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
  private allIfcReady = false;
  private lightRunning = false;
  private heavyRunning = false;
  private drainScheduled = false;

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

  /** Mark all not-yet-started tasks cancelled when a session becomes stale. */
  cancelPending(): void {
    for (const record of this.tasks.values()) {
      if (record.state !== 'queued') continue;
      record.state = 'cancelled';
      this.emit(record);
    }
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
        && record.spec.startAfter === 'interactive')
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
    if (!this.allIfcReady || this.heavyRunning || !this.options.isCurrent()) return;
    // Do not choose DEV geometry before a spatial cache restore has classified
    // hit/miss.  A miss queues the rebuild ahead of DEV geometry.
    const spatialRestore = this.tasks.get('spatialSemanticCacheRestore');
    if (spatialRestore
      && (spatialRestore.state === 'queued' || spatialRestore.state === 'running')
      && spatialRestore.spec.blocksHeavy) return;
    const candidates = Array.from(this.tasks.values())
      .filter((record) => record.state === 'queued'
        && record.spec.heavy
        && record.spec.startAfter === 'allIfcReady')
      .sort((a, b) => a.spec.priority - b.spec.priority || a.queuedAt - b.queuedAt);
    const next = candidates[0];
    if (next) {
      this.heavyRunning = true;
      void this.run(next).finally(() => {
        this.heavyRunning = false;
        this.scheduleDrain();
      });
      return;
    }
    this.drainLowPriority();
  }

  private drainLowPriority(): void {
    if (!this.allIfcReady || this.heavyRunning || this.lightRunning || !this.options.isCurrent()) return;
    const candidates = Array.from(this.tasks.values())
      .filter((record) => record.state === 'queued'
        && !record.spec.heavy
        && record.spec.startAfter === 'allIfcReady')
      .sort((a, b) => a.spec.priority - b.spec.priority || a.queuedAt - b.queuedAt);
    const next = candidates[0];
    if (!next) return;
    this.lightRunning = true;
    void this.run(next).finally(() => {
      this.lightRunning = false;
      this.scheduleDrain();
    });
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
