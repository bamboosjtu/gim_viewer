import { reportBackgroundError } from '../utils/backgroundErrors.js';
/** Owns template deduplication, cache input leases, compilation, validation and LRU lifetime. */
import { deleteDevArtifact, type DevArtifactRead, type DevArtifactReadStatus } from '@desktop/devLodCache.js';
import * as THREE from 'three';
import type { ProjectLoadSession } from '../shared/projectSession.js';
import { diagnosticFromSerialization } from '../gim/geometry/geometryDiagnostics.js';
import { InvalidDevGeometryError } from '../gim/geometry/sourceGeometryError.js';
import { ByteLru } from '../utils/byteLru.js';
import { ByteWorkBudget } from '../utils/byteWorkBudget.js';
import { perfCurrentSession, perfMeasureTaskPhase, perfRecordTaskPhase, type PerfTaskIdentity } from '../utils/perfTimings.js';
import { WorkQueue } from '../utils/workQueue.js';
import { type DeviceLod } from '../viewer/devLodPolicy.js';
import { invalidGeometryExtent } from '../viewer/geometryBounds.js';
import { type DevGeometryPreprocessor } from './devGeometryWorkerClient.js';
import { DevGlbTemplate, validateDevGlbTemplate } from './devGlbTemplateRuntime.js';
import type { DevLodDiagnostics } from './devLodDiagnostics.js';
import type { CachedTemplate, TemplateRow } from './devLodTypes.js';
import { type DevSourceBounds } from './devSpatialCatalog.js';
import { DevTemplateCacheReader } from './devTemplateCacheReader.js';
import { parseDevGlbAsset } from './glbCacheService.js';

const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(v => v.toString(16).padStart(2, '0')).join('');
export interface TemplateLifecycle {
  kind?: 'queue'|'occupancy';
  key:string;devPath:string;taskId?:string;lod?:DeviceLod;priority:number;admittedPriority:number;
  slotCapacityAtEnqueue:number;slotCapacity:number;slotsBusyAtEnqueue:number;queueDepthAtEnqueue:number;slotsBusyAtAdmit:number;
  queueWaitMs:number;slotOccupancyMs:number;cacheReadMs:number;workerAwaitMs:number;
  workerQueueWaitTotalMs:number|null;workerDispatches:number|null;inputBudgetWaitMs:number;
  outputBytes:number;cacheStatus:string;memoryPressure:string;status:string;
}
export interface DevLodTemplateStoreOptions {
  verifySourceEnvelope?: (devPath:string,scene:THREE.Group)=>Promise<void>;
  session: ProjectLoadSession;
  perf: ReturnType<typeof perfCurrentSession>;
  diagnostics: DevLodDiagnostics;
  worker: () => DevGeometryPreprocessor;
  current: () => boolean;
  memoryPressure?: () => string;
  key: (dev: string, lod: DeviceLod) => string;
  pinned: () => Set<string>;
  isWanted: (key: string) => boolean;
  taskIdentity: (source: string, kind: string, lod?: DeviceLod, priority?: number) => PerfTaskIdentity;
  catalogHint: (dev: string) => Promise<DevArtifactRead<DevSourceBounds>>;
  markEmptyDev: (dev: string) => void;
  recoverMissingSources: (key: string, lod: DeviceLod) => void;
  prepareMissingTemplateSources: (dev: string) => Promise<void>;
  recordCacheDecision: (dev: string, lod: DeviceLod, status: DevArtifactReadStatus | 'compiled', reason?: string) => void;
  persistsTemplate: (lod: DeviceLod, generated: boolean, priority: number, demand: number) => boolean;
  persistArtifact: import('./devLodArtifactWriter.js').DevLodArtifactWriter['persistArtifact'];
  reportDiagnostic: (diagnostic: ReturnType<typeof diagnosticFromSerialization>) => void;
}
export class DevLodTemplateStore {
  private released = false;
  private get worker() { return this.options.worker(); }
  constructor(private readonly options: DevLodTemplateStoreOptions) { this.cacheReader = new DevTemplateCacheReader(this.inputBudget, options.session); }
  pending = new Map<string, Promise<TemplateRow | null>>();

