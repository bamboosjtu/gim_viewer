import { ByteWorkBudget } from '../utils/byteWorkBudget.js';
import {DevTemplateCacheReader} from './devTemplateCacheReader.js';
import * as THREE from 'three';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { chooseDeviceLod, deviceViewMetrics, createDeviceViewContext, type DeviceLod } from '../viewer/devLodPolicy.js';
import { ByteLru, RevisionSet } from '../utils/byteLru.js';
import { collectCbmDeviceInstances, parseCbmTransformMatrix, ensureGeometryLayers } from './modAutoLoadService.js';
import { DevGlbTemplate, createLegacyEquivalentPlacementMatrix, validateDevGlbTemplate } from './devGlbTemplateRuntime.js';
import { parseDevGlbAsset, type DevGlbSerializationResult } from './glbCacheService.js';
import { createDevGeometryPreprocessor, type DevGeometryPreprocessor } from './devGeometryWorkerClient.js';
import { invalidGeometryExtent, GEOMETRY_MAX_EXTENT_M } from '../viewer/geometryBounds.js';
import { DEV_GEOMETRY_VERSION, DEV_SPATIAL_CATALOG_VERSION, boxTuple, tupleBox, type DevSourceBounds, type DevSpatialOccurrence } from './devSpatialCatalog.js';
import { readDevArtifactResult, writeDevArtifactDetailed, deleteDevArtifact, type DevArtifactRead, type DevArtifactReadStatus } from '@desktop/devLodCache.js';
import { readCachedEntry } from '@desktop/database.js';
import { batchReadCachedFiles } from '@desktop/database.js';
import { perfCurrentSession, perfMark, perfMarkProductMoment } from '../utils/perfTimings.js';
import { diagnosticForFailure, diagnosticFromSerialization, setGeometryDiagnostic } from '../gim/geometry/geometryDiagnostics.js';
import { resetModHighlight, highlightModGroups } from '../viewer/highlight.js';
import { InvalidDevGeometryError } from '../gim/geometry/sourceGeometryError.js';
import { WorkQueue } from '../utils/workQueue.js';

interface CachedTemplate { result: DevGlbSerializationResult; sha: string; sourceInvalid?: { message: string; evidence: string } }
interface TemplateRow { bounds: THREE.Box3; template: DevGlbTemplate; sha: string; status: DevGlbSerializationResult['status']; diagnostics: DevGlbSerializationResult['diagnostics'] }
interface CacheDecision { key: string; devPath: string; lod: DeviceLod; status: DevArtifactReadStatus | 'compiled' | 'write-failed'; reason?: string }
interface Occurrence { entry: DevSpatialOccurrence; inView: boolean; box: THREE.Box3 | null; desired: DeviceLod | null; displayed: DeviceLod; skipTiny?: boolean; geometryStatus?: DevGlbSerializationResult['status']; group?: THREE.Group; key?: string; failedKey?: string }
const normalize = (path: string) => /^dev\//i.test(path.replace(/\\/g, '/')) ? path.replace(/\\/g, '/') : `DEV/${path}`;
/** 远景忽略最长边小于该值的构件（螺栓/线夹/间隔棒等），近景仍可按需选中加载。 */
const FAR_TINY_DEVICE_MAX_METERS = 1.5;
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(v => v.toString(16).padStart(2, '0')).join('');
const belongsTo = (object: THREE.Object3D, root?: THREE.Object3D) => {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (parent === root) return true;
  return false;
};

