import { ByteWorkBudget } from '../utils/byteWorkBudget.js';
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
import { readDevArtifact, writeDevArtifact, deleteDevArtifact } from '@desktop/devLodCache.js';
import { readCachedEntry } from '@desktop/database.js';
import { perfCurrentSession, perfMark } from '../utils/perfTimings.js';
import { diagnosticForFailure, diagnosticFromSerialization, setGeometryDiagnostic } from '../gim/geometry/geometryDiagnostics.js';
import { resetModHighlight, highlightModGroups } from '../viewer/highlight.js';
import { InvalidDevGeometryError } from '../gim/geometry/sourceGeometryError.js';
import { WorkQueue } from '../utils/workQueue.js';

interface CachedTemplate { result: DevGlbSerializationResult; sha: string; sourceInvalid?: { message: string; evidence: string } }
interface TemplateRow { bounds: THREE.Box3; template: DevGlbTemplate; sha: string; status: DevGlbSerializationResult['status']; diagnostics: DevGlbSerializationResult['diagnostics'] }
interface Occurrence { entry: DevSpatialOccurrence; label: string; inView: boolean; box: THREE.Box3 | null; desired: DeviceLod | null; displayed: DeviceLod; geometryStatus?: DevGlbSerializationResult['status']; group?: THREE.Group; key?: string; failedKey?: string }
const normalize = (path: string) => /^dev\//i.test(path.replace(/\\/g, '/')) ? path.replace(/\\/g, '/') : `DEV/${path}`;
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(v => v.toString(16).padStart(2, '0')).join('');
const belongsTo = (object: THREE.Object3D, root?: THREE.Object3D) => {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (parent === root) return true;
  return false;
};

