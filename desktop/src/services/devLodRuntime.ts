import {setRenderVisibility,requestObjectRender} from '../viewer/demandRendering.js';
import { verifyDevGlbSourceEnvelope } from './devGlbSourceEvidence.js';
import { createLazyGeometrySourceFiles } from './modGeometrySourceFiles.js';
import { loadPresentation } from './presentationPort.js';
import { deleteDevArtifact, readDevArtifactBatch, readDevArtifactResult, type DevArtifactRead } from '@desktop/devLodCache.js';
import * as THREE from 'three';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import { isDevInstanceBatchesEnabled } from '../config/features.js';
import { diagnosticForFailure, setGeometryDiagnostic } from '../gim/geometry/geometryDiagnostics.js';
import { InvalidDevGeometryError,MissingDevDependencyError,geometryFailureKind } from '../gim/geometry/sourceGeometryError.js';
import { RevisionSet } from '../utils/byteLru.js';
import { perfCurrentSession, perfMark, perfMarkProductMoment, perfMeasureTaskPhase, perfRecordTaskPhase, type PerfTaskIdentity } from '../utils/perfTimings.js';
import { BoxViewIndex } from '../viewer/boxViewIndex.js';
import { DevInstanceBatches } from '../viewer/devInstanceBatches.js';
import { chooseDeviceLod, createDeviceViewContext, deviceViewMetrics, type DeviceLod } from '../viewer/devLodPolicy.js';
import { pickVisibleDevRoot } from '../viewer/devViewportPick.js';
import { invalidGeometryBounds, stlSourceEnvelope } from '../viewer/geometryBounds.js';
import { addModHighlightGroup, removeModHighlightGroup, resetModHighlight } from '../viewer/highlight.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { createDevGeometryPreprocessor, type DevGeometryPreprocessor } from './devGeometryWorkerClient.js';
import { createSourcePlacementMatrix } from './devGlbTemplateRuntime.js';
import { DevLodArtifactWriter } from './devLodArtifactWriter.js';
import { createDevLodDiagnostics } from './devLodDiagnostics.js';
import { DevLodReadiness, contributionForRow } from './devLodReadiness.js';
import { DevLodSourceWorkset } from './devLodSourceWorkset.js';
import { DevLodTemplateStore } from './devLodTemplateStore.js';
import type { CacheDecision, MemoryPressure, Occurrence } from './devLodTypes.js';
import { DEV_GEOMETRY_VERSION, DEV_SPATIAL_CATALOG_VERSION, boxTuple, tupleBox, type DevSourceBounds, type DevSpatialOccurrence } from './devSpatialCatalog.js';
import { ensureGeometryLayers } from './modGeometryScene.js';
import { getSourceGeometryOccurrences } from './sourceGeometryService.js';
import { startSubstationResourceMonitor } from './substationResourceTelemetry.js';

const READINESS_AUDIT_STORAGE_KEY = 'GIM_READINESS_AUDIT';

function readinessAuditEnabled(): boolean {
  try { return window.localStorage.getItem(READINESS_AUDIT_STORAGE_KEY) === '1'; } catch { return false; }
}
const pressureRank = (pressure: MemoryPressure): number => ({ unknown: -1, normal: 0, high: 1, critical: 2 }[pressure]);
const maxMemoryPressure = (left: MemoryPressure, right: MemoryPressure): MemoryPressure =>
  pressureRank(left) >= pressureRank(right) ? left : right;
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
const belongsTo = (object: THREE.Object3D, root?: THREE.Object3D) => {
  for (let parent: THREE.Object3D | null = object;parent;parent = parent.parent) if (parent === root) return true;
  return false;
};
interface ViewEvaluation {
  revision: number; selected: boolean; fine: boolean;
  entry: Occurrence['entry']; status: Occurrence['entry']['templateStatus'];
  box: THREE.Box3 | null; bounds: number[]; group: Occurrence['group'];
  displayed: DeviceLod; desired: DeviceLod | null; browseDesired: DeviceLod | null;
  key?: string; failedKey?: string; geometryStatus: Occurrence['geometryStatus'];
  inView: boolean; catalogResolved: Occurrence['catalogResolved'];
}

/** Session owner for catalog, templates and camera-driven occurrence representations. */
export class DevLodRuntime {
  private readonly readiness: DevLodReadiness;
  private updateReadiness(row: Occurrence): void { this.readiness.updateReadiness(row); }

  readonly diagnostics = createDevLodDiagnostics();
  private readonly catalogMissPaths=new Set<string>();
  catalogMissSources():readonly string[]{return [...this.catalogMissPaths];}
  private readonly artifactWriter: DevLodArtifactWriter;
  private readonly templateStore: DevLodTemplateStore;
  private readonly sources: DevLodSourceWorkset;
  private updateWriteDiagnostics(...args: Parameters<DevLodArtifactWriter['updateWriteDiagnostics']>): ReturnType<DevLodArtifactWriter['updateWriteDiagnostics']> { return this.artifactWriter.updateWriteDiagnostics(...args); }
  private persistArtifact(...args: Parameters<DevLodArtifactWriter['persistArtifact']>): ReturnType<DevLodArtifactWriter['persistArtifact']> { return this.artifactWriter.persistArtifact(...args); }
  private template(...args: Parameters<DevLodTemplateStore['template']>): ReturnType<DevLodTemplateStore['template']> { return this.templateStore.template(...args); }
  private prepareSources(...args: Parameters<DevLodSourceWorkset['prepareSources']>): ReturnType<DevLodSourceWorkset['prepareSources']> { return this.sources.prepareSources(...args); }
  private recoverMissingSources(...args: Parameters<DevLodSourceWorkset['recoverMissingSources']>): ReturnType<DevLodSourceWorkset['recoverMissingSources']> { return this.sources.recoverMissingSources(...args); }
  private prepareMissingTemplateSources(...args: Parameters<DevLodSourceWorkset['prepareMissingTemplateSources']>): ReturnType<DevLodSourceWorkset['prepareMissingTemplateSources']> { return this.sources.prepareMissingTemplateSources(...args); }