  nullResults = new Map<string, 'empty' | 'unsupported'>();

  priorities = new Map<string, number>();

  /** L1 demand counter for the session. A repeated L1 compile after an eviction
     * marks the template as hot enough to persist; the first near-view compile
     * stays in memory only. */
  templateDemand = new Map<string, number>();

  templateSlots = 0;

  private readonly slotOwners = new Map<string,{devPath:string;startedAt:number;priority:number}>();
  private readonly slowQueue: TemplateLifecycle[] = [];
  private readonly slowOccupancy: TemplateLifecycle[] = [];
  private recordSlow(rows:TemplateLifecycle[],row:TemplateLifecycle,field:'queueWaitMs'|'slotOccupancyMs'):void{
    rows.push(row);rows.sort((a,b)=>b[field]-a[field]);if(rows.length>20)rows.length=20;
  }
  /** Private paths are removed by the benchmark controller before publication. */
  templateDiagnostics():TemplateLifecycle[]{
    const now=performance.now();
    const active=[...this.slotOwners.entries()].map(([key,owner])=>({kind:'occupancy' as const,
      key,devPath:owner.devPath,priority:owner.priority,admittedPriority:owner.priority,
      slotCapacityAtEnqueue:this.worker.cacheConcurrency,slotCapacity:this.worker.cacheConcurrency,slotsBusyAtEnqueue:0,queueDepthAtEnqueue:0,slotsBusyAtAdmit:this.templateSlots,
      queueWaitMs:0,slotOccupancyMs:now-owner.startedAt,cacheReadMs:0,workerAwaitMs:0,
      workerQueueWaitTotalMs:null,workerDispatches:null,inputBudgetWaitMs:0,outputBytes:0,cacheStatus:'in-progress',memoryPressure:this.options.memoryPressure?.()??'unknown',
      status:'running'}));
    return [...this.slowQueue.map(row=>({...row,kind:'queue' as const})),
      ...[...this.slowOccupancy,...active].sort((a,b)=>b.slotOccupancyMs-a.slotOccupancyMs)
        .slice(0,20).map(row=>({...row,kind:'occupancy' as const}))];
  }

  inputBudget = new ByteWorkBudget(128 * 1024 * 1024);

  cacheReader: DevTemplateCacheReader<CachedTemplate>;

  templateWaiters = new Map<string, { queuedAt: number; devPath:string; resolve: (release: () => void) => void; reject: (error: Error) => void }>();

  templateQueue = new WorkQueue<{ queuedAt: number; devPath:string; resolve: (release: () => void) => void; reject: (error: Error) => void }>();

  sourceFailures = new Map<string, InvalidDevGeometryError>();

  templates = new ByteLru<TemplateRow>(128 * 1024 * 1024, row => { row.template.dispose(); if (!this.released) this.options.diagnostics.templateEvictions++; });

  acquireTemplateSlot(key: string,devPath=key): Promise<() => void> {
    return new Promise((resolve, reject) => { const waiter = { queuedAt: performance.now(), devPath, resolve, reject }; this.templateWaiters.set(key, waiter); this.templateQueue.set(key, waiter, this.priorities.get(key) ?? 4, waiter.queuedAt); this.drainTemplates(); });
  }

  private drainTemplates(): void {
    while (this.options.current() && this.templateSlots < (this.worker.cacheConcurrency ?? Math.max(8, this.worker.workerCount * 8)) && this.templateWaiters.size) {
      const [key, waiter] = this.templateQueue.take()!;
      this.templateWaiters.delete(key); this.templateSlots++;
      this.slotOwners.set(key,{devPath:waiter.devPath,startedAt:performance.now(),priority:this.priorities.get(key)??4});
      let released = false;
      waiter.resolve(() => { if (released) return; released = true; this.slotOwners.delete(key); this.templateSlots--; this.drainTemplates(); });
    }
  }