/** Session owner for catalog, templates and camera-driven occurrence representations. */
export class DevLodRuntime {
  readonly diagnostics = { catalogReady: false, currentViewReady: false, currentViewSettled: false, baseRepresentationsSettled: false, baseRepresentationsReady: false, allStationReady: false, catalogHits: 0,
    templateHits: 0, compiled: [0, 0, 0], occurrences: 0, uniqueDevSources: 0, sceneCommitCount: 0, sceneCommitMaxMs: 0, shown: 0, pending: 0, unknownBounds: 0,
    absoluteConeCount: 0, templateResidentBytes: 0, directoryCompleted: 0, readyOccurrences: 0, failedOccurrences: 0,
    emptyOccurrences: 0, unsupportedOccurrences: 0, partialOccurrences: 0, templateParses: 0, templateEvictions: 0, workerCount: 0, activeDevices: [] as string[],
    inputBudgetBytes: 0, inputBudgetPeakBytes: 0,
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
  private placementUsers = new Map<string, number>();
  private templateWaiters = new Map<string, { queuedAt: number; resolve: (release: () => void) => void; reject: (error: Error) => void }>();
  private templateQueue = new WorkQueue<{ queuedAt: number; resolve: (release: () => void) => void; reject: (error: Error) => void }>();
  private rows = new Map<string, Occurrence>();
  private sourceFailures = new Map<string, InvalidDevGeometryError>();
  private catalogByDev = new Map<string, DevSourceBounds>();
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
    this.catalogDone = new Promise(resolve => { this.finishCatalog = resolve; });
    this.anchorDone = new Promise(resolve => { this.finishAnchor = resolve; });
  }
  private current = () => !this.released && this.state.isCurrentSession(this.session);
  private key(dev: string, lod: DeviceLod) { return `${DEV_GEOMETRY_VERSION}|${this.sourceIdentity}|${dev.toLowerCase()}|lod${lod}`; }
  private catalogKey(dev: string) { return `${DEV_SPATIAL_CATALOG_VERSION}|${DEV_GEOMETRY_VERSION}|${this.sourceIdentity}|${dev.toLowerCase()}`; }
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
    this.worker = createDevGeometryPreprocessor(this.state, this.session, files);
    this.diagnostics.workerCount = this.worker.workerCount;
    this.worker.onActivity = () => this.requestReady();
    (this.ctx.world.camera as any).controls?.addEventListener('update', this.cameraSchedule);
    const seeds = collectCbmDeviceInstances(this.state.currentCbmTree);
    const byDev = new Map<string, typeof seeds>();
    for (const seed of seeds) {
      const dev = normalize(seed.devPath), list = byDev.get(dev) ?? []; list.push(seed); byDev.set(dev, list);
      this.rows.set(seed.path, { entry: { devPath: dev, sourceBounds: null, boundsQuality: 'unknown', primitiveCounts: {}, unsupportedTypes: [],
        instanceKey: `dev:${dev}#${seed.path}`, rootOccurrence: seed.path, placementMatrix: parseCbmTransformMatrix(seed.transformMatrix), templateStatus: 'unrequested' },
        label: seed.name || seed.devSymbolName || '设备', inView: true, box: null, desired: 0, displayed: 0 });
    }
    this.diagnostics.occurrences = seeds.length;
    this.diagnostics.uniqueDevSources = byDev.size;
    this.notifyCoordinateAnchor(); this.update(); // Compilation can begin before any IFC is ready.
    const catalogEntries=[...byDev];
    const catalogReads=new Map<string,Promise<DevSourceBounds|null>>();
    let catalogIndex=0;
    for (const [dev, instances] of catalogEntries) {
      if (!this.current()) return;
      if (catalogIndex%16===0) {
        catalogReads.clear();
        for (const [path] of catalogEntries.slice(catalogIndex,catalogIndex+16))
          catalogReads.set(path,readDevArtifact<DevSourceBounds>('catalog',this.catalogKey(path),this.session));
      }
      catalogIndex++;
      let bounds = await catalogReads.get(dev)!;
      if (!this.current()) return;
      if (bounds && bounds.devPath === dev && ['conservative', 'unknown', 'empty'].includes(bounds.boundsQuality)
        && (!bounds.sourceBounds || bounds.sourceBounds.length === 6 && bounds.sourceBounds.every(Number.isFinite)
          && bounds.sourceBounds.slice(0, 3).every((v, i) => v <= bounds!.sourceBounds![i + 3]))) this.diagnostics.catalogHits++;
      else {
        bounds = await this.worker.bounds(dev);
        if (!this.current()) return;
        if (!bounds.diagnostic && this.session.sourceSha256) await writeDevArtifact('catalog', this.catalogKey(dev), bounds, this.session);
      }
      this.catalogByDev.set(dev, bounds);
      this.diagnostics.absoluteConeCount += bounds.absoluteConeCount ?? 0;
      for (const seed of instances) {
        const matrix = parseCbmTransformMatrix(seed.transformMatrix);
        const entry: DevSpatialOccurrence = { ...bounds, instanceKey: `dev:${dev}#${seed.path}`, rootOccurrence: seed.path,
          placementMatrix: matrix, templateStatus: 'unrequested' };
        const box = bounds.sourceBounds ? boxTuple(bounds.sourceBounds).applyMatrix4(
          (this.anchor?.clone() ?? new THREE.Matrix4()).multiply(createLegacyEquivalentPlacementMatrix(matrix))) : null;
        const row = this.rows.get(seed.path)!;
        row.entry = { ...entry, templateStatus: row.entry.templateStatus }; row.box = box;
        if (bounds.boundsQuality === 'unknown') {
          this.diagnostics.unknownBounds++; this.state.deviceUnknownBounds.add(seed.path);
        }
      }
      this.diagnostics.directoryCompleted += instances.length;
      this.requestReady();
      if (instances.some(seed => seed.path === this.selected)) void this.select(this.selected).catch(error => console.warn('[DEV selected]', error));
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
    while (this.current() && this.templateSlots < this.worker.workerCount * 2 && this.templateWaiters.size) {
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
      // Cache entry size is not known before IPC/IDB read. Reserve the full
      // single-entry quota, bounding warm read + hash + parse as one stage.
      releaseInput = await this.inputBudget.acquire(this.inputBudget.limit);
      if (!this.current()) return null;
      let artifact = await readDevArtifact<CachedTemplate>('templates', key, this.session), parsed: Awaited<ReturnType<typeof parseDevGlbAsset>> = null;
      let generated = false;
      if (!this.current()) return null;
      if (artifact?.sourceInvalid?.evidence) {
        const error = new InvalidDevGeometryError(dev, artifact.sourceInvalid.message, artifact.sourceInvalid.evidence, 'warm');
        this.sourceFailures.set(dev, error); throw error;
      }
      if (artifact && (!artifact.result || !['complete', 'partial', 'empty', 'unsupported'].includes(artifact.result.status)
        || artifact.result.diagnostics?.status !== artifact.result.status)) {
        await deleteDevArtifact('templates', key, this.session); artifact = null;
      }
      if (artifact?.result.bytes) {
        try {
          if (artifact.result.bytes.byteLength > this.inputBudget.limit) throw Error('DEV cached input exceeds quota');
          if (await hash(artifact.result.bytes) !== artifact.sha) throw Error('DEV template SHA mismatch');
          parsed = await parseDevGlbAsset(dev, artifact.result.bytes);
          if (!parsed || !validateDevGlbTemplate(parsed).shareable || invalidGeometryExtent(parsed.scene)) throw Error('Invalid DEV cached template');
          this.diagnostics.templateHits++;
        } catch { if (parsed) new DevGlbTemplate(dev, parsed.scene, this.session).dispose(); parsed = null; await deleteDevArtifact('templates', key, this.session); artifact = null; }
      } else if (artifact?.result.status === 'empty' || artifact?.result.status === 'unsupported') {
        setGeometryDiagnostic(this.state, diagnosticFromSerialization(dev, artifact.result.diagnostics, 'warm')); this.nullResults.set(key, artifact.result.status); return null;
      } else artifact = null;
      if (!artifact) {
        if (!this.wanted.has(key)) throw new DOMException('DEV request left the view', 'AbortError');
        generated = true;
        releaseInput(); releaseInput=undefined;
        const result = await this.worker.compile(dev, lod, key, this.priorities.get(key) ?? priority).catch(async error => {
          if (error instanceof InvalidDevGeometryError && error.sourceEvidence && this.current()) {
            this.sourceFailures.set(dev, error);
            if (this.session.sourceSha256) await writeDevArtifact('templates', key,
              { sourceInvalid: { message: error.reason, evidence: error.sourceEvidence } }, this.session);
          }
          throw error;
        });
        if (!this.current()) return null;
        releaseInput = await this.inputBudget.acquire(result.bytes?.byteLength ?? 0);
        if (!this.current()) return null;
        this.diagnostics.compiled[lod]++;
        artifact = { result, sha: result.bytes ? result.sha256 ?? await hash(result.bytes) : '' };
      }
      if (!this.current()) return null;
      setGeometryDiagnostic(this.state, diagnosticFromSerialization(dev, artifact.result.diagnostics, generated ? 'cold' : 'warm'));
      if (!artifact.result.bytes) {
        if (artifact.result.status === 'empty' || artifact.result.status === 'unsupported') {
          this.nullResults.set(key, artifact.result.status);
          if (this.session.sourceSha256) await writeDevArtifact('templates', key, artifact, this.session);
        }
        return null;
      }
      parsed ??= await parseDevGlbAsset(dev, artifact.result.bytes);
      if (!parsed || !validateDevGlbTemplate(parsed).shareable || invalidGeometryExtent(parsed.scene)) {
        if (parsed) new DevGlbTemplate(dev, parsed.scene, this.session).dispose();
        throw Error(`DEV GLB invalid: ${dev}`);
      }
      if (generated && this.session.sourceSha256) await writeDevArtifact('templates', key, artifact, this.session);
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
      const metrics = this.anchor && row.box ? deviceViewMetrics(row.box, camera, rect?.width || 1000, rect?.height || 800, view) : null;
      row.inView = selected || !metrics || metrics.visible;
      // Unknown ranges compile actual supported geometry automatically. No
      // invented box, false culling or tree-selection prerequisite is used.
      const lod = selected ? 2 : !row.group ? 0 : metrics ? chooseDeviceLod(row.displayed, metrics.visible, metrics.distance, metrics.pixels) : 0;
      row.desired = lod;
      const key = this.key(row.entry.devPath, lod); wanted.add(key);
      const priority = selected ? 0 : !row.group && row.inView ? 1 : lod > 0 ? 2 : 4;
      if (!['empty', 'unsupported'].includes(row.entry.templateStatus) && row.key !== key && row.failedKey !== key) void this.render(row, lod, priority).catch(e => this.failed(row, e, key));
    }
    this.worker.cancelQueued(wanted); this.templates.trim(this.pinned());
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
    if (!template) { row.entry.templateStatus = this.nullResults.get(key) ?? 'failed'; this.requestReady(); return; }
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
    if (!this.current() || (error as Error)?.name === 'AbortError') return;
    if (row.desired === null || this.key(row.entry.devPath, row.desired) !== requestKey) return;
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
    let total = 0, visible = 0, finished = 0, shown = 0, empty = 0, unsupported = 0, partial = 0, failed = 0;
    let viewSettled = true, viewReady = true, baseSettled = true, baseReady = true, allReady = true;
    for (const row of this.rows.values()) {
      total++;
      const terminal = row.entry.templateStatus === 'empty' || row.entry.templateStatus === 'unsupported';
      const key = this.key(row.entry.devPath, row.desired!);
      const complete = !!row.group || terminal, requested = terminal || row.key === key, failure = row.failedKey === key;
      if (complete || failure) finished++;
      baseSettled &&= complete || failure; baseReady &&= complete;
      allReady &&= row.entry.templateStatus === 'empty' || row.geometryStatus === 'complete' && row.displayed === 2;
      if (row.inView) { visible++; viewSettled &&= requested || failure; viewReady &&= requested; }
      if (row.group) shown++;
      if (row.entry.templateStatus === 'empty') empty++;
      if (row.entry.templateStatus === 'unsupported') unsupported++;
      if (row.geometryStatus === 'partial') partial++;
      if (row.entry.templateStatus === 'failed') failed++;
    }
    const stable = !this.cameraTimer && this.diagnostics.anchorReady && this.diagnostics.catalogReady;
    const ready = stable && viewReady;
    if (ready && !this.diagnostics.currentViewReady) perfMark('DEV current view ready', { shown, requested: visible, compiled: [...this.diagnostics.compiled], failed }, this.perf);
    Object.assign(this.diagnostics, { currentViewSettled: stable && viewSettled, currentViewReady: ready,
      baseRepresentationsSettled: this.diagnostics.anchorReady && this.diagnostics.catalogReady && baseSettled,
      baseRepresentationsReady: this.diagnostics.anchorReady && this.diagnostics.catalogReady && baseReady,
      allStationReady: this.diagnostics.anchorReady && this.diagnostics.catalogReady && baseReady && allReady,
      readyOccurrences: shown, emptyOccurrences: empty, unsupportedOccurrences: unsupported, partialOccurrences: partial, failedOccurrences: failed,
      shown: this.state.loadedXmlModGroups.size, activeDevices: this.worker?.activePaths ?? [] });
    const active = this.diagnostics.activeDevices.join('、');
    this.diagnostics.inputBudgetBytes=this.inputBudget.bytes;this.diagnostics.inputBudgetPeakBytes=this.inputBudget.peakBytes;
    const pressure=this.worker?.resultPressure;
    this.diagnostics.resultQueuedBytes=pressure?.bytes ?? 0;this.diagnostics.resultPeakBytes=pressure?.peakBytes ?? 0;
    this.diagnostics.resultQueueCount=pressure?.count ?? 0;
    const failures = this.diagnostics.failedOccurrences;
    const phase = this.diagnostics.currentViewSettled
      ? ready ? '当前视图就绪' : '当前视图已完成，部分设备失败'
      : '当前视图准备中';
    const background = this.diagnostics.currentViewSettled && !this.diagnostics.baseRepresentationsSettled ? ' · 后台补充基础表示' : '';
    this.status(`几何实例已处理 ${finished}/${total} · 已显示 ${this.diagnostics.readyOccurrences}${failures ? ` · 失败 ${failures}` : ''} · ${phase}${background}`,
      `设备范围索引 ${this.diagnostics.directoryCompleted}/${total} · 模板编译 ${this.diagnostics.compiled.reduce((a,b) => a+b, 0)} · 缓存 ${this.diagnostics.templateHits} · 淘汰 ${this.diagnostics.templateEvictions} · 部分表示 ${this.diagnostics.partialOccurrences}${active ? ` · ${active}` : ''}`);
  }
  clearSelection(): void { this.selected = ''; this.schedule(); }
  boundsQuality(rootOccurrence: string): DevSourceBounds['boundsQuality'] | undefined { return this.rows.get(rootOccurrence)?.entry.boundsQuality; }
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
    if (this.released) return; this.released = true; this.inputBudget.close(); this.finishCatalog(); this.finishAnchor();
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
    this.templates.clear(); this.rows.clear(); this.catalogByDev.clear(); this.state.deviceUnknownBounds.clear();
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