  private readonly batchEnabled = isDevInstanceBatchesEnabled();
  private instances?: DevInstanceBatches;
  private readonly viewIndex = new BoxViewIndex();
  private viewRevision = 0;
  private viewSignature: number[] = [];
  private evaluatedRows = new WeakMap<Occurrence, ViewEvaluation>();
  private rememberView(row:Occurrence, selected:boolean, fine:boolean):void {
    this.evaluatedRows.set(row, { revision:this.viewRevision, selected, fine, entry:row.entry, status:row.entry.templateStatus,
      box:row.box, bounds:row.box?[...row.box.min.toArray(),...row.box.max.toArray()]:[],group:row.group,
      displayed:row.displayed,desired:row.desired,browseDesired:row.browseDesired,key:row.key,failedKey:row.failedKey,
      geometryStatus:row.geometryStatus,inView:row.inView,catalogResolved:row.catalogResolved });
  }
  private viewUnchanged(row:Occurrence,selected:boolean,fine:boolean):boolean {
    const old=this.evaluatedRows.get(row),box=row.box;
    return !!old && old.revision===this.viewRevision && old.selected===selected && old.fine===fine
      && old.entry===row.entry && old.status===row.entry.templateStatus && old.box===box && old.group===row.group
      && old.displayed===row.displayed && old.desired===row.desired && old.browseDesired===row.browseDesired
      && old.key===row.key && old.failedKey===row.failedKey && old.geometryStatus===row.geometryStatus
      && old.inView===row.inView && old.catalogResolved===row.catalogResolved
      && (!box || old.bounds[0]===box.min.x && old.bounds[1]===box.min.y && old.bounds[2]===box.min.z
        && old.bounds[3]===box.max.x && old.bounds[4]===box.max.y && old.bounds[5]===box.max.z);
  }
  private readonly perf = perfCurrentSession();
  private taskSequence = 0;
  private taskIdentity(sourcePath: string, kind: string, lod?: DeviceLod, priority?: number): PerfTaskIdentity {
    return {
taskId: `${this.perf.id}:dev-${kind}:${++this.taskSequence}`, domain: 'dev', kind, sourcePath,
      generation: this.session.generation, lod, priority, cacheSource: 'unknown'
};
  }
  private released = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cameraTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private commits: Array<{ priority: number; root?: string; queuedAt: number; deferWhileMoving: boolean; run: () => void; reject: (e: Error) => void }> = [];
  private cameraMovingUntil = 0;
  private cameraSchedule = () => {
    if (!this.current()) return;
    this.diagnostics.currentViewReady = false;
    this.diagnostics.currentViewSettled = false;
    this.cameraMovingUntil = performance.now() + 200;
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    this.cameraTimer = setTimeout(() => { this.cameraTimer = null; this.update(); }, 200);
  };
  private requestReady(): void {
    if (this.statusTimer || !this.current()) return;
    this.statusTimer = setTimeout(() => { this.statusTimer = null; this.ready(); }, 100);
  }
  private submit(priority: number, run: () => void, root?: string, deferWhileMoving = true): Promise<void> {
    return new Promise((resolve, reject) => {
      const commit = { priority, root, queuedAt: performance.now(), deferWhileMoving, run: () => { try { run(); resolve(); } catch (e) { reject(e); } }, reject };
      // Most station occurrences have the same priority. A linear search for
      // each insertion turns a full-station warm queue into quadratic work.
      // Insert after equal-priority rows to preserve their FIFO order.
      let low = 0, high = this.commits.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (this.commits[mid].priority <= priority) low = mid + 1;
        else high = mid;
      }
      if (low === this.commits.length) this.commits.push(commit); else this.commits.splice(low, 0, commit);
      this.drainCommits();
    });
  }
  private drainCommits(): void {
    if (!this.current()) {
      if (this.commitTimer) clearTimeout(this.commitTimer);
      this.commitTimer = null;
      for (const commit of this.commits.splice(0)) commit.reject(new DOMException('Geometry session expired', 'AbortError'));
      return;
    }
    if (this.commitTimer) return;
    const firstViewBasePending = (this.commits[0]?.priority ?? Infinity) <= 1;
    // During first-view L0 admission, do not impose a fixed 16 ms gap on
    // every small placement. Bound each turn to 8 ms and yield to the event
    // loop; background commits use the less aggressive cadence.
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      const started = performance.now();

      while (this.commits.length && this.current()) {
        const now = performance.now();
        // Camera updates must not gate the first representation. A deferred
        // refinement must also not block lower-priority L0 behind it, and
        // continuous controls updates cannot starve a ready commit forever.
        const index = now >= this.cameraMovingUntil ? 0 : this.commits.findIndex(commit =>
          !commit.deferWhileMoving || commit.priority === 0 || now - commit.queuedAt >= 1000);
        if (index < 0) break;
        this.commits.splice(index, 1)[0].run();
        if (performance.now() - started >= (firstViewBasePending ? 8 : 6)) break;
      }
      if (this.commits.length) this.drainCommits();
    }, firstViewBasePending ? 0 : 8);
  }
  private wanted = new Set<string>();
  private displayedPins = new Map<string, number>();
  private pinKeys = new RevisionSet<string>();
  private selected = '';
  /** Explicit L2 requests owned by the active selection. */
  private fineRequested = new Set<string>();
  private memoryPressure: MemoryPressure = 'unknown';
  private jsMemoryPressure: MemoryPressure = 'unknown';
  private externalMemoryPressure: MemoryPressure = 'unknown';
  private readonly pauseEvent = () => this.setBackgroundPaused(!this.diagnostics.backgroundPaused);
  private onlySelected = false;
  private placementUsers = new Map<string, number>();
  private rows = new Map<string, Occurrence>();
  private catalogHints = new Map<string, Promise<DevArtifactRead<DevSourceBounds>>>();
  private worker!: DevGeometryPreprocessor;
  private anchor: THREE.Matrix4 | null = null;
  startup: Promise<void> = Promise.resolve();
  private sourceIdentity: string;
  private catalogDone: Promise<void> = Promise.resolve();
  private finishCatalog!: () => void;
  private anchorDone: Promise<void>;
  private finishAnchor!: () => void;
  constructor(private state: AppState, private ctx: ViewerContext, private session: ProjectLoadSession, private status: (text: string, detail?: string) => void) {
    this.sourceIdentity = session.sourceSha256 ?? '';
    this.artifactWriter = new DevLodArtifactWriter({ session, perf: this.perf, diagnostics: this.diagnostics, current: () => this.current(), requestReady: () => this.requestReady(), taskIdentity: (...args) => this.taskIdentity(...args), recordCacheDecision: (...args) => this.recordCacheDecision(...args) });
    this.templateStore = new DevLodTemplateStore({ session, perf: this.perf, diagnostics: this.diagnostics, current: () => this.current(), memoryPressure: () => this.memoryPressure, worker: () => this.worker, key: (...args) => this.key(...args), pinned: () => this.pinned(), isWanted: key => this.wanted.has(key), taskIdentity: (...args) => this.taskIdentity(...args), catalogHint: dev => this.catalogHint(dev), markEmptyDev: dev => this.markEmptyDev(dev), recoverMissingSources: (...args) => this.recoverMissingSources(...args), prepareMissingTemplateSources: dev => this.prepareMissingTemplateSources(dev), recordCacheDecision: (...args) => this.recordCacheDecision(...args), persistsTemplate: (...args) => this.persistsTemplate(...args), persistArtifact: (...args) => this.persistArtifact(...args), reportDiagnostic: diagnostic => setGeometryDiagnostic(this.state, diagnostic), verifySourceEnvelope: (dev,scene) => verifyDevGlbSourceEnvelope(scene,dev,this.sources.sourceFiles,this.current) });
    this.sources = new DevLodSourceWorkset({ session, perf: this.perf, diagnostics: this.diagnostics, current: () => this.current(), memoryPressure: () => this.memoryPressure, hasMemorySources: () => this.state.currentFiles != null, ifcPending: () => this.state.ifcBackgroundPending, worker: () => this.worker });
    this.readiness = new DevLodReadiness(() => this.rows, (dev, lod) => this.key(dev, lod), message => { this.diagnostics.errors.push(message); if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift(); });
    this.catalogDone = new Promise(resolve => { this.finishCatalog = resolve; });
    this.anchorDone = new Promise(resolve => { this.finishAnchor = resolve; });
    window.addEventListener('gim-toggle-background-detail', this.pauseEvent);
  }
  private current = () => !this.released && this.state.isCurrentSession(this.session);
  /** Benchmark-only caller keeps the raw DEV path in its private run folder. */
  templateDiagnostics() { return this.templateStore.templateDiagnostics(); }
  /** Apply the strongest available browser/process-tree pressure signal. */
  private applyMemoryPressure(): void {
    this.memoryPressure = maxMemoryPressure(this.jsMemoryPressure, this.externalMemoryPressure);
    this.diagnostics.memoryPressure = this.memoryPressure;
    this.diagnostics.externalMemoryPressure = this.externalMemoryPressure;
    this.diagnostics.autoLodSuppressed = this.memoryPressure === 'high' || this.memoryPressure === 'critical';
    this.worker?.setMemoryPressure?.(this.memoryPressure);
    if (this.memoryPressure === 'high' || this.memoryPressure === 'critical') {
      const budget = this.templateStore.templates.budget;
      if (this.memoryPressure === 'critical') this.templateStore.templates.budget = 0;
      this.templateStore.templates.trim(this.pinned());
      this.templateStore.templates.budget = budget;
      this.diagnostics.memoryTrimCount++;
    }
    this.requestReady();
  }
  /**
   * Feed the native process-tree sample back into the browser scheduler.
   * `unknown` deliberately removes only the external signal; a still-known
   * JS heap pressure remains in force.  The native value is advisory because
   * WebView2/GPU allocations are not fully visible to this runtime.
   */
  setExternalMemoryPressure(pressure: MemoryPressure): void {
    if (this.released) return;
    const changed = this.externalMemoryPressure !== pressure;
    this.externalMemoryPressure = pressure;
    this.applyMemoryPressure();
    if (changed) this.schedule();
  }
  /** Browser-visible heap pressure is a feedback signal, never a claim about
   * the full Tauri process tree or GPU residency. */
  private refreshMemoryPressure(): void {
    const memory = (typeof performance !== 'undefined'
      ? (performance as Performance & { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory
      : undefined);
    const used = Number(memory?.usedJSHeapSize), limit = Number(memory?.jsHeapSizeLimit);
    if (!(used > 0) || !(limit > 0)) {
      this.jsMemoryPressure = 'unknown';
      this.diagnostics.jsHeapUsedBytes = null;
      this.diagnostics.jsHeapLimitBytes = null;
      this.applyMemoryPressure();
      return;
    }
    const ratio = used / limit;
    this.jsMemoryPressure = ratio >= 0.9 ? 'critical' : ratio >= 0.8 ? 'high' : 'normal';
    this.diagnostics.jsHeapUsedBytes = used;
    this.diagnostics.jsHeapLimitBytes = limit;
    this.applyMemoryPressure();
  }
  private key(dev: string, lod: DeviceLod) { return `${DEV_GEOMETRY_VERSION}|${this.sourceIdentity}|${dev.toLowerCase()}|lod${lod}`; }
  /** Persistence tier: L0 is the durable whole-station baseline; L1 is a hot
   * near-view cache written only for selected or repeatedly requested
   * templates; L2 stays session-local by default. */
  private persistsTemplate(lod: DeviceLod, generated: boolean, priority: number, demand: number): boolean {
    if (!generated || !this.session.sourceSha256) return false;
    if (lod === 0) return true;
    return lod === 1 && (priority === 0 || demand >= 2);
  }
  private catalogKey(dev: string) { return `${DEV_SPATIAL_CATALOG_VERSION}|${DEV_GEOMETRY_VERSION}|${this.sourceIdentity}|${dev.toLowerCase()}`; }
  /** A catalog read started before the directory loop reaches this DEV also
   * short-circuits already-queued LOD0 work for a validated empty source. */
  private catalogHint(dev: string): Promise<DevArtifactRead<DevSourceBounds>> {
    const existing = this.catalogHints.get(dev);
    if (existing) return existing;
    const pending = readDevArtifactResult<DevSourceBounds>('catalog', this.catalogKey(dev), this.session);
    this.catalogHints.set(dev, pending);
    return pending;
  }
  private markEmptyDev(dev: string): void {
    for (const row of this.rows.values()) {
      if (row.entry.devPath.toLowerCase() !== dev.toLowerCase()) continue;
      row.entry.templateStatus = 'empty'; row.desired = 0;
      this.wanted.delete(this.key(dev, 0));
      this.wanted.delete(this.key(dev, 1));
      this.wanted.delete(this.key(dev, 2));
      this.updateReadiness(row);
    }
    this.worker?.cancelQueued(this.wanted);
  }
  private recordCacheDecision(devPath: string, lod: DeviceLod, status: CacheDecision['status'], reason?: string): void {
    this.diagnostics.cacheDecisions.push({ key: this.key(devPath, lod), devPath, lod, status, ...(reason ? { reason } : {}) });
    if (this.diagnostics.cacheDecisions.length > 1024) this.diagnostics.cacheDecisions.shift();
  }

  async start(): Promise<void> {
    ensureGeometryLayers(this.state, (this.ctx.world.scene as any).three);
    if (!this.sourceIdentity && this.state.currentFiles) {
      // Without a verified source SHA, templates are session-local and persistence is disabled.
      this.sourceIdentity = `session:${this.session.generation}`;
    }
    let files = this.state.currentFiles;
    if (!files) {
      files=createLazyGeometrySourceFiles(this.session.projectId,this.state.substationEntryPaths,this.state.substationEntrySizes,this.current);
    }
    // Healthy warm catalogs do not preload sources. Missing derived catalogs
    // use the same bounded immutable File workset as freshly extracted sources.
    const seeds = await getSourceGeometryOccurrences(this.state, this.session);
    if (!this.current()) return;
    this.diagnostics.sourcePlacementWarnings = this.state.engineeringGeometryCatalog?.diagnostics.length ?? 0;
    const preparingSources = this.state.currentFiles ? this.prepareSources(files) : null;
    this.sources.sourceFiles = files;
    // Preparation is optional and overlaps worker initialization/base work.
    // Suppress a second recovery while this bounded preparation is in flight.
    this.sources.sourceRecoveryAttempted = true;
    this.worker = createDevGeometryPreprocessor(
      this.state,
      this.session,
      files,
    );
    this.worker.setMemoryPressure?.(this.memoryPressure);
    this.diagnostics.workerCount = this.worker.workerCount;
    this.worker.onActivity = () => this.requestReady();
    (this.ctx.world.camera as any).controls?.addEventListener('update', this.cameraSchedule);
    const byDev = new Map<string, typeof seeds>();
    for (const seed of seeds) {
      const dev = normalize(seed.devPath), list = byDev.get(dev) ?? []; list.push(seed); byDev.set(dev, list);
      const row: Occurrence = {
        entry: {
          devPath: dev, sourceBounds: null, boundsQuality: 'unknown', primitiveCounts: {}, unsupportedTypes: [],
          instanceKey: `dev:${dev}#${seed.id}`, rootOccurrence: seed.id, placementMatrix: seed.placementMatrix, templateStatus: 'unrequested'
        },
        inView: true, box: null, desired: 0, browseDesired: 0, displayed: 0, catalogResolved: false
      };
      this.rows.set(seed.id, row);
      this.updateReadiness(row);
    }
    this.diagnostics.occurrences = seeds.length;
    this.diagnostics.uniqueDevSources = byDev.size;
    this.notifyCoordinateAnchor(); this.update(); // Compilation can begin before any IFC is ready.
    if (preparingSources) {
      const prepared = await preparingSources;
      if (!this.current()) return;
      if (prepared !== files) this.worker.installSources(prepared);
    }
    this.sources.sourceRecoveryAttempted = [...files.values()].every(file => file instanceof File);
    const catalogEntries = [...byDev];
    // Main transformers / GIS / arresters are the visual anchors of a station;
    // their catalog bounds must not be left behind hundreds of small rows.
    const importantDev = (instances: typeof seeds): number =>
      instances.some((seed) => /主变|变压器|HGIS|GIS|避雷器|出线|母线/.test(seed.name ?? '')) ? 0 : 1;
    catalogEntries.sort((a, b) =>
      importantDev(a[1]) - importantDev(b[1]) || b[1].length - a[1].length);
    const catalogWriteAdmissions = new Map<string, Promise<void>>();
    const resolveCatalog = async (dev: string): Promise<DevSourceBounds> => {
      const catalogRead = await this.catalogHint(dev);
      if (!this.current()) throw new DOMException('DEV directory left the current view', 'AbortError');
      let bounds = catalogRead.status === 'hit' ? catalogRead.value ?? null : null;
      const validBounds = bounds && bounds.devPath === dev && ['conservative', 'unknown', 'empty'].includes(bounds.boundsQuality)
        && (!bounds.sourceBounds || bounds.sourceBounds.length === 6 && bounds.sourceBounds.every(Number.isFinite)
          && bounds.sourceBounds.slice(0, 3).every((v, i) => v <= bounds!.sourceBounds![i + 3]));
      if (validBounds) {
        this.catalogMissPaths.delete(dev);
        this.diagnostics.catalogHits++;
        this.diagnostics.cacheHits++;
      } else {
        this.catalogMissPaths.add(dev);
        if (catalogRead.status === 'invalid') {
          this.diagnostics.cacheInvalidCount++;
          this.diagnostics.errors.push(`目录缓存无效 ${dev}: ${catalogRead.error ?? ''}`);
          await deleteDevArtifact('catalog', this.catalogKey(dev), this.session);
        } else if (catalogRead.status === 'read-error') {
          this.diagnostics.cacheReadErrorCount++;
          this.diagnostics.errors.push(`目录缓存读取失败 ${dev}: ${catalogRead.error ?? ''}`);
        }
        if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
        try { bounds = await this.worker.bounds(dev); }
        catch (error) {
          if (!this.current()) throw new DOMException('DEV directory left the current view', 'AbortError');
          bounds = { devPath: dev, sourceBounds: null, boundsQuality: 'unknown', primitiveCounts: {}, unsupportedTypes: [], diagnostic: String(error) };
          this.diagnostics.errors.push(`目录 ${dev}: ${String(error)}`); if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
        }
        if (!this.current()) throw new DOMException('DEV directory left the current view', 'AbortError');
        if (bounds && !bounds.diagnostic && this.session.sourceSha256) {
          catalogWriteAdmissions.set(dev, this.persistArtifact('catalog', this.catalogKey(dev), bounds, undefined, dev));
        }
      }
      return bounds ?? { devPath: dev, sourceBounds: null, boundsQuality: 'unknown', primitiveCounts: {}, unsupportedTypes: [], diagnostic: 'missing-catalog-bounds' };
    };
    const applyCatalog = (dev: string, instances: typeof seeds, bounds: DevSourceBounds): void => {
      this.diagnostics.absoluteConeCount += bounds.absoluteConeCount ?? 0;
      const emptySource = !bounds.diagnostic && bounds.boundsQuality === 'empty';
      for (const seed of instances) {
        const matrix = seed.placementMatrix;
        const entry: DevSpatialOccurrence = {
          ...bounds, instanceKey: `dev:${dev}#${seed.id}`, rootOccurrence: seed.id,
          placementMatrix: matrix, templateStatus: 'unrequested'
        };
        const box = bounds.sourceBounds ? boxTuple(bounds.sourceBounds).applyMatrix4(
          (this.anchor?.clone() ?? new THREE.Matrix4()).multiply(createSourcePlacementMatrix(matrix))) : null;
        const row = this.rows.get(seed.id)!;
        row.entry = { ...entry, templateStatus: emptySource ? 'empty' : row.entry.templateStatus }; row.box = box; row.catalogResolved = true;
        this.viewIndex.set(seed.id, box);
        this.updateReadiness(row);
        if (emptySource) this.diagnostics.emptyOccurrences++;
        if (bounds.boundsQuality === 'unknown') {
          this.diagnostics.unknownBounds++; this.state.deviceUnknownBounds.add(seed.id);
        }
      }
      if (emptySource) {
        this.wanted.delete(this.key(dev, 0));
        this.worker?.cancelQueued(this.wanted);
      }
      this.diagnostics.directoryCompleted += instances.length;
      this.requestReady();
      if (instances.some(seed => seed.id === this.selected)) void this.select(this.selected).catch(error => console.warn('[DEV selected]', error));
    };
    const CATALOG_CONCURRENCY = Math.max(32, this.worker.workerCount * 8);
    // Warm start: one bounded native batch per 64 DEV instead of one IPC per
    // DEV. This removes the 285-round-trip catalog startup from the critical
    // path; cold start benefits from the same batched lookup (misses cheap).
    try {
      for (let start = 0;start < catalogEntries.length;start += 64) {
        if (!this.current()) return;
        const devs = catalogEntries.slice(start, start + 64).map(([dev]) => dev).filter(dev => !this.catalogHints.has(dev));
        if (!devs.length) continue;
        const reads = await readDevArtifactBatch<DevSourceBounds>('catalog', devs.map(dev => this.catalogKey(dev)), this.session, 4 * 1024 * 1024);
        if (!(reads instanceof Map)) throw new Error('catalog prefetch returned no map');
        if (start === 0 && !this.state.currentFiles && devs.every(dev => reads.get(this.catalogKey(dev))?.status === 'miss')) {
          this.sources.sourceRecoveryAttempted = true;
          // Optional preparation overlaps remaining catalog reads and workers;
          // failed or late source reads never gate directory consumption.
          void this.prepareSources(files, devs.map(dev => reads.get(this.catalogKey(dev))!)).then(prepared => {
            if (this.current()) this.worker.installSources(prepared);
          }).catch(error => { if (this.current()) console.warn('[DEV source preparation]', error); });
        }
        devs.forEach(dev => {
          const key = this.catalogKey(dev);
          const read = reads.get(key);
          // Reuse terminal statuses too: resolveCatalog retains normal invalid
          // handling without issuing a second read for every confirmed miss.
          if (read && read.status !== 'deferred') this.catalogHints.set(dev, Promise.resolve(read));
        });
      }
    } catch (error) {
      // A failed prefetch falls back to per-DEV reads in resolveCatalog.
      console.warn('[DEV catalog prefetch]', error);
    }
    // Stream catalog bounds: a single slow DEV must not block the next batch.
    // This was the substation02 1395/3326 stall: Promise.all(batch of 8) waited
    // for one pathological bounds task while the other workers had no new rows.
    let nextCatalog = 0;
    const consumeCatalog = async (): Promise<void> => {
      while (this.current()) {
        const index = nextCatalog++;
        if (index >= catalogEntries.length) return;
        const [dev, instances] = catalogEntries[index];
        const bounds = await resolveCatalog(dev);
        if (!this.current()) return;
        applyCatalog(dev, instances, bounds);
        this.schedule();
        // Rows are available before backpressure. A fixed number of catalog
        // producers retain their small metadata until writer admission.
        await catalogWriteAdmissions.get(dev); catalogWriteAdmissions.delete(dev);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(CATALOG_CONCURRENCY, catalogEntries.length) },
      () => consumeCatalog(),
    ));
    if (!this.current()) return;
    this.diagnostics.catalogReady = true; this.finishCatalog();
    const { refreshDeviceBoundsMarkers } = await loadPresentation('deviceBoundsMarker');
    if (!this.current()) return;
    refreshDeviceBoundsMarkers(this.state);
    perfMark('DEV directory ready', { ...this.diagnostics, fingerprints: undefined }, this.perf);
    this.update();
  }
  belongsTo(session: ProjectLoadSession): boolean {
    return this.current() && this.session.generation === session.generation && this.session.sourceSha256 === session.sourceSha256 && this.session.projectId === session.projectId;
  }
  notifyCoordinateAnchor(): void {
    if (!this.current()) return;
    const matrix = this.state.projectSourceToViewerMatrix;
    if (!matrix || this.anchor?.equals(matrix)) return;
    this.anchor = matrix.clone(); this.diagnostics.anchorReady = true;
    this.finishAnchor();
    for (const row of this.rows.values()) {
      const placement = matrix.clone().multiply(createSourcePlacementMatrix(row.entry.placementMatrix));
      row.box = row.entry.sourceBounds ? boxTuple(row.entry.sourceBounds).applyMatrix4(placement) : null;
      this.viewIndex.set(row.entry.rootOccurrence, row.box);
      if (row.group) { row.group.matrix.copy(placement); row.group.updateMatrixWorld(true); }
      if (row.pickBounds && row.pickLocalBounds) row.pickBounds.copy(row.pickLocalBounds).applyMatrix4(placement);
    }
    this.instances?.sync();
    this.schedule();
    requestObjectRender(this.state.modRootGroup);
  }
  private pinned(): Set<string> { return this.pinKeys; }
  private demoteFine(rootOccurrence: string): void {
    const row = this.rows.get(rootOccurrence);
    if (!row || row.desired !== 2) return;
    row.desired = row.browseDesired ?? Math.min(1, row.displayed) as DeviceLod;
    this.updateReadiness(row);
    const key = this.key(row.entry.devPath, 2);
    const shared = [...this.rows.values()].some(other => other !== row
      && other.desired === 2 && this.key(other.entry.devPath, 2) === key);
    if (!shared) { this.wanted.delete(key); this.worker?.cancelTask(key); }
  }
  private applyOnlySelected(): void {
    for (const [key, row] of this.rows) {
      if (row.group) {
        setRenderVisibility(row.group,!this.onlySelected || (this.state.representationSelection?.devRoots.has(row.entry.rootOccurrence ?? key) ?? (row.entry.rootOccurrence ?? key) === this.selected));
        this.state.engineeringGeometryFilter?.(row.group);
      }
    }
    this.instances?.sync();
  }
  private schedule = () => {
    if (!this.current()) return;
    this.diagnostics.currentViewReady = false;
    this.diagnostics.currentViewSettled = false;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.update(); }, 200);
  };
  private update(): void {
    if (!this.current()) { this.release(); return; }
    // A renderer may be torn down before an already queued camera callback.
    // No view computation is meaningful until a live camera exists.
    const camera = this.ctx.world?.camera?.three as THREE.Camera | undefined;
    if (!camera) return;
    this.refreshMemoryPressure();
    this.notifyCoordinateAnchor();
    const canvas = (this.ctx.world.renderer as any)?.three?.domElement as HTMLCanvasElement | undefined;
    const rect = canvas?.getBoundingClientRect();
    const view = createDeviceViewContext(camera, rect?.width || 1000, rect?.height || 800);
    const signature=[...view.clip.elements,...view.eye.toArray(),view.width,view.height,this.anchor?1:0,this.diagnostics.autoLodSuppressed?1:0];
    if(signature.some((value,i)=>value!==this.viewSignature[i])) { this.viewRevision++; this.viewSignature=signature; }
    const candidates = this.viewIndex.query(view.frustum);
    this.diagnostics.viewIndex = { ...this.viewIndex.diagnostics };
    const wanted = new Set<string>();
    this.wanted = wanted;
    const requests: Array<Array<{row: Occurrence; lod: DeviceLod; priority: number}>> = [[], [], [], []];
    for (const row of this.rows.values()) {
      const selected = row.entry.rootOccurrence === this.selected;
      const terminal = row.entry.templateStatus === 'empty' || row.entry.templateStatus === 'unsupported';
      const fine = this.fineRequested.has(row.entry.rootOccurrence);
      // Most startup updates concern a few newly catalogued/placed rows. Keep
      // their policy and readiness current without re-projecting every static
      // occurrence. Admission below still runs for every wanted request.
      if (!this.viewUnchanged(row,selected,fine)) {
        const metrics = this.anchor && row.box && candidates.has(row.entry.rootOccurrence)
          ? deviceViewMetrics(row.box, camera, rect?.width || 1000, rect?.height || 800, view) : null;
        // Unknown bounds are not evidence of visibility. They still receive an
        // automatic LOD0 in the background; only catalogued boxes decide whether
        // the current view is blocked on this occurrence.
        row.inView = selected || (row.box && metrics ? metrics.visible : false);
        if (terminal) { row.desired = 0; this.updateReadiness(row); this.rememberView(row,selected,fine); continue; }
        // Unknown ranges compile actual supported geometry automatically. No
        // invented box, false culling or tree-selection prerequisite is used.
        // Selection only raises scheduling priority.  L2 is an explicit user
        // action (refine()); camera proximity and an ordinary click must stay in
        // the inexpensive browser representation.  This is the key boundary
        // between browsing and the fine-model workflow.
        const browseLod: DeviceLod = !row.group ? 0 : this.diagnostics.autoLodSuppressed
          ? row.inView ? Math.min(1, row.displayed) as DeviceLod : 0
          : metrics ? chooseDeviceLod(row.displayed, metrics.visible, metrics.pixels) : 0;
        row.browseDesired = browseLod;
        const lod = fine ? 2 : browseLod;
        row.desired = lod;
        this.updateReadiness(row);
        this.rememberView(row,selected,fine);
      }
      if (terminal) continue;
      // A seed with no catalog result has no reliable visibility. Starting
      // thousands of unknown L0 requests here fills the template queue before
      // the first actual in-view bounds arrive. Direct selection remains live.
      if (row.catalogResolved === false && !selected) continue;
      const lod = row.desired!;
      const key = this.key(row.entry.devPath, lod); wanted.add(key);
      // Visible L0 outranks offscreen L0; offscreen still remains wanted and
      // is reached later (aged priority prevents permanent starvation).
      const priority = selected ? 0 : lod === 0 ? (row.inView ? 1 : 3) : 2;
      if (row.key !== key && row.failedKey !== key) requests[priority].push({row,lod,priority});
    }
    // Admit visible base work before offscreen templates can occupy the host
    // slots. Preserve source order inside each priority bucket.
    for (const bucket of requests) for (const {row,lod,priority} of bucket) {
      const key = this.key(row.entry.devPath,lod);
      void this.render(row,lod,priority).catch(e => this.failed(row,e,key));
    }
    this.worker?.cancelQueued(wanted); this.templateStore.templates.trim(this.pinned());
    for (const [key, waiter] of this.templateStore.templateWaiters) if (!wanted.has(key)) {
      this.templateStore.templateWaiters.delete(key); this.templateStore.templateQueue.delete(key); waiter.reject(new DOMException('DEV request left the current view', 'AbortError'));
    }
    this.diagnostics.templateResidentBytes = this.templateStore.templates.bytes;
    this.requestReady();
  }
  private rendering = new WeakMap<Occurrence, Map<string, Promise<void>>>();
  private render(row: Occurrence, lod: DeviceLod, priority: number): Promise<void> {
    let tasks = this.rendering.get(row);
    if (!tasks) { tasks = new Map(); this.rendering.set(row, tasks); }
    const key = this.key(row.entry.devPath, lod);
    const existing = tasks.get(key); if (existing) return existing;
    const task = this.renderOnce(row, lod, priority).finally(() => tasks!.delete(key));
    tasks.set(key, task); return task;
  }
  private async renderOnce(row: Occurrence, lod: DeviceLod, priority: number): Promise<void> {
    const key = this.key(row.entry.devPath, lod);
    this.placementUsers.set(key, (this.placementUsers.get(key) ?? 0) + 1);
    this.pinKeys.add(key);
    try {
      const template = await this.template(row.entry.devPath, lod, priority);
      if (!this.current() || row.desired !== lod || row.key === key) return;
      if (!template) {
        if (row.entry.templateStatus === 'empty') { this.templateStore.nullResults.set(key, 'empty'); this.requestReady(); return; }
        row.entry.templateStatus = this.templateStore.nullResults.get(key) ?? 'failed';
        this.updateReadiness(row);
        this.requestReady(); return;
      }
      if (!this.anchor) await perfMeasureTaskPhase(template.task ?? this.taskIdentity(row.entry.devPath, 'placement', lod, priority), 'anchorQueue', () => this.anchorDone, this.perf);
      if (!this.current() || row.desired !== lod || row.key === key) return;
      const trace = { ...(template.task ?? this.taskIdentity(row.entry.devPath, 'placement', lod, priority)), priority, instanceKey: row.entry.instanceKey };
      const commitQueuedAt = performance.now();
      await perfMeasureTaskPhase(trace, 'sceneSubmitWall', () => this.submit(priority, () => {
        if (!this.current() || row.desired !== lod || row.key === key) return;
        const started = performance.now();
        perfRecordTaskPhase(trace, 'sceneCommitQueue', started - commitQueuedAt, this.perf);
        const group = template.template.createPlacement({
          rootOccurrence: row.entry.rootOccurrence,
          instanceKey: row.entry.instanceKey, placementMatrix: row.entry.placementMatrix, projectSourceToViewerMatrix: this.anchor
        });
        const worldBounds = template.bounds.clone().applyMatrix4(group.matrix);
        const invalidPlacement = invalidGeometryBounds(worldBounds, stlSourceEnvelope(template.template.scene)?.applyMatrix4(group.matrix));
        if (invalidPlacement) { group.clear(); throw Error(`DEV placement rejected: ${row.entry.rootOccurrence}: ${invalidPlacement}`); }
        group.userData.deviceLod = lod;
        group.name = row.entry.instanceKey;
        const highlighted = this.state.highlightedModState?.groups.filter(object => belongsTo(object, row.group)) ?? [];
        const highlightScopes = highlighted.map(object => object === row.group ? null : { devPath: object.userData.devPath, assemblyPath: object.userData.assemblyPath, referencePath: object.userData.referencePath });
        for (const object of highlighted) removeModHighlightGroup(this.state, object);
        if (row.group) this.instances?.remove(row.group);
        this.state.modRootGroup!.add(group); row.group?.removeFromParent();
        if (row.key) { const count = (this.displayedPins.get(row.key) ?? 1) - 1; if (count) this.displayedPins.set(row.key, count); else { this.displayedPins.delete(row.key); if (!this.placementUsers.has(row.key)) this.pinKeys.delete(row.key); } }
        this.displayedPins.set(key, (this.displayedPins.get(key) ?? 0) + 1);
        row.group = group; row.pickLocalBounds = template.bounds; row.pickBounds = worldBounds;
        row.key = key; row.displayed = lod; row.entry.templateStatus = 'ready';
        if(import.meta.env.VITE_GIM_BENCHMARK==='1'&&lod===0)row.baseEvidence={id:row.entry.rootOccurrence,sha:template.sha,
          bounds:[...template.bounds.min.toArray(),...template.bounds.max.toArray()],matrix:this.anchor!.clone().invert().multiply(group.matrix).elements.slice(),status:template.status,simplifiedBooleans:template.diagnostics.simplifiedBooleans??0};
        group.visible = !this.onlySelected || (this.state.representationSelection?.devRoots.has(row.entry.rootOccurrence) ?? row.entry.rootOccurrence === this.selected);
        this.state.engineeringGeometryFilter?.(group);
        if (this.batchEnabled) {
          this.instances ??= new DevInstanceBatches(this.state.modRootGroup!);
          this.instances.add(group, lod < 2);
        }
        row.geometryStatus = template.status; row.failedKey = undefined;
        this.updateReadiness(row);
        this.state.loadedXmlModGroups.set(row.entry.instanceKey, group);
        if (highlighted.length && !this.state.representationSelection) {
          const replacements: THREE.Object3D[] = [];
          group.traverse(object => {
            if (replacements.some(parent => belongsTo(object, parent))) return;
            if (highlightScopes.some(scope => scope ? Object.entries(scope).every(([field, value]) => object.userData[field] === value) : object === group)) replacements.push(object);
          });
          replacements.forEach(object => addModHighlightGroup(this.state, object));
        }
        this.state.engineeringRepresentationChanged?.(row.entry.rootOccurrence);
        if (this.diagnostics.fingerprints.length < 64 || row.entry.rootOccurrence === this.selected) {
          const local = template.bounds, world = worldBounds;
          const fingerprint = {
            sourceSha: this.session.sourceSha256, devPath: row.entry.devPath, instanceKey: row.entry.instanceKey, lod,
            templateSha: template.sha, localBounds: tupleBox(local), placementMatrix: row.entry.placementMatrix,
            firstIfc: this.state.currentIfcEntries[0]?.path, projectMatrix: this.state.projectSourceToViewerMatrix?.toArray(),
            worldBounds: tupleBox(world), center: world.getCenter(new THREE.Vector3()).toArray()
          };
          this.diagnostics.fingerprints.push(fingerprint);
          if (this.diagnostics.fingerprints.length > 128) this.diagnostics.fingerprints.shift();
          perfMark('DEV placement fingerprint', fingerprint, this.perf);
        }
        this.diagnostics.shown = this.state.loadedXmlModGroups.size;
        this.diagnostics.sceneCommitCount++;
        this.diagnostics.sceneCommitMaxMs = Math.max(this.diagnostics.sceneCommitMaxMs, performance.now() - started);
        perfRecordTaskPhase(trace, 'placementCommit', performance.now() - started, this.perf);
        this.requestReady();
        this.schedule(); // Reconsider detail only after a base representation exists.
      }, row.entry.rootOccurrence, lod > 0), this.perf);
    } finally {
      const users = (this.placementUsers.get(key) ?? 1) - 1;
      if (users) this.placementUsers.set(key, users); else this.placementUsers.delete(key);
      if (!this.placementUsers.has(key) && !this.displayedPins.has(key)) this.pinKeys.delete(key);
      this.templateStore.templates.trim(this.pinned());
    }
  }
  private failed(row: Occurrence, error: unknown, requestKey: string): void {
    if (!this.current()) return;
    if (row.entry.templateStatus === 'empty') return;
    if (row.desired === null || this.key(row.entry.devPath, row.desired) !== requestKey) return;
    // A queued request may be cancelled while an earlier evaluation is still
    // unwinding. If the same key is wanted again, it needs another drive.
    if ((error as Error)?.name === 'AbortError') { this.schedule(); return; }
    row.entry.templateStatus = 'failed';
    row.failedKey = requestKey;
    this.updateReadiness(row);
    this.diagnostics.errors.push(`${row.entry.devPath}: ${String(error)}`);
    if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
    setGeometryDiagnostic(this.state, diagnosticForFailure(row.entry.devPath,
      geometryFailureKind(error),
      error instanceof InvalidDevGeometryError ? error.source : 'cold',
      error instanceof InvalidDevGeometryError || error instanceof MissingDevDependencyError
        ? error.sourceEvidence ?? String(error) : String(error)));
    this.requestReady();
  }
  private ready(): void {
    if (this.instances) this.diagnostics.instancing = { enabled: this.batchEnabled, ...this.instances.statistics };
    if (!this.current()) return;
    // The normal path is O(1): every row transition updates its contribution.
    // Vitest fixtures and diagnostic callers may replace/mutate the private
    // map directly; resync there so readiness remains a trustworthy contract.
    if (!this.readiness.readinessRowsMatch() || import.meta.env?.MODE === 'test') this.readiness.syncReadinessCounters();
    const counters = this.readiness.readinessCounters;
    const {
      total, visible, finished, shown, empty, unsupported, partial, failed,
      viewPending,
    } = counters;
    const viewSettled = counters.viewSettled === total;
    const viewReady = counters.viewReady === total;
    const baseSettled = counters.baseSettled === total;
    const baseReady = counters.baseReady === total;
    const allReady = counters.allReady === total;
    const samples: string[] = [];
    if (viewPending > 0) {
      for (const row of this.rows.values()) {
        if (!row.inView) continue;
        const contribution = contributionForRow(row, (dev, lod) => this.key(dev, lod));
        if (!contribution.viewPending) continue;
        samples.push(`${row.entry.devPath}: LOD${row.displayed}→${row.desired}`);
        if (samples.length >= 8) break;
      }
    }
    this.readiness.auditReadinessCounters(readinessAuditEnabled());
    const stable = !this.cameraTimer && !this.timer && this.diagnostics.anchorReady;
    const blockers = [!this.diagnostics.anchorReady ? '等待坐标锚点' : '', !this.diagnostics.catalogReady ? '设备范围索引准备中' : '', this.cameraTimer ? '等待相机停稳' : '',
    this.templateStore.pending.size ? `模板处理中 ${this.templateStore.pending.size}` : '', this.templateStore.templateWaiters.size ? `模板排队 ${this.templateStore.templateWaiters.size}` : '', this.commits.length ? `场景待提交 ${this.commits.length}` : ''].filter(Boolean);
    const ready = stable && viewReady && failed === 0 && (visible > 0 || this.diagnostics.catalogReady);
    if (ready && !this.diagnostics.currentViewReady) {
      perfMark('DEV current view ready', { shown, requested: visible, compiled: [...this.diagnostics.compiled], hits: [...this.diagnostics.lodHits], failed }, this.perf);
      perfMarkProductMoment('devCurrentViewReady', {
        path: 'device-lod', shown, requested: visible, compiled: [...this.diagnostics.compiled],
        lodHits: [...this.diagnostics.lodHits], failed, catalogReady: this.diagnostics.catalogReady,
      }, this.perf);
    }
    const nextViewSettled = stable && this.diagnostics.catalogReady && viewSettled;
    if (nextViewSettled && !this.diagnostics.currentViewSettled) {
      perfMarkProductMoment('devCurrentViewSettled', {
        path: 'device-lod', shown, requested: visible, failed, catalogReady: this.diagnostics.catalogReady,
      }, this.perf);
    }
    const nextBaseSettled = this.diagnostics.anchorReady && this.diagnostics.catalogReady && baseSettled;
    const nextAllReady = this.diagnostics.anchorReady && this.diagnostics.catalogReady && baseReady && allReady;
    if (nextBaseSettled && !this.diagnostics.baseRepresentationsSettled) {
      perfMarkProductMoment('devBaseRepresentationsSettled', {
        path: 'device-lod', occurrences: total, shown, empty, unsupported, failed,
        compiled: [...this.diagnostics.compiled], lodHits: [...this.diagnostics.lodHits],
        templateParses: this.diagnostics.templateParses,
      }, this.perf);
      if (failed === 0) perfMarkProductMoment('devGeometryReady', { path: 'device-lod', occurrences: total, shown, empty, unsupported, failed }, this.perf);
    }
    if (nextAllReady && !this.diagnostics.allStationReady) {
      perfMarkProductMoment('devAllStationReady', { path: 'device-lod', occurrences: total, shown, partial, failed }, this.perf);
      perfMark('DEV all station ready', { total, shown, partial, failed }, this.perf);
    }
    Object.assign(this.diagnostics, {
      currentViewSettled: nextViewSettled, currentViewReady: ready,
      baseRepresentationsSettled: nextBaseSettled,
      baseRepresentationsReady: this.diagnostics.anchorReady && this.diagnostics.catalogReady && baseReady,
      allStationReady: nextAllReady,
      readyOccurrences: shown, emptyOccurrences: empty, unsupportedOccurrences: unsupported, partialOccurrences: partial, failedOccurrences: failed,
      shown: this.state.loadedXmlModGroups.size, workerCount: this.worker?.workerCount ?? 0, activeDevices: this.worker?.activePaths ?? [], viewPendingOccurrences: viewPending,
      readinessBlockers: blockers, viewPendingSamples: samples,
      cacheReadBatches: this.templateStore.cacheReader.diagnostics.batches, cacheReadEntries: this.templateStore.cacheReader.diagnostics.entries, cacheReadDeferred: this.templateStore.cacheReader.diagnostics.deferred
    });
    const browseState = !this.diagnostics.catalogReady || !this.diagnostics.currentViewSettled
      ? 'loading'
      : failed > 0 ? 'partial'
        : nextBaseSettled ? 'base-settled' : 'browseable';
    this.diagnostics.browseState = browseState;
    const active = this.diagnostics.activeDevices.join('、');
    this.diagnostics.inputBudgetBytes = this.templateStore.inputBudget.bytes; this.diagnostics.inputBudgetPeakBytes = this.templateStore.inputBudget.peakBytes;
    this.updateWriteDiagnostics();
    const ws = this.worker?.diagnostics;
    if (ws) {
      this.diagnostics.workerReads = ws.reads; this.diagnostics.workerRpcReads = ws.rpcReads;
      this.diagnostics.workerSourceHits = ws.sourceHits; this.diagnostics.workerDocumentHits = ws.documentHits;
      this.diagnostics.workerReadRpcMs = Math.round(ws.readRpcMs); this.diagnostics.workerParseMs = Math.round(ws.parseMs);
      this.diagnostics.workerQueueWaitMs = Math.round(ws.queueWaitMs);
      this.diagnostics.workerSourceAffinityHits = ws.sourceAffinityHits;
      this.diagnostics.workerSourceAffinityDeferrals = ws.sourceAffinityDeferrals;
      this.diagnostics.workerScheduling = this.worker.schedulingSnapshot();
      this.diagnostics.workerStages = { ...ws.stages };
      this.diagnostics.workerTimedOutTasks = ws.timedOutTasks;
      this.diagnostics.workerStallSnapshots = ws.stallSnapshots;
    }
    const pressure = this.worker?.resultPressure;
    this.diagnostics.resultQueuedBytes = pressure?.bytes ?? 0; this.diagnostics.resultPeakBytes = pressure?.peakBytes ?? 0;
    this.diagnostics.resultQueueCount = pressure?.count ?? 0;
    const phase = !this.diagnostics.catalogReady
      ? `设备范围索引准备中 ${this.diagnostics.directoryCompleted}/${total}`
      : this.diagnostics.currentViewSettled
        ? ready ? (nextBaseSettled ? '当前视图已完成 · 工程可浏览 · 基础表示已完成' : '当前视图已完成 · 工程可浏览') : '当前视图已完成，部分实例失败 · 工程可浏览'
        : `当前视图准备中${viewPending ? ` ${viewPending}` : ''}`;
    const background = this.diagnostics.currentViewSettled && !this.diagnostics.baseRepresentationsSettled ? ' · 后台补充基础表示' : '';
    const cacheTail=this.diagnostics.baseRepresentationsSettled&&this.diagnostics.cacheWritePendingCount>0
      ?` · 几何已显示，缓存写入中 ${this.diagnostics.cacheWritePendingCount}`:'';
    const cold = this.diagnostics.compiled, warm = this.diagnostics.lodHits;
    const failedCount = this.diagnostics.failedOccurrences;
    const cacheProblems = this.diagnostics.lodReadErrors.reduce((a, b) => a + b, 0)
      + this.diagnostics.lodInvalid.reduce((a, b) => a + b, 0)
      + this.diagnostics.artifactWriteFailures;
    this.status(
      `几何实例已处理 ${finished}/${total} · 已显示 ${this.diagnostics.readyOccurrences} · 冷编译 L0 ${cold[0]}/L1 ${cold[1]}/L2 ${cold[2]} · 缓存命中 L0 ${warm[0]}/L1 ${warm[1]}/L2 ${warm[2]}${failedCount ? ` · 失败 ${failedCount}` : ''} · ${phase}${background}${cacheTail}${this.diagnostics.sourcePlacementWarnings ? ` · 来源位置待确认 ${this.diagnostics.sourcePlacementWarnings}` : ''}`,
      `LOD缓存 miss ${this.diagnostics.cacheMisses} · read-error ${this.diagnostics.cacheReadErrorCount} · invalid ${this.diagnostics.cacheInvalidCount} · 写入失败 ${this.diagnostics.artifactWriteFailures}`
      + ` · 目录 ${this.diagnostics.directoryCompleted}/${total}${this.diagnostics.catalogReady ? '（就绪）' : '（进行中）'}`
      + ` · 批读 ${this.diagnostics.cacheReadBatches} 批/${this.diagnostics.cacheReadEntries} 条（defer ${this.diagnostics.cacheReadDeferred}）`
      + ` · 淘汰 ${this.diagnostics.templateEvictions} · 部分表示 ${this.diagnostics.partialOccurrences}`
      + `${cacheProblems ? ` · 缓存问题 ${cacheProblems}` : ''}`
      + `${blockers.length ? ` · ${blockers.join(' · ')}` : ''}${active ? ` · ${active}` : ''}`
      + `${this.diagnostics.memoryPressure !== 'unknown' ? ` · JS内存 ${this.diagnostics.memoryPressure}` : ''}`
      + `${this.diagnostics.backgroundPaused ? ' · 已暂停后台细化' : ''}`);
    this.diagnostics.cacheReadBatches = this.templateStore.cacheReader.diagnostics.batches;
    this.diagnostics.cacheReadEntries = this.templateStore.cacheReader.diagnostics.entries;
    this.diagnostics.cacheReadDeferred = this.templateStore.cacheReader.diagnostics.deferred;
    // No work owns a still-wanted row: recover a cancelled scheduling turn.
    if (stable && viewPending && !this.templateStore.pending.size && !this.templateStore.templateWaiters.size && !this.commits.length) this.schedule();
  }
  clearSelection(): void {
    const previous = this.selected;
    this.selected = '';
    // Fine geometry is tied to the active selection.  Leaving the selection
    // releases its protection; the normal LOD scheduler may then replace it
    // with L0/L1 and the template cache can reclaim the fine representation.
    if (previous) { this.fineRequested.delete(previous); this.demoteFine(previous); }
    this.schedule();
  }
  /** Pause only automatic L1 refinement/prefetch. L0 and catalog/bounds work
   * remain eligible, and an explicit refine() request can still be promoted. */
  setBackgroundPaused(paused: boolean): void {
    this.diagnostics.backgroundPaused = paused;
    this.worker?.setPaused(paused);
    this.requestReady();
  }
  setOnlySelected(only: boolean): void {
    this.onlySelected = only;
    this.applyOnlySelected();
  }
  resourceCounts() {
    const geometry = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    for (const row of this.templateStore.templates.values()) {
      for (const value of row.template.geometryRefs) geometry.add(value);
      for (const value of row.template.materialRefs) materials.add(value);
      for (const value of row.template.textureRefs) textures.add(value);
    }
    return {
      templateCount: this.templateStore.templates.size, templateParseCount: this.diagnostics.templateParses,
      sharedGeometryCount: geometry.size, sharedMaterialCount: materials.size, sharedTextureCount: textures.size
    };
  }
  pick(ray: THREE.Raycaster): ReturnType<DevInstanceBatches['pick']> {
    // Instancing batches own picking when enabled; ordinary placements still
    // need a fallback so clicking a visible DEV cabinet selects that cabinet
    // instead of the IFC surface behind it.
    const batched = this.instances?.pick(ray);
    if (batched) return batched;
    if (!this.current()) return null;
    return pickVisibleDevRoot(ray, this.rows.values());
  }
  /** Read the current placement directly; never retain a second root index. */
  getLoadedRoot(rootOccurrence: string): THREE.Group | undefined {
    return this.current() ? this.rows.get(rootOccurrence)?.group : undefined;
  }
  /** Explicit diagnostic checkpoint; no source IO or representation creation. */
  forEachLoadedRoot(visit:(occurrence:string,root:THREE.Group,lod:number)=>void):void {
    if(!this.current())return;
    for(const [id,row]of this.rows)if(row.group)visit(id,row.group,row.displayed);
  }
  baseRepresentationEvidence():readonly import('../shared/deviceRuntime.js').DevBaseEvidence[]{
    return this.current()?[...this.rows.values()].flatMap(row=>row.baseEvidence?[row.baseEvidence]:[]):[];
  }
  /** Ensure an occurrence has a browser representation.  This method is used
   * by ordinary tree/search/selection flows and deliberately never requests
   * L2.  Keep the historical select name as a compatibility alias below. */
  async ensureBase(rootOccurrence: string): Promise<THREE.Group[]> {
    if (!this.current()) return [];
    const previous = this.selected;
    if (previous && previous !== rootOccurrence) {
      this.fineRequested.delete(previous);
      this.demoteFine(previous);
    }
    this.selected = rootOccurrence;
    this.fineRequested.delete(rootOccurrence);
    this.applyOnlySelected();
    for (const commit of this.commits) if (commit.root === rootOccurrence) commit.priority = 0;
    this.commits.sort((a, b) => a.priority - b.priority);
    if (!this.rows.has(rootOccurrence)) await this.catalogDone;
    const row = this.rows.get(rootOccurrence);
    if (!row || !this.current() || this.selected !== rootOccurrence) return [];
    const target: DeviceLod = row.group ? Math.min(1, row.displayed) as DeviceLod : 0;
    row.desired = target;
    this.updateReadiness(row);
    this.wanted.add(this.key(row.entry.devPath, target));
    row.failedKey = undefined; // Explicit selection retries transient failures; source-invalid stays isolated.
    this.updateReadiness(row);
    try { await this.render(row, target, 0); }
    catch (error) { this.failed(row, error, this.key(row.entry.devPath, target)); throw error; }
    if (!this.anchor) {
      await this.anchorDone;
      if (!this.current() || this.selected !== rootOccurrence) return [];
      await this.render(row, target, 0);
    }
    return this.current() && row.group ? [row.group] : [];
  }
  /** Retry only the selected DEV's failed browser task.  Source-invalid and
   * deterministic empty/unsupported results remain isolated; they require a
   * source correction rather than an automatic retry loop. */
  async retry(rootOccurrence: string): Promise<THREE.Group[]> {
    if (!this.current()) return [];
    const row = this.rows.get(rootOccurrence);
    if (!row) return [];
    if (this.templateStore.sourceFailures.has(row.entry.devPath)) throw this.templateStore.sourceFailures.get(row.entry.devPath)!;
    if (row.entry.templateStatus === 'empty' || row.entry.templateStatus === 'unsupported') {
      throw new Error('该设备没有可重试的浏览几何来源');
    }
    this.selected = rootOccurrence;
    row.entry.templateStatus = 'unrequested';
    row.failedKey = undefined;
    row.geometryStatus = undefined;
    this.updateReadiness(row);
    for (const lod of [0, 1, 2] as const) this.templateStore.nullResults.delete(this.key(row.entry.devPath, lod));
    this.applyOnlySelected();
    if (!row.group) await this.ensureBase(rootOccurrence);
    if (!this.current() || this.selected !== rootOccurrence) return [];
    const target = row.browseDesired ?? (row.group ? Math.min(1, row.displayed) : 0) as DeviceLod;
    row.desired = target;
    this.updateReadiness(row);
    this.wanted.add(this.key(row.entry.devPath, target));
    await this.render(row, target, 0);
    this.schedule();
    return this.current() && row.group ? [row.group] : [];
  }
  /** Explicit user request for precise DEV geometry. */
  async refine(rootOccurrence: string): Promise<THREE.Group[]> {
    if (!this.current()) return [];
    this.refreshMemoryPressure();
    if (this.memoryPressure === 'critical') throw new Error('当前内存压力过高，暂不能加载精细模型');
    const previous = this.selected;
    if (previous && previous !== rootOccurrence) {
      this.fineRequested.delete(previous);
      this.demoteFine(previous);
    }
    this.selected = rootOccurrence;
    this.applyOnlySelected();
    for (const commit of this.commits) if (commit.root === rootOccurrence) commit.priority = 0;
    this.commits.sort((a, b) => a.priority - b.priority);
    if (!this.rows.has(rootOccurrence)) await this.catalogDone;
    const row = this.rows.get(rootOccurrence);
    if (!row || !this.current() || this.selected !== rootOccurrence) return [];
    // A direct inspector request can arrive before the automatic browser
    // representation has committed.  Admit L0 first so an exact request
    // never makes the current view blank while it waits for L2.
    if (!row.group && row.entry.templateStatus !== 'empty' && row.entry.templateStatus !== 'unsupported') {
      await this.ensureBase(rootOccurrence);
      if (!this.current() || this.selected !== rootOccurrence) return [];
    }
    this.fineRequested.add(rootOccurrence);
    row.desired = 2;
    this.wanted.add(this.key(row.entry.devPath, 2));
    row.failedKey = undefined;
    this.updateReadiness(row);
    try { await this.render(row, 2, 0); }
    catch (error) {
      // A precise request is an optional browser action.  Preserve a usable
      // L0/L1 group and its successful diagnostic when L2 fails; otherwise a
      // failed refinement would incorrectly turn an already browseable station
      // into a base-view failure.
      const hadBase = !!row.group && row.displayed <= 1;
      if (hadBase) {
        this.diagnostics.fineFailures.push(`${row.entry.devPath}: ${String(error)}`);
        if (this.diagnostics.fineFailures.length > 32) this.diagnostics.fineFailures.shift();
        row.failedKey = undefined;
        row.entry.templateStatus = 'ready';
        this.updateReadiness(row);
        this.requestReady();
      } else {
        this.failed(row, error, this.key(row.entry.devPath, 2));
      }
      this.fineRequested.delete(rootOccurrence);
      this.demoteFine(rootOccurrence);
      throw error;
    }
    if (!this.current() || this.selected !== rootOccurrence) return [];
    if (!this.anchor) {
      await this.anchorDone;
      if (!this.current() || this.selected !== rootOccurrence) return [];
      await this.render(row, 2, 0);
    }
    if (!this.current() || this.selected !== rootOccurrence || !row.group
      || row.key !== this.key(row.entry.devPath, 2)) return [];
    perfMarkProductMoment('selectedFineReady', {
      kind: 'dev', rootOccurrence, devPath: row.entry.devPath, lod: 2,
    }, this.perf);
    return this.current() && row.group ? [row.group] : [];
  }
  /** Release an explicitly refined occurrence back to normal browsing LOD. */
  releaseFine(rootOccurrence: string): void {
    this.fineRequested.delete(rootOccurrence);
    if (this.selected === rootOccurrence) {
      this.demoteFine(rootOccurrence);
    }
    this.schedule();
  }
  /** Backward-compatible name.  Ordinary selection is base-only now. */
  async select(rootOccurrence: string): Promise<THREE.Group[]> { return this.ensureBase(rootOccurrence); }
  release(): void {
    this.sources.close();
    if (this.released) return; this.released = true; this.templateStore.cancel(); this.artifactWriter.close(); this.finishCatalog(); this.finishAnchor();
    if (this.timer) clearTimeout(this.timer);
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.commitTimer) clearTimeout(this.commitTimer);
    for (const commit of this.commits) commit.reject(new DOMException('DEV session expired', 'AbortError'));
    this.commits = [];
    this.timer = this.cameraTimer = this.statusTimer = this.commitTimer = null;
    this.ctx.world?.camera?.controls?.removeEventListener('update', this.cameraSchedule);
    window.removeEventListener('gim-toggle-background-detail', this.pauseEvent);
    this.worker?.cancel();
    for (const row of this.rows.values()) { if (row.group && this.state.highlightedModState?.groups.some(object => belongsTo(object, row.group))) resetModHighlight(this.state); row.group?.removeFromParent(); this.state.loadedXmlModGroups.delete(row.entry.instanceKey); }
    this.instances?.release(); this.instances = undefined;
    this.fineRequested.clear(); this.templateStore.releaseTemplates();
    this.readiness.clear(); this.rows.clear();
    this.viewIndex.clear();
    this.catalogHints.clear(); this.state.deviceUnknownBounds.clear();
  }
}
export async function startDeviceLod(state: AppState, ctx: ViewerContext, session: ProjectLoadSession, status: (text: string, detail?: string) => void): Promise<DevLodRuntime> {
  if (!state.substationResourceMonitor) startSubstationResourceMonitor(state, ctx);
  if (state.deviceLodRuntime instanceof DevLodRuntime && state.deviceLodRuntime.belongsTo(session)) {
    state.deviceLodRuntime.setOnlySelected(state.onlySelected);
    state.deviceLodRuntime.notifyCoordinateAnchor(); await state.deviceLodRuntime.startup; return state.deviceLodRuntime;
  }
  state.deviceLodRuntime?.release();
  const runtime = new DevLodRuntime(state, ctx, session, status); state.deviceLodRuntime = runtime;
  runtime.setExternalMemoryPressure(state.substationMemoryPressure);
  runtime.setOnlySelected(state.onlySelected);
  try { runtime.startup = runtime.start(); await runtime.startup; return runtime; }
  catch (error) { runtime.release(); if (state.deviceLodRuntime === runtime) state.deviceLodRuntime = null; throw error; }
}