/** Session owner for catalog, templates and camera-driven occurrence representations. */
export class DevLodRuntime {
  readonly diagnostics = { catalogReady: false, currentViewReady: false, currentViewSettled: false, baseRepresentationsSettled: false, baseRepresentationsReady: false, allStationReady: false, catalogHits: 0,
    templateHits: 0, compiled: [0, 0, 0], /** Per-LOD cache/compile facts; index is LOD. */ lodHits: [0, 0, 0], lodCompiled: [0, 0, 0],
    lodReadErrors: [0, 0, 0], lodInvalid: [0, 0, 0], lodWriteFailed: [0, 0, 0], lodPersisted: [0, 0, 0],
    occurrences: 0, uniqueDevSources: 0, sceneCommitCount: 0, sceneCommitMaxMs: 0, shown: 0, pending: 0, unknownBounds: 0, tinySkipped: 0,
    absoluteConeCount: 0, templateResidentBytes: 0, directoryCompleted: 0, readyOccurrences: 0, failedOccurrences: 0,
    emptyOccurrences: 0, unsupportedOccurrences: 0, partialOccurrences: 0, templateParses: 0, templateEvictions: 0, workerCount: 0, activeDevices: [] as string[],
    inputBudgetBytes: 0, inputBudgetPeakBytes: 0,
    cacheReadBatches:0,cacheReadEntries:0,cacheReadDeferred:0,viewPendingOccurrences:0,
    cacheHits:0,cacheMisses:0,cacheReadErrorCount:0,cacheInvalidCount:0,
    lodMisses:[0,0,0],
    artifactWriteAttempts:0,artifactWriteFailures:0,catalogWriteFailures:0,
    workerReads:0,workerRpcReads:0,workerSourceHits:0,workerDocumentHits:0,workerReadRpcMs:0,workerParseMs:0,workerQueueWaitMs:0,
    cacheDecisions: [] as CacheDecision[], readinessBlockers:[] as string[],viewPendingSamples:[] as string[],
    resultQueuedBytes: 0, resultPeakBytes: 0, resultQueueCount: 0,
    anchorReady: false, errors: [] as string[], fingerprints: [] as Record<string, unknown>[] };
  private readonly perf = perfCurrentSession();
  private released = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cameraTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private commits: Array<{ priority: number; root?: string; run: () => void; reject: (e: Error) => void }> = [];
  private cameraMovingUntil = 0;
  private cameraSchedule = () => {
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
  private submit(priority: number, run: () => void, root?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const commit = { priority, root, run: () => { try { run(); resolve(); } catch (e) { reject(e); } }, reject };
      const position = this.commits.findIndex(row => row.priority > priority);
      if (position < 0) this.commits.push(commit); else this.commits.splice(position, 0, commit);
      this.drainCommits();
    });
  }
  private drainCommits(): void {
    if (this.commitTimer || !this.current()) return;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      const started = performance.now();

      while (this.commits.length && this.current()) {
        if (performance.now() < this.cameraMovingUntil && this.commits[0].priority > 0) break;
        this.commits.shift()!.run();
        if (performance.now() - started >= 4) break;
      }
      if (this.commits.length) this.drainCommits();
    }, 16);
  }
  private wanted = new Set<string>();
  private displayedPins = new Map<string, number>();
  private pinKeys = new RevisionSet<string>();
  private selected = '';
  private pending = new Map<string, Promise<TemplateRow | null>>();
  private nullResults = new Map<string, 'empty' | 'unsupported'>();
  private priorities = new Map<string, number>();
  private templateSlots = 0;
  private inputBudget = new ByteWorkBudget(128 * 1024 * 1024);
  private cacheReader:DevTemplateCacheReader<CachedTemplate>;
  /** Cache writes are bounded but never block scene commit. */
  private writeSlots = 0;
  private writeWaiters: Array<() => void> = [];
  private pendingWrites = new Map<string, Promise<void>>();
  private placementUsers = new Map<string, number>();
  private templateWaiters = new Map<string, { queuedAt: number; resolve: (release: () => void) => void; reject: (error: Error) => void }>();
  private templateQueue = new WorkQueue<{ queuedAt: number; resolve: (release: () => void) => void; reject: (error: Error) => void }>();
  private rows = new Map<string, Occurrence>();
  private sourceFailures = new Map<string, InvalidDevGeometryError>();
  private catalogHints = new Map<string, Promise<DevArtifactRead<DevSourceBounds>>>();
  private templates = new ByteLru<TemplateRow>(128 * 1024 * 1024, row => { row.template.dispose(); if (!this.released) this.diagnostics.templateEvictions++; });
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
    this.cacheReader=new DevTemplateCacheReader(this.inputBudget,session);
    this.catalogDone = new Promise(resolve => { this.finishCatalog = resolve; });
    this.anchorDone = new Promise(resolve => { this.finishAnchor = resolve; });
  }
  private current = () => !this.released && this.state.isCurrentSession(this.session);
  private key(dev: string, lod: DeviceLod) { return `${DEV_GEOMETRY_VERSION}|${this.sourceIdentity}|${dev.toLowerCase()}|lod${lod}`; }
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
    }
    this.worker?.cancelQueued(this.wanted);
  }
  private recordCacheDecision(devPath: string, lod: DeviceLod, status: CacheDecision['status'], reason?: string): void {
    this.diagnostics.cacheDecisions.push({ key: this.key(devPath, lod), devPath, lod, status, ...(reason ? { reason } : {}) });
    if (this.diagnostics.cacheDecisions.length > 1024) this.diagnostics.cacheDecisions.shift();
  }
  private async withWriteSlot<T>(work: () => Promise<T>): Promise<T> {
    while (this.writeSlots >= 4) await new Promise<void>((resolve) => this.writeWaiters.push(resolve));
    this.writeSlots++;
    try { return await work(); }
    finally { this.writeSlots--; this.writeWaiters.shift()?.(); }
  }
  /** Persist a derived artifact without blocking geometry availability.
   * Source SHA, project identity and atomic native replacement still apply. */
  private persistArtifact(store: 'templates' | 'catalog', key: string, value: unknown, lod?: DeviceLod, devPath?: string): void {
    if (!this.current() || !this.session.sourceSha256) return;
    const queueKey = `${store}:${key}`;
    if (this.pendingWrites.has(queueKey)) return;
    const task = this.withWriteSlot(async () => {
      if (!this.current()) return;
      this.diagnostics.artifactWriteAttempts++;
      const detail = await writeDevArtifactDetailed(store, key, value, this.session);
      if (!detail.ok) {
        if (store === 'catalog') this.diagnostics.catalogWriteFailures++;
        else if (lod != null) {
          this.diagnostics.lodWriteFailed[lod]++;
          this.recordCacheDecision(devPath ?? '', lod, 'write-failed', detail.error);
        }
        this.diagnostics.artifactWriteFailures++;
        this.diagnostics.errors.push(`缓存写入失败 ${store}:${key}: ${detail.error ?? 'unknown'}`);
        if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
      } else if (store === 'templates' && lod != null) {
        this.diagnostics.lodPersisted[lod]++;
      }
    }).catch((error) => {
      this.diagnostics.artifactWriteFailures++;
      this.diagnostics.errors.push(`缓存写入异常 ${store}:${key}: ${String(error)}`);
      if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
    }).finally(() => { this.pendingWrites.delete(queueKey); });
    this.pendingWrites.set(queueKey, task);
  }
  /**
   * 变电源 pack 下几何源默认是 lazy 的；Worker 按 DEV 逐条请求源字节，而
   * 每次往返都要排到繁忙的主线程序列（实测单条 30–90 ms），几千次读取会
   * 把首次几何阶段拖成数分钟。开始调度前用少量大批次 IPC 一次取回几何源，
   * 让 Worker 后续都从内存读取；批次顺序先 DEV/PHM/STL（包围盒首用），再 MOD。
   */
  private async preloadSources(files: Map<string, File>): Promise<Map<string, File>> {
    const projectId = this.session.projectId;
    if (projectId == null || !this.current()) return files;
    // 剩余 IFC 仍在后台加载时最多等 8 秒再预取，避免大批次 IPC 长时间挤占
    // 剩余 IFC 的读取/转换；超时后让预取与 IFC 并行，靠批次让出主线程。
    if (this.state.ifcBackgroundPending) {
      const started = performance.now();
      const deadline = started + 8000;
      while (this.state.ifcBackgroundPending && this.current() && performance.now() < deadline) {
        await Promise.race([
          this.state.waitForIfcBackgroundLoading(),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      }
      perfMark('DEV 几何源预取等待 IFC', { waitedMs: Math.round(performance.now() - started) },
        this.perf);
      if (!this.current()) return files;
    }
    const MAX_FILE_BYTES = 8 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
    const BATCH_FILES = 4096;
    const rank = (path: string): number => {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      return ext === 'dev' ? 0 : ext === 'phm' ? 1 : ext === 'stl' ? 2 : ext === 'gl' ? 3 : 4;
    };
    const candidates = [...files.keys()]
      .filter((path) => /\.(dev|phm|mod|stl|gl)$/i.test(path))
      .sort((a, b) => rank(a) - rank(b));
    if (candidates.length === 0) return files;
    const output = new Map(files);
    let loaded = 0;
    for (let i = 0; i < candidates.length && loaded < MAX_TOTAL_BYTES; i += BATCH_FILES) {
      if (!this.current()) break;
      const chunk = candidates.slice(i, i + BATCH_FILES);
      let result: Map<string, Uint8Array | null> | null = null;
      try {
        result = await batchReadCachedFiles(projectId, chunk);
      } catch {
        result = null;
      }
      if (!this.current()) break;
      if (!result) continue;
      for (const path of chunk) {
        const bytes = result.get(path);
        if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) continue;
        loaded += bytes.byteLength;
        if (loaded > MAX_TOTAL_BYTES) break;
        output.set(path, new File([bytes.slice().buffer as ArrayBuffer], path.split('/').pop() || path));
      }
    }
    return output;
  }

  async start(): Promise<void> {
    ensureGeometryLayers(this.state, (this.ctx.world.scene as any).three);
    if (!this.sourceIdentity && this.state.currentFiles) {
      // Without a verified source SHA, templates are session-local and persistence is disabled.
      this.sourceIdentity = `session:${this.session.generation}`;
    }
    let files = this.state.currentFiles;
    if (!files) {
      files = new Map();
      for (const path of this.state.substationEntryPaths) if (/\.(dev|phm|mod|stl|gl)$/i.test(path)) {
        const projectId = this.session.projectId;
        files.set(path, { name: path.split('/').pop()!, size: 0,
          arrayBuffer: async () => {
            if (projectId == null || !this.current()) throw Error('Device source unavailable');
            const bytes = await readCachedEntry(projectId, path);
            return new Uint8Array(bytes).buffer;
          } } as File);
      }
    }
    // 只有刚解压完的冷路径才做几何源预取：此时源在 pack 里、几何缓存为空，
    // 逐条 IPC 会把首次几何阶段拖成数分钟。暖路径的模板/目录缓存命中率高，
    // 预取反而会抢走首屏时间，保持原来的按需读取。
    const preload = this.state.currentFiles != null
      && (() => { try { return localStorage.getItem('gim-dev-preload') !== '0'; } catch { return true; } })();
    this.worker = createDevGeometryPreprocessor(
      this.state,
      this.session,
      preload ? await this.preloadSources(files) : files,
    );
    this.diagnostics.workerCount = this.worker.workerCount;
    this.worker.onActivity = () => this.requestReady();
    (this.ctx.world.camera as any).controls?.addEventListener('update', this.cameraSchedule);
    const seeds = collectCbmDeviceInstances(this.state.currentCbmTree);
    const byDev = new Map<string, typeof seeds>();
    for (const seed of seeds) {
      const dev = normalize(seed.devPath), list = byDev.get(dev) ?? []; list.push(seed); byDev.set(dev, list);
      this.rows.set(seed.path, { entry: { devPath: dev, sourceBounds: null, boundsQuality: 'unknown', primitiveCounts: {}, unsupportedTypes: [],
        instanceKey: `dev:${dev}#${seed.path}`, rootOccurrence: seed.path, placementMatrix: parseCbmTransformMatrix(seed.transformMatrix), templateStatus: 'unrequested' },
        inView: true, box: null, desired: 0, displayed: 0 });
    }
    this.diagnostics.occurrences = seeds.length;
    this.diagnostics.uniqueDevSources = byDev.size;
    this.notifyCoordinateAnchor(); this.update(); // Compilation can begin before any IFC is ready.
    // TYPE=OTHERS 或命名明确的线路金具/小构件在远景不参与范围目录和 L0 编译；
    // 选中时仍按需加载。避免 B1-4 对 15,526 个 occurrence 逐个解析 PHM。
    const smallPartName = /(间隔棒|线夹|悬垂|耐张|金具|螺栓|螺母|垫片|接地|电缆|爬梯|栏杆)|^\d+\s*[x×]\s*\d+/;
    const catalogEntries = [...byDev].filter(([, instances]) =>
      !instances.every(seed => seed.devType === 'OTHERS' || smallPartName.test(seed.name)));
    const catalogDevs = new Set(catalogEntries.map(([dev]) => dev));
    for (const [dev, instances] of byDev) {
      if (catalogDevs.has(dev)) continue;
      for (const seed of instances) {
        const row = this.rows.get(seed.path);
        if (row && !row.skipTiny) { row.skipTiny = true; this.diagnostics.tinySkipped++; }
      }
    }
    const resolveCatalog = async (dev: string): Promise<DevSourceBounds> => {
      const catalogRead = await this.catalogHint(dev);
      if (!this.current()) throw new DOMException('DEV directory left the current view', 'AbortError');
      let bounds = catalogRead.status === 'hit' ? catalogRead.value ?? null : null;
      const validBounds = bounds && bounds.devPath === dev && ['conservative', 'unknown', 'empty'].includes(bounds.boundsQuality)
        && (!bounds.sourceBounds || bounds.sourceBounds.length === 6 && bounds.sourceBounds.every(Number.isFinite)
          && bounds.sourceBounds.slice(0, 3).every((v, i) => v <= bounds!.sourceBounds![i + 3]));
      if (validBounds) {
        this.diagnostics.catalogHits++;
        this.diagnostics.cacheHits++;
      } else {
        if (catalogRead.status === 'invalid') {
          this.diagnostics.cacheInvalidCount++;
          this.diagnostics.errors.push(`目录缓存无效 ${dev}: ${catalogRead.error ?? ''}`);
          await deleteDevArtifact('catalog', this.catalogKey(dev), this.session);
        } else if (catalogRead.status === 'read-error') {
          this.diagnostics.cacheReadErrorCount++;
          this.diagnostics.errors.push(`目录缓存读取失败 ${dev}: ${catalogRead.error ?? ''}`);
        }
        if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
        try {bounds = await this.worker.bounds(dev);}
        catch(error){
          if(!this.current()) throw new DOMException('DEV directory left the current view', 'AbortError');
          bounds={devPath:dev,sourceBounds:null,boundsQuality:'unknown',primitiveCounts:{},unsupportedTypes:[],diagnostic:String(error)};
          this.diagnostics.errors.push(`目录 ${dev}: ${String(error)}`);if(this.diagnostics.errors.length>32)this.diagnostics.errors.shift();
        }
        if (!this.current()) throw new DOMException('DEV directory left the current view', 'AbortError');
        if (!bounds.diagnostic && this.session.sourceSha256) this.persistArtifact('catalog', this.catalogKey(dev), bounds);
      }
      return bounds ?? {devPath:dev,sourceBounds:null,boundsQuality:'unknown',primitiveCounts:{},unsupportedTypes:[],diagnostic:'missing-catalog-bounds'};
    };
    const applyCatalog = (dev: string, instances: typeof seeds, bounds: DevSourceBounds): void => {
      this.diagnostics.absoluteConeCount += bounds.absoluteConeCount ?? 0;
      const emptySource = !bounds.diagnostic && bounds.boundsQuality === 'empty';
      for (const seed of instances) {
        const matrix = parseCbmTransformMatrix(seed.transformMatrix);
        const entry: DevSpatialOccurrence = { ...bounds, instanceKey: `dev:${dev}#${seed.path}`, rootOccurrence: seed.path,
          placementMatrix: matrix, templateStatus: 'unrequested' };
        const box = bounds.sourceBounds ? boxTuple(bounds.sourceBounds).applyMatrix4(
          (this.anchor?.clone() ?? new THREE.Matrix4()).multiply(createLegacyEquivalentPlacementMatrix(matrix))) : null;
        const row = this.rows.get(seed.path)!;
        row.entry = { ...entry, templateStatus: emptySource ? 'empty' : row.entry.templateStatus }; row.box = box;
        if (box) {
          const extent = box.max.clone().sub(box.min);
          const maxMeters = Math.max(extent.x, extent.y, extent.z);
          if (Number.isFinite(maxMeters) && maxMeters < FAR_TINY_DEVICE_MAX_METERS) {
            row.skipTiny = true;
            this.diagnostics.tinySkipped++;
          }
        }
        if (emptySource) this.diagnostics.emptyOccurrences++;
        if (bounds.boundsQuality === 'unknown') {
          this.diagnostics.unknownBounds++; this.state.deviceUnknownBounds.add(seed.path);
        }
      }
      if (emptySource) {
        this.wanted.delete(this.key(dev, 0));
        this.worker?.cancelQueued(this.wanted);
      }
      this.diagnostics.directoryCompleted += instances.length;
      this.requestReady();
      if (instances.some(seed => seed.path === this.selected)) void this.select(this.selected).catch(error => console.warn('[DEV selected]', error));
    };
    const CATALOG_BATCH = 8;
    for (let start = 0; start < catalogEntries.length; start += CATALOG_BATCH) {
      if (!this.current()) return;
      const batch = catalogEntries.slice(start, start + CATALOG_BATCH);
      const boundsList = await Promise.all(batch.map(([dev]) => resolveCatalog(dev)));
      if (!this.current()) return;
      batch.forEach(([dev, instances], index) => applyCatalog(dev, instances, boundsList[index]));
      this.schedule(); // Incremental directory, without waiting for the last source.
    }
    if (!this.current()) return;
    this.diagnostics.catalogReady = true; this.finishCatalog();
    const { refreshDeviceBoundsMarkers } = await import('../ui/deviceBoundsMarker.js');
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
      const placement = matrix.clone().multiply(createLegacyEquivalentPlacementMatrix(row.entry.placementMatrix));
      row.box = row.entry.sourceBounds ? boxTuple(row.entry.sourceBounds).applyMatrix4(placement) : null;
      if (row.group) { row.group.matrix.copy(placement); row.group.updateMatrixWorld(true); }
    }
    this.schedule();
  }
  private pinned(): Set<string> { return this.pinKeys; }
  private acquireTemplateSlot(key: string): Promise<() => void> {
    return new Promise((resolve, reject) => { const waiter={queuedAt:performance.now(),resolve,reject}; this.templateWaiters.set(key,waiter); this.templateQueue.set(key,waiter,this.priorities.get(key) ?? 4,waiter.queuedAt); this.drainTemplates(); });
  }
  private drainTemplates(): void {
    while (this.current() && this.templateSlots < Math.max(8, this.worker.workerCount * 8) && this.templateWaiters.size) {
      const [key,waiter]=this.templateQueue.take()!;
      this.templateWaiters.delete(key); this.templateSlots++;
      let released = false;
      waiter.resolve(() => { if (released) return; released = true; this.templateSlots--; this.drainTemplates(); });
    }
  }
  private async template(dev: string, lod: DeviceLod, priority: number): Promise<TemplateRow | null> {
    if (this.sourceFailures.has(dev)) throw this.sourceFailures.get(dev)!;
    const key = this.key(dev, lod), cached = this.templates.get(key); if (cached) return cached;
    if (this.nullResults.has(key)) return null;
    this.priorities.set(key, Math.min(this.priorities.get(key) ?? priority, priority));
    const waiter=this.templateWaiters.get(key); if (waiter) this.templateQueue.set(key,waiter,this.priorities.get(key)!,waiter.queuedAt);
    const old = this.pending.get(key); if (old) { this.worker.promote(key, priority); return old; }
    const promise = (async () => {
      const releaseSlot = await this.acquireTemplateSlot(key);
      let releaseInput: (()=>void) | undefined;
      try {
      // Concurrent requests share one bounded native batch reservation.
      const lease=await this.cacheReader.read(key);releaseInput=lease.release;
      if (!this.current()) return null;
      let artifact: CachedTemplate | undefined = lease.value;
      let parsed: Awaited<ReturnType<typeof parseDevGlbAsset>> = null;
      let generated = false;
      if (!this.current()) return null;
      const cacheStatus = lease.status;
      if (cacheStatus === 'read-error') {
        this.diagnostics.lodReadErrors[lod]++;
        this.diagnostics.cacheReadErrorCount++;
        this.recordCacheDecision(dev, lod, 'read-error', lease.error);
        this.diagnostics.errors.push(`模板读取失败 ${dev} LOD${lod}: ${lease.error ?? ''}`);
        if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
        artifact = undefined;
      } else if (cacheStatus === 'invalid') {
        this.diagnostics.lodInvalid[lod]++;
        this.diagnostics.cacheInvalidCount++;
        this.recordCacheDecision(dev, lod, 'invalid', lease.error);
        this.diagnostics.errors.push(`模板缓存无效 ${dev} LOD${lod}: ${lease.error ?? ''}`);
        if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
        artifact = undefined;
      } else if (cacheStatus === 'miss') {
        this.diagnostics.lodMisses[lod]++;
        this.diagnostics.cacheMisses++;
        this.recordCacheDecision(dev, lod, 'miss');
        artifact = undefined;
      } else artifact = lease.value;
      if (artifact?.sourceInvalid?.evidence) {
        const error = new InvalidDevGeometryError(dev, artifact.sourceInvalid.message, artifact.sourceInvalid.evidence, 'warm');
        this.sourceFailures.set(dev, error);
        this.diagnostics.lodHits[lod]++;
        this.diagnostics.templateHits++;
        this.diagnostics.cacheHits++;
        this.recordCacheDecision(dev, lod, 'hit', 'source-invalid');
        throw error;
      }
      if (artifact && (!artifact.result || !['complete', 'partial', 'empty', 'unsupported'].includes(artifact.result.status)
        || artifact.result.diagnostics?.status !== artifact.result.status)) {
        this.recordCacheDecision(dev, lod, 'invalid', 'artifact-shape');
        this.diagnostics.lodInvalid[lod]++;
        this.diagnostics.cacheInvalidCount++;
        await deleteDevArtifact('templates', key, this.session);
        artifact = undefined;
      }
      if (artifact?.result.bytes) {
        try {
          if (artifact.result.bytes.byteLength > this.inputBudget.limit) throw Error('DEV cached input exceeds quota');
          if (await hash(artifact.result.bytes) !== artifact.sha) throw Error('DEV template SHA mismatch');
          parsed = await parseDevGlbAsset(dev, artifact.result.bytes);
          if (!parsed || !validateDevGlbTemplate(parsed).shareable || invalidGeometryExtent(parsed.scene)) throw Error('Invalid DEV cached template');
          this.diagnostics.lodHits[lod]++;
          this.diagnostics.templateHits++;
          this.diagnostics.cacheHits++;
          this.recordCacheDecision(dev, lod, 'hit');
        } catch (error) {
          if (parsed) new DevGlbTemplate(dev, parsed.scene, this.session).dispose();
          parsed = null;
          this.diagnostics.lodInvalid[lod]++;
          this.diagnostics.cacheInvalidCount++;
          this.recordCacheDecision(dev, lod, 'invalid', String(error));
          this.diagnostics.errors.push(`模板缓存校验失败 ${dev} LOD${lod}: ${String(error)}`);
          if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
          await deleteDevArtifact('templates', key, this.session);
          artifact = undefined;
        }
      } else if (artifact?.result.status === 'empty' || artifact?.result.status === 'unsupported') {
        this.diagnostics.lodHits[lod]++;
        this.diagnostics.templateHits++;
        this.diagnostics.cacheHits++;
        this.recordCacheDecision(dev, lod, 'hit', artifact.result.status);
        setGeometryDiagnostic(this.state, diagnosticFromSerialization(dev, artifact.result.diagnostics, 'warm'));
        this.nullResults.set(key, artifact.result.status);
        return null;
      } else if (artifact) artifact = undefined;
      if (!artifact) {
        const hint = await this.catalogHint(dev);
        if (hint.status === 'hit' && hint.value?.devPath === dev && hint.value.boundsQuality === 'empty' && !hint.value.diagnostic) {
          this.markEmptyDev(dev);
          this.diagnostics.emptyOccurrences++;
          this.nullResults.set(key, 'empty');
          this.recordCacheDecision(dev, lod, 'hit', 'catalog-empty');
          return null;
        }
        if (!this.wanted.has(key)) throw new DOMException('DEV request left the view', 'AbortError');
        generated = true;
        releaseInput(); releaseInput=undefined;
        const result = await this.worker.compile(dev, lod, key, this.priorities.get(key) ?? priority).catch(async error => {
          if (error instanceof InvalidDevGeometryError && error.sourceEvidence && this.current()) {
            this.sourceFailures.set(dev, error);
            if (this.session.sourceSha256) this.persistArtifact('templates', key,
              { sourceInvalid: { message: error.reason, evidence: error.sourceEvidence } }, lod, dev);
          }
          throw error;
        });
        if (!this.current()) return null;
        releaseInput = await this.inputBudget.acquire(result.bytes?.byteLength ?? 0);
        if (!this.current()) return null;
        this.diagnostics.compiled[lod]++;
        this.diagnostics.lodCompiled[lod]++;
        this.recordCacheDecision(dev, lod, 'compiled', cacheStatus);
        artifact = { result, sha: result.bytes ? result.sha256 ?? await hash(result.bytes) : '' };
      }
      if (!this.current()) return null;
      setGeometryDiagnostic(this.state, diagnosticFromSerialization(dev, artifact.result.diagnostics, generated ? 'cold' : 'warm'));
      if (!artifact.result.bytes) {
        if (artifact.result.status === 'empty' || artifact.result.status === 'unsupported') {
          this.nullResults.set(key, artifact.result.status);
          if (this.session.sourceSha256) this.persistArtifact('templates', key, artifact, lod, dev);
        }
        return null;
      }
      parsed ??= await parseDevGlbAsset(dev, artifact.result.bytes);
      if (!parsed || !validateDevGlbTemplate(parsed).shareable || invalidGeometryExtent(parsed.scene)) {
        if (parsed) new DevGlbTemplate(dev, parsed.scene, this.session).dispose();
        throw Error(`DEV GLB invalid: ${dev}`);
      }
      // Show geometry first; persistence is bounded and asynchronous. A failed
      // write is recorded by persistArtifact and never advertised as warm.
      if (generated && this.session.sourceSha256) this.persistArtifact('templates', key, artifact, lod, dev);
      const row = { bounds: new THREE.Box3().setFromObject(parsed.scene), template: new DevGlbTemplate(dev, parsed.scene, this.session), sha: artifact.sha, status: artifact.result.status, diagnostics: artifact.result.diagnostics };
      this.diagnostics.templateParses++;
      if (!this.current()) { row.template.dispose(); return null; }
      const pinned = this.pinned(); pinned.add(key); // caller commits or releases before next trim
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
      this.templates.set(key, row, bytes, pinned); this.diagnostics.templateResidentBytes = this.templates.bytes; return row;
      } finally { releaseInput?.(); releaseSlot(); }
    })();
    this.pending.set(key, promise); this.diagnostics.pending = this.pending.size;
    try { return await promise; } finally { if (this.pending.get(key) === promise) { this.pending.delete(key); this.priorities.delete(key); } this.diagnostics.pending = this.pending.size; this.worker.acknowledge(key); }
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
    this.notifyCoordinateAnchor();
    const camera = (this.ctx.world.camera as any).three as THREE.Camera;
    const canvas = (this.ctx.world.renderer as any)?.three?.domElement as HTMLCanvasElement | undefined;
    const rect = canvas?.getBoundingClientRect();
    const view = createDeviceViewContext(camera, rect?.width || 1000, rect?.height || 800);
    const wanted = new Set<string>();
    this.wanted = wanted;
    for (const row of this.rows.values()) {
      const selected = row.entry.rootOccurrence === this.selected;
      const terminal = row.entry.templateStatus === 'empty' || row.entry.templateStatus === 'unsupported';
      const metrics = this.anchor && row.box ? deviceViewMetrics(row.box, camera, rect?.width || 1000, rect?.height || 800, view) : null;
      // Unknown bounds are not evidence of visibility. They still receive an
      // automatic LOD0 in the background; only catalogued boxes decide whether
      // the current view is blocked on this occurrence.
      row.inView = selected || (row.box && metrics ? metrics.visible : false);
      if (terminal || (row.skipTiny && !selected)) { row.desired = 0; continue; }
      // Unknown ranges compile actual supported geometry automatically. No
      // invented box, false culling or tree-selection prerequisite is used.
      const lod = selected ? 2 : !row.group ? 0 : metrics ? chooseDeviceLod(row.displayed, metrics.visible, metrics.distance, metrics.pixels) : 0;
      row.desired = lod;
      const key = this.key(row.entry.devPath, lod); wanted.add(key);
      // Base representation must not sit behind detail compiles. Only an
      // explicit selection outranks LOD0; LOD1/2 for proximity follow it.
      const priority = selected ? 0 : lod === 0 ? 1 : 2;
      if (row.key !== key && row.failedKey !== key) void this.render(row, lod, priority).catch(e => this.failed(row, e, key));
    }
    this.worker?.cancelQueued(wanted); this.templates.trim(this.pinned());
    for (const [key, waiter] of this.templateWaiters) if (!wanted.has(key)) {
      this.templateWaiters.delete(key); this.templateQueue.delete(key); waiter.reject(new DOMException('DEV request left the current view', 'AbortError'));
    }
    this.diagnostics.templateResidentBytes = this.templates.bytes;
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
      if (row.entry.templateStatus === 'empty') { this.nullResults.set(key, 'empty'); this.requestReady(); return; }
      row.entry.templateStatus = this.nullResults.get(key) ?? 'failed'; this.requestReady(); return;
    }
    if (!this.anchor) await this.anchorDone;
    if (!this.current() || row.desired !== lod || row.key === key) return;
    await this.submit(priority, () => {
    if (!this.current() || row.desired !== lod || row.key === key) return;
    const started = performance.now();
    const group = template.template.createPlacement({ contract: 'source-template', rootOccurrence: row.entry.rootOccurrence,
      instanceKey: row.entry.instanceKey, placementMatrix: row.entry.placementMatrix, projectSourceToViewerMatrix: this.anchor });
    const worldBounds = template.bounds.clone().applyMatrix4(group.matrix);
    const invalidPlacement = ![...worldBounds.min.toArray(), ...worldBounds.max.toArray()].every(Number.isFinite) ? 'non-finite-placement' : Math.max(...worldBounds.getSize(new THREE.Vector3()).toArray()) > GEOMETRY_MAX_EXTENT_M ? 'oversized-placement' : null;
    if (invalidPlacement) { group.clear(); throw Error(`DEV placement rejected: ${row.entry.rootOccurrence}: ${invalidPlacement}`); }
    group.userData.deviceLod = lod;
    group.name = row.entry.instanceKey;
    const highlighted = this.state.highlightedModState?.groups.filter(object => belongsTo(object, row.group)) ?? [];
    const highlightScopes = highlighted.map(object => object === row.group ? null : { devPath: object.userData.devPath, assemblyPath: object.userData.assemblyPath, referencePath: object.userData.referencePath });
    if (highlighted.length) resetModHighlight(this.state);
    this.state.modRootGroup!.add(group); row.group?.removeFromParent();
    if (row.key) { const count = (this.displayedPins.get(row.key) ?? 1) - 1; if (count) this.displayedPins.set(row.key, count); else { this.displayedPins.delete(row.key); if (!this.placementUsers.has(row.key)) this.pinKeys.delete(row.key); } }
    this.displayedPins.set(key, (this.displayedPins.get(key) ?? 0) + 1);
    row.group = group; row.key = key; row.displayed = lod; row.entry.templateStatus = 'ready';
    row.geometryStatus = template.status; row.failedKey = undefined;
    this.state.loadedXmlModGroups.set(row.entry.instanceKey, group);
    if (highlighted.length) {
      const replacements: THREE.Object3D[] = [];
      group.traverse(object => {
        if (replacements.some(parent => belongsTo(object, parent))) return;
        if (highlightScopes.some(scope => scope ? Object.entries(scope).every(([field,value]) => object.userData[field] === value) : object === group)) replacements.push(object);
      });
      highlightModGroups(this.state, replacements);
    }
    if (this.diagnostics.fingerprints.length < 64 || row.entry.rootOccurrence === this.selected) {
      const local = template.bounds, world = worldBounds;
      const fingerprint = { sourceSha: this.session.sourceSha256, devPath: row.entry.devPath, instanceKey: row.entry.instanceKey, lod,
        templateSha: template.sha, localBounds: tupleBox(local), placementMatrix: row.entry.placementMatrix,
        firstIfc: this.state.currentIfcEntries[0]?.path, projectMatrix: this.state.projectSourceToViewerMatrix?.toArray(),
        worldBounds: tupleBox(world), center: world.getCenter(new THREE.Vector3()).toArray() };
      this.diagnostics.fingerprints.push(fingerprint);
      if (this.diagnostics.fingerprints.length > 128) this.diagnostics.fingerprints.shift();
      perfMark('DEV placement fingerprint', fingerprint, this.perf);
    }
    this.diagnostics.shown = this.state.loadedXmlModGroups.size;
    this.diagnostics.sceneCommitCount++;
    this.diagnostics.sceneCommitMaxMs = Math.max(this.diagnostics.sceneCommitMaxMs, performance.now() - started);
    perfMark('DEV scene commit', { key, instanceKey: row.entry.instanceKey, durationMs: performance.now() - started }, this.perf);
    this.requestReady();
    this.schedule(); // Reconsider detail only after a base representation exists.
    }, row.entry.rootOccurrence);
    } finally {
      const users = (this.placementUsers.get(key) ?? 1) - 1;
      if (users) this.placementUsers.set(key, users); else this.placementUsers.delete(key);
      if (!this.placementUsers.has(key) && !this.displayedPins.has(key)) this.pinKeys.delete(key);
      this.templates.trim(this.pinned());
    }
  }
  private failed(row: Occurrence, error: unknown, requestKey: string): void {
    if (!this.current()) return;
    if (row.entry.templateStatus === 'empty') return;
    if (row.desired === null || this.key(row.entry.devPath, row.desired) !== requestKey) return;
    // A queued request may be cancelled while an earlier evaluation is still
    // unwinding. If the same key is wanted again, it needs another drive.
    if((error as Error)?.name==='AbortError'){this.schedule();return;}
    row.entry.templateStatus = 'failed';
    row.failedKey = requestKey;
    this.diagnostics.errors.push(`${row.entry.devPath}: ${String(error)}`);
    if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
    setGeometryDiagnostic(this.state, diagnosticForFailure(row.entry.devPath,
      error instanceof InvalidDevGeometryError && error.sourceEvidence ? 'source-invalid' : 'parse-failed',
      error instanceof InvalidDevGeometryError ? error.source : 'cold', String(error)));
    this.requestReady();
  }
  private ready(): void {
    if (!this.current()) return;
    let total = 0, visible = 0, finished = 0, shown = 0, empty = 0, unsupported = 0, partial = 0, failed = 0,viewPending=0;
    let viewSettled = true, viewReady = true, baseSettled = true, baseReady = true, allReady = true;
    const samples:string[]=[];
    for (const row of this.rows.values()) {
      total++;
      const terminal = row.entry.templateStatus === 'empty' || row.entry.templateStatus === 'unsupported';
      const key = this.key(row.entry.devPath, row.desired!);
      const complete = !!row.group || terminal, requested = terminal || row.key === key, failure = row.failedKey === key;
      if (complete || failure) finished++;
      baseSettled &&= complete || failure; baseReady &&= complete;
      allReady &&= row.entry.templateStatus === 'empty' || row.geometryStatus === 'complete' && row.displayed === 2;
      if (row.inView) { visible++; viewSettled &&= requested || failure; viewReady &&= requested && !failure;if(!requested&&!failure){viewPending++;if(samples.length<8)samples.push(`${row.entry.devPath}: LOD${row.displayed}→${row.desired}`);} }
      if (row.group) shown++;
      if (row.entry.templateStatus === 'empty') empty++;
      if (row.entry.templateStatus === 'unsupported') unsupported++;
      if (row.geometryStatus === 'partial') partial++;
      if (row.entry.templateStatus === 'failed') failed++;
    }
    const stable = !this.cameraTimer && !this.timer && this.diagnostics.anchorReady;
    const blockers=[!this.diagnostics.anchorReady?'等待坐标锚点':'',!this.diagnostics.catalogReady?'设备范围索引准备中':'',this.cameraTimer?'等待相机停稳':'',
      this.pending.size?`模板处理中 ${this.pending.size}`:'',this.templateWaiters.size?`模板排队 ${this.templateWaiters.size}`:'',this.commits.length?`场景待提交 ${this.commits.length}`:''].filter(Boolean);
    const ready = stable && viewReady && failed === 0 && (visible > 0 || this.diagnostics.catalogReady);
    if (ready && !this.diagnostics.currentViewReady) {
      perfMark('DEV current view ready', { shown, requested: visible, compiled: [...this.diagnostics.compiled], hits: [...this.diagnostics.lodHits], failed }, this.perf);
      perfMarkProductMoment('devCurrentViewReady', {
        path: 'device-lod', shown, requested: visible, compiled: [...this.diagnostics.compiled],
        lodHits: [...this.diagnostics.lodHits], failed, catalogReady: this.diagnostics.catalogReady,
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
    Object.assign(this.diagnostics, { currentViewSettled: stable && this.diagnostics.catalogReady && viewSettled, currentViewReady: ready,
      baseRepresentationsSettled: nextBaseSettled,
      baseRepresentationsReady: this.diagnostics.anchorReady && this.diagnostics.catalogReady && baseReady,
      allStationReady: nextAllReady,
      readyOccurrences: shown, emptyOccurrences: empty, unsupportedOccurrences: unsupported, partialOccurrences: partial, failedOccurrences: failed,
      shown: this.state.loadedXmlModGroups.size, activeDevices: this.worker?.activePaths ?? [],viewPendingOccurrences:viewPending,
      readinessBlockers:blockers,viewPendingSamples:samples,
      cacheReadBatches:this.cacheReader.diagnostics.batches,cacheReadEntries:this.cacheReader.diagnostics.entries,cacheReadDeferred:this.cacheReader.diagnostics.deferred });
    const active = this.diagnostics.activeDevices.join('、');
    this.diagnostics.inputBudgetBytes=this.inputBudget.bytes;this.diagnostics.inputBudgetPeakBytes=this.inputBudget.peakBytes;
    const ws=this.worker?.diagnostics;
    if (ws) {
      this.diagnostics.workerReads=ws.reads;this.diagnostics.workerRpcReads=ws.rpcReads;
      this.diagnostics.workerSourceHits=ws.sourceHits;this.diagnostics.workerDocumentHits=ws.documentHits;
      this.diagnostics.workerReadRpcMs=Math.round(ws.readRpcMs);this.diagnostics.workerParseMs=Math.round(ws.parseMs);
      this.diagnostics.workerQueueWaitMs=Math.round(ws.queueWaitMs);
    }
    const pressure=this.worker?.resultPressure;
    this.diagnostics.resultQueuedBytes=pressure?.bytes ?? 0;this.diagnostics.resultPeakBytes=pressure?.peakBytes ?? 0;
    this.diagnostics.resultQueueCount=pressure?.count ?? 0;
    const phase = !this.diagnostics.catalogReady
      ? `设备范围索引准备中 ${this.diagnostics.directoryCompleted}/${total}`
      : this.diagnostics.currentViewSettled
        ? ready ? '当前视图已完成' : '当前视图已完成，部分实例失败'
        : `当前视图准备中${viewPending ? ` ${viewPending}` : ''}`;
    const background = this.diagnostics.currentViewSettled && !this.diagnostics.baseRepresentationsSettled ? ' · 后台补充基础表示' : '';
    const cold = this.diagnostics.compiled, warm = this.diagnostics.lodHits;
    const failedCount = this.diagnostics.failedOccurrences;
    const displayedFinished = finished < total ? Math.min(total, finished + 1) : total;
    const cacheProblems = this.diagnostics.lodReadErrors.reduce((a,b)=>a+b,0)
      + this.diagnostics.lodInvalid.reduce((a,b)=>a+b,0)
      + this.diagnostics.artifactWriteFailures;
    this.status(
      `几何实例已处理 ${displayedFinished}/${total} · 已显示 ${this.diagnostics.readyOccurrences}${this.diagnostics.tinySkipped ? ` · 忽略小构件 ${this.diagnostics.tinySkipped}` : ''} · 冷编译 L0 ${cold[0]}/L1 ${cold[1]}/L2 ${cold[2]} · 缓存命中 L0 ${warm[0]}/L1 ${warm[1]}/L2 ${warm[2]}${failedCount ? ` · 失败 ${failedCount}` : ''} · ${phase}${background}`,
      `LOD缓存 miss ${this.diagnostics.cacheMisses} · read-error ${this.diagnostics.cacheReadErrorCount} · invalid ${this.diagnostics.cacheInvalidCount} · 写入失败 ${this.diagnostics.artifactWriteFailures}`
        + ` · 目录 ${this.diagnostics.directoryCompleted}/${total}${this.diagnostics.catalogReady?'（就绪）':'（进行中）'}`
        + ` · 批读 ${this.diagnostics.cacheReadBatches} 批/${this.diagnostics.cacheReadEntries} 条（defer ${this.diagnostics.cacheReadDeferred}）`
        + ` · 淘汰 ${this.diagnostics.templateEvictions} · 部分表示 ${this.diagnostics.partialOccurrences}`
        + `${cacheProblems ? ` · 缓存问题 ${cacheProblems}` : ''}`
        + `${blockers.length?` · ${blockers.join(' · ')}`:''}${active ? ` · ${active}` : ''}`);
    this.diagnostics.cacheReadBatches=this.cacheReader.diagnostics.batches;
    this.diagnostics.cacheReadEntries=this.cacheReader.diagnostics.entries;
    this.diagnostics.cacheReadDeferred=this.cacheReader.diagnostics.deferred;
    // No work owns a still-wanted row: recover a cancelled scheduling turn.
    if(stable&&viewPending&&!this.pending.size&&!this.templateWaiters.size&&!this.commits.length)this.schedule();
  }
  clearSelection(): void { this.selected = ''; this.schedule(); }
  resourceCounts() {
    const geometry = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    for (const row of this.templates.values()) {
      for (const value of row.template.geometryRefs) geometry.add(value);
      for (const value of row.template.materialRefs) materials.add(value);
      for (const value of row.template.textureRefs) textures.add(value);
    }
    return { templateCount: this.templates.size, templateParseCount: this.diagnostics.templateParses,
      sharedGeometryCount: geometry.size, sharedMaterialCount: materials.size, sharedTextureCount: textures.size };
  }
  async select(rootOccurrence: string): Promise<THREE.Group[]> {
    if (!this.current()) return [];
    this.selected = rootOccurrence;
    for (const commit of this.commits) if (commit.root === rootOccurrence) commit.priority = 0;
    this.commits.sort((a,b) => a.priority-b.priority);
    if (!this.rows.has(rootOccurrence)) await this.catalogDone;
    const row = this.rows.get(rootOccurrence);
    if (!row || !this.current() || this.selected !== rootOccurrence) return [];
    row.desired = 2;
    this.wanted.add(this.key(row.entry.devPath, 2));
    row.failedKey = undefined; // Explicit selection retries transient failures; source-invalid stays isolated.
    try { await this.render(row, 2, 0); }
    catch (error) { this.failed(row, error, this.key(row.entry.devPath, 2)); throw error; }
    if (!this.anchor) {
      await this.anchorDone;
      if (!this.current() || this.selected !== rootOccurrence) return [];
      await this.render(row, 2, 0);
    }
    return this.current() && row.group ? [row.group] : [];
  }
  release(): void {
    if (this.released) return; this.released = true; this.inputBudget.close();this.cacheReader.close(); this.finishCatalog(); this.finishAnchor();
    for (const waiter of this.templateWaiters.values()) waiter.reject(new DOMException('DEV session expired', 'AbortError'));
    this.templateWaiters.clear(); this.templateQueue.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.cameraTimer) clearTimeout(this.cameraTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.commitTimer) clearTimeout(this.commitTimer);
    for (const commit of this.commits) commit.reject(new DOMException('DEV session expired', 'AbortError'));
    this.commits = [];
    (this.ctx.world.camera as any).controls?.removeEventListener('update', this.cameraSchedule);
    this.worker?.cancel();
    for (const row of this.rows.values()) { if (row.group && this.state.highlightedModState?.groups.some(object => belongsTo(object, row.group))) resetModHighlight(this.state); row.group?.removeFromParent(); this.state.loadedXmlModGroups.delete(row.entry.instanceKey); }
    this.templates.clear(); this.rows.clear(); this.catalogHints.clear(); this.state.deviceUnknownBounds.clear();
  }
}
export async function startDeviceLod(state: AppState, ctx: ViewerContext, session: ProjectLoadSession, status: (text: string, detail?: string) => void): Promise<DevLodRuntime> {
  if (state.deviceLodRuntime instanceof DevLodRuntime && state.deviceLodRuntime.belongsTo(session)) {
    state.deviceLodRuntime.notifyCoordinateAnchor(); await state.deviceLodRuntime.startup; return state.deviceLodRuntime;
  }
  state.deviceLodRuntime?.release();
  const runtime = new DevLodRuntime(state, ctx, session, status); state.deviceLodRuntime = runtime;
  try { runtime.startup = runtime.start(); await runtime.startup; return runtime; }
  catch (error) { runtime.release(); if (state.deviceLodRuntime === runtime) state.deviceLodRuntime = null; throw error; }
}