  async template(dev: string, lod: DeviceLod, priority: number): Promise<TemplateRow | null> {
    if (this.sourceFailures.has(dev)) throw this.sourceFailures.get(dev)!;
    const key = this.options.key(dev, lod), cached = this.templates.get(key);
    if (cached) {
      const task = { ...(cached.task ?? this.options.taskIdentity(dev, 'template', lod, priority)), cacheSource: 'memory' as const, priority };
      perfRecordTaskPhase(task, 'memoryTemplate', 0, this.options.perf);
      return { ...cached, task };
    }
    if (this.nullResults.has(key)) return null;
    this.priorities.set(key, Math.min(this.priorities.get(key) ?? priority, priority));
    const waiter = this.templateWaiters.get(key); if (waiter) this.templateQueue.set(key, waiter, this.priorities.get(key)!, waiter.queuedAt);
    const old = this.pending.get(key); if (old) { this.worker.promote(key, priority); return old; }
    const identity = this.options.taskIdentity(dev, 'template', lod, priority), taskStarted = performance.now();
    const slotCapacityAtEnqueue=this.worker.cacheConcurrency,
      slotsBusyAtEnqueue=this.templateSlots,queueDepthAtEnqueue=this.templateWaiters.size;
    let admittedAt=0,admittedPriority=priority,cacheReadMs=0,workerAwaitMs=0,
      workerQueueWaitTotalMs:number|null=null,workerDispatches:number|null=null,inputBudgetWaitMs=0,
      outputBytes=0,observedCacheStatus='not-read',memoryPressure='unknown',slotOccupancyMs=0,
      slotCapacity=0,slotsBusyAtAdmit=0;
    const promise = (async () => {
      const releaseSlot = await perfMeasureTaskPhase(identity, 'templateQueue', () => this.acquireTemplateSlot(key,dev), this.options.perf);
      admittedAt=performance.now();admittedPriority=this.priorities.get(key)??priority;
      memoryPressure=this.options.memoryPressure?.()??'unknown';
      slotCapacity=this.worker.cacheConcurrency;slotsBusyAtAdmit=this.templateSlots;
      let releaseInput: (() => void) | undefined;
      try {
        // Concurrent requests share one bounded native batch reservation.
        const cacheReadAt=performance.now();
        const lease = await perfMeasureTaskPhase(identity, 'cacheRead', () => this.cacheReader.read(key), this.options.perf);
        cacheReadMs=performance.now()-cacheReadAt;observedCacheStatus=lease.status;releaseInput = lease.release;
        identity.priority = this.priorities.get(key) ?? priority;
        identity.cacheSource = lease.status === 'hit' ? 'disk' : 'compiled';
        if (!this.options.current()) return null;
        let artifact: CachedTemplate | undefined = lease.value;
        let parsed: Awaited<ReturnType<typeof parseDevGlbAsset>> = null;
        let validated:Awaited<ReturnType<typeof parseDevGlbAsset>>=null;
        const validate=async()=>{
          if(!parsed)return false;
          if(validated===parsed)return true;
          const started=performance.now();
          await this.options.verifySourceEnvelope?.(dev,parsed.scene);
          if(!this.options.current())throw new DOMException('DEV source verification expired','AbortError');
          const valid=validateDevGlbTemplate(parsed).shareable && !invalidGeometryExtent(parsed.scene);
          perfRecordTaskPhase(identity,'vertexValidation',performance.now()-started,this.options.perf,valid?'completed':'failed');
          if(valid)validated=parsed;
          return valid;
        };
        let generated = false;
        let demand = lod === 1 ? this.templateDemand.get(key) ?? 0 : 0;
        if (!this.options.current()) return null;
        const cacheStatus = lease.status;
        if (cacheStatus === 'read-error') {
          this.options.diagnostics.lodReadErrors[lod]++;
          this.options.diagnostics.cacheReadErrorCount++;
          this.options.recordCacheDecision(dev, lod, 'read-error', lease.error);
          this.options.diagnostics.errors.push(`模板读取失败 ${dev} LOD${lod}: ${lease.error ?? ''}`);
          if (this.options.diagnostics.errors.length > 32) this.options.diagnostics.errors.shift();
          artifact = undefined;
        } else if (cacheStatus === 'invalid') {
          this.options.diagnostics.lodInvalid[lod]++;
          this.options.diagnostics.cacheInvalidCount++;
          this.options.recordCacheDecision(dev, lod, 'invalid', lease.error);
          this.options.diagnostics.errors.push(`模板缓存无效 ${dev} LOD${lod}: ${lease.error ?? ''}`);
          if (this.options.diagnostics.errors.length > 32) this.options.diagnostics.errors.shift();
          artifact = undefined;
        } else if (cacheStatus === 'miss') {
          this.options.diagnostics.lodMisses[lod]++;
          this.options.diagnostics.cacheMisses++;
          this.options.recordCacheDecision(dev, lod, 'miss');
          this.options.recoverMissingSources(key, lod);
          artifact = undefined;
        } else artifact = lease.value;
        if (artifact?.sourceInvalid?.evidence) {
          const error = new InvalidDevGeometryError(dev, artifact.sourceInvalid.message, artifact.sourceInvalid.evidence, 'warm');
          this.sourceFailures.set(dev, error);
          this.options.diagnostics.lodHits[lod]++;
          this.options.diagnostics.templateHits++;
          this.options.diagnostics.cacheHits++;
          this.options.recordCacheDecision(dev, lod, 'hit', 'source-invalid');
          throw error;
        }
        if (artifact && (!artifact.result || !['complete', 'partial', 'empty', 'unsupported'].includes(artifact.result.status)
          || artifact.result.diagnostics?.status !== artifact.result.status)) {
          this.options.recordCacheDecision(dev, lod, 'invalid', 'artifact-shape');
          this.options.diagnostics.lodInvalid[lod]++;
          this.options.diagnostics.cacheInvalidCount++;
          await deleteDevArtifact('templates', key, this.options.session);
          artifact = undefined;
        }
        if (artifact?.result.bytes) {
          try {
            if (artifact.result.bytes.byteLength > this.inputBudget.limit) throw Error('DEV cached input exceeds quota');
            if (await perfMeasureTaskPhase(identity, 'cacheHash', () => hash(artifact!.result.bytes!), this.options.perf) !== artifact.sha) throw Error('DEV template SHA mismatch');
            parsed = await perfMeasureTaskPhase(identity, 'deserialize', () => parseDevGlbAsset(dev, artifact!.result.bytes!), this.options.perf);
            if (!parsed || !await validate()) throw Error('Invalid DEV cached template');
            this.options.diagnostics.lodHits[lod]++;
            this.options.diagnostics.templateHits++;
            this.options.diagnostics.cacheHits++;
            this.options.recordCacheDecision(dev, lod, 'hit');
          } catch (error) {
            if (parsed) new DevGlbTemplate(dev, parsed.scene, this.options.session).dispose();
            parsed = null;
            if((error as Error)?.name==='AbortError'||!this.options.current())throw error;
            this.options.diagnostics.lodInvalid[lod]++;
            this.options.diagnostics.cacheInvalidCount++;
            this.options.recordCacheDecision(dev, lod, 'invalid', String(error));
            this.options.diagnostics.errors.push(`模板缓存校验失败 ${dev} LOD${lod}: ${String(error)}`);
            if (this.options.diagnostics.errors.length > 32) this.options.diagnostics.errors.shift();
            await deleteDevArtifact('templates', key, this.options.session);
            artifact = undefined;
          }
        } else if (artifact?.result.status === 'empty' || artifact?.result.status === 'unsupported') {
          this.options.diagnostics.lodHits[lod]++;
          this.options.diagnostics.templateHits++;
          this.options.diagnostics.cacheHits++;
          this.options.recordCacheDecision(dev, lod, 'hit', artifact.result.status);
          this.options.reportDiagnostic(diagnosticFromSerialization(dev, artifact.result.diagnostics, 'warm'));
          this.nullResults.set(key, artifact.result.status);
          return null;
        } else if (artifact) artifact = undefined;
        if (!artifact) {
          const hint = await perfMeasureTaskPhase(identity, 'catalogCacheRead', () => this.options.catalogHint(dev), this.options.perf);
          if (hint.status === 'hit' && hint.value?.devPath === dev && hint.value.boundsQuality === 'empty' && !hint.value.diagnostic) {
            this.options.markEmptyDev(dev);
            this.options.diagnostics.emptyOccurrences++;
            this.nullResults.set(key, 'empty');
            this.options.recordCacheDecision(dev, lod, 'hit', 'catalog-empty');
            return null;
          }
          if (!this.options.isWanted(key)) throw new DOMException('DEV request left the view', 'AbortError');
          generated = true;
          releaseInput(); releaseInput = undefined;
          await this.options.prepareMissingTemplateSources(dev);
          if (!this.options.current()) return null;
          if (!this.options.isWanted(key)) throw new DOMException('DEV request left the view', 'AbortError');
          identity.cacheSource = 'compiled';
          const workerAt=performance.now();
          let result:Awaited<ReturnType<DevGeometryPreprocessor['compile']>>;
          try {result = await this.worker.compile(dev, lod, key, this.priorities.get(key) ?? priority, identity.taskId).catch(async error => {
            if (error instanceof InvalidDevGeometryError && error.sourceEvidence && this.options.current()) {
              this.sourceFailures.set(dev, error);
              if (this.options.session.sourceSha256 && lod === 0) await this.options.persistArtifact('templates', key,
                { sourceInvalid: { message: error.reason, evidence: error.sourceEvidence } }, lod, dev, identity);
            }
            throw error;
          });}finally{workerAwaitMs=performance.now()-workerAt;
            const workerQueue=this.worker.takeWorkerQueueStats?.(key);
            workerQueueWaitTotalMs=workerQueue?.waitMs??null;workerDispatches=workerQueue?.dispatches??null;}
          if (!this.options.current()) return null;
          const budgetAt=performance.now();
          try{releaseInput = await perfMeasureTaskPhase(identity, 'inputBudgetQueue', () => this.inputBudget.acquire(result.bytes?.byteLength ?? 0), this.options.perf);}
          finally{inputBudgetWaitMs=performance.now()-budgetAt;}
          if (!this.options.current()) return null;
          this.options.diagnostics.compiled[lod]++;
          this.options.diagnostics.lodCompiled[lod]++;
          this.options.recordCacheDecision(dev, lod, 'compiled', cacheStatus);
          artifact = { result, sha: result.bytes ? result.sha256 ?? await hash(result.bytes) : '' };
          if (lod === 1) {
            demand += 1; this.templateDemand.set(key, demand);
          }
        }
        if (!this.options.current()) return null;
        outputBytes=artifact.result.bytes?.byteLength??0;
        this.options.reportDiagnostic(diagnosticFromSerialization(dev, artifact.result.diagnostics, generated ? 'cold' : 'warm'));
        if (!artifact.result.bytes) {
          if (artifact.result.status === 'empty' || artifact.result.status === 'unsupported') {
            this.nullResults.set(key, artifact.result.status);
            // Only L0 keeps the terminal tombstone. L1/L2 empty states are
            // recoverable from the catalog and must not grow the cache.
            if (this.options.session.sourceSha256 && lod === 0) {
              const inputOwner = releaseInput; releaseInput = undefined;
              await this.options.persistArtifact('templates', key, artifact, lod, dev, identity, inputOwner);
            }
          }
          return null;
        }
        parsed ??= await perfMeasureTaskPhase(identity, 'deserialize', () => parseDevGlbAsset(dev, artifact!.result.bytes!), this.options.perf);
        let valid=false;
        try{valid=!!parsed&&await validate();}
        catch(error){
          if(parsed)new DevGlbTemplate(dev,parsed.scene,this.options.session).dispose();
          parsed=null;throw error;
        }
        if (!parsed || !valid) {
          if (parsed) new DevGlbTemplate(dev, parsed.scene, this.options.session).dispose();
          throw Error(`DEV GLB invalid: ${dev}`);
        }
        // Show geometry first; persistence is bounded and asynchronous. A failed
        // write is recorded by persistArtifact and never advertised as warm.
        // Tiering: L0 persists, hot L1 persists selectively, L2 stays in memory.
        if (this.options.persistsTemplate(lod, generated, priority, demand)) {
          const inputOwner = releaseInput; releaseInput = undefined;
          void Promise.resolve(this.options.persistArtifact('templates', key, artifact, lod, dev, identity, inputOwner)).catch(reportBackgroundError);
        }
        const templateStarted = performance.now();
        const row = { bounds: new THREE.Box3().setFromObject(parsed.scene), template: new DevGlbTemplate(dev, parsed.scene, this.options.session), sha: artifact.sha, status: artifact.result.status, diagnostics: artifact.result.diagnostics, task: identity };
        this.options.diagnostics.templateParses++;
        if (!this.options.current()) { row.template.dispose(); return null; }
        const pinned = this.options.pinned(); pinned.add(key); // caller commits or releases before next trim
        const buffers = new Set<ArrayBufferLike>();
        parsed.scene.traverse(object => {
          const geometry = (object as THREE.Mesh).geometry;
          if (!geometry) return;
          for (const attribute of [...Object.values(geometry.attributes), geometry.index].filter(Boolean)) {
            const data = attribute as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
            buffers.add(('data' in data ? data.data.array : data.array).buffer);
          }
        });
        const bytes = [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
        this.templates.set(key, row, bytes, pinned); this.options.diagnostics.templateResidentBytes = this.templates.bytes;
        perfRecordTaskPhase(identity, 'templateBuild', performance.now() - templateStarted, this.options.perf, 'completed', bytes);
        return row;
      } finally { releaseInput?.(); slotOccupancyMs=performance.now()-admittedAt; releaseSlot(); }
    })();
    this.pending.set(key, promise); this.options.diagnostics.pending = this.pending.size;
    let outcome: 'completed' | 'failed' | 'cancelled' = 'completed';
    try { return await promise; }
    catch (error) { outcome = (error as Error)?.name === 'AbortError' ? 'cancelled' : 'failed'; throw error; }
    finally {
      perfRecordTaskPhase(identity, 'templateWall', performance.now() - taskStarted, this.options.perf, outcome);
      if(admittedAt)perfRecordTaskPhase(identity,'templateSlotOccupancy',slotOccupancyMs,this.options.perf,outcome);
      const row:TemplateLifecycle={key,devPath:dev,taskId:identity.taskId,lod,priority,admittedPriority,
        slotCapacityAtEnqueue,slotCapacity,slotsBusyAtEnqueue,queueDepthAtEnqueue,slotsBusyAtAdmit,
        queueWaitMs:Math.max(0,(admittedAt||performance.now())-taskStarted),slotOccupancyMs,
        cacheReadMs,workerAwaitMs,workerQueueWaitTotalMs,workerDispatches,
        inputBudgetWaitMs,outputBytes,cacheStatus:observedCacheStatus,memoryPressure,status:outcome};
      this.recordSlow(this.slowQueue,row,'queueWaitMs');
      if(admittedAt)this.recordSlow(this.slowOccupancy,row,'slotOccupancyMs');
      if (this.pending.get(key) === promise) { this.pending.delete(key); this.priorities.delete(key); } this.options.diagnostics.pending = this.pending.size; this.worker.acknowledge(key);
    }
  }
  cancel(): void {
    this.released = true; this.inputBudget.close(); this.cacheReader.close();
    this.slotOwners.clear();
    for (const waiter of this.templateWaiters.values()) waiter.reject(new DOMException('DEV session expired', 'AbortError'));
    this.templateWaiters.clear(); this.templateQueue.clear();
  }
  releaseTemplates(): void { this.templates.clear(); this.templateDemand.clear(); }
}
