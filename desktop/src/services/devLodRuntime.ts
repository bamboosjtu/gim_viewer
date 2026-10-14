import * as THREE from 'three';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { chooseDeviceLod, deviceViewMetrics, type DeviceLod } from '../viewer/devLodPolicy.js';
import { ByteLru } from '../utils/byteLru.js';
import { collectCbmDeviceInstances, parseCbmTransformMatrix, ensureGeometryLayers } from './modAutoLoadService.js';
import { DevGlbTemplate, createLegacyEquivalentPlacementMatrix, validateDevGlbTemplate } from './devGlbTemplateRuntime.js';
import { parseDevGlbAsset, type DevGlbSerializationResult } from './glbCacheService.js';
import { createDevGeometryPreprocessor, type DevGeometryPreprocessor } from './devGeometryWorkerClient.js';
import { invalidGeometryExtent } from '../viewer/geometryBounds.js';
import { DEV_GEOMETRY_VERSION, DEV_SPATIAL_CATALOG_VERSION, boxTuple, tupleBox, type DevSourceBounds, type DevSpatialOccurrence } from './devSpatialCatalog.js';
import { readDevArtifact, writeDevArtifact, deleteDevArtifact } from '@desktop/devLodCache.js';
import { readCachedEntry } from '@desktop/database.js';
import { perfCurrentSession, perfMark } from '../utils/perfTimings.js';
import { diagnosticForFailure, diagnosticFromSerialization, setGeometryDiagnostic } from '../gim/geometry/geometryDiagnostics.js';
import { resetModHighlight, highlightModGroups } from '../viewer/highlight.js';

interface CachedTemplate { result: DevGlbSerializationResult; sha: string }
interface TemplateRow { template: DevGlbTemplate; sha: string; status: DevGlbSerializationResult['status']; diagnostics: DevGlbSerializationResult['diagnostics'] }
interface Occurrence { entry: DevSpatialOccurrence; label: string; inView: boolean; box: THREE.Box3 | null; desired: DeviceLod | null; displayed: DeviceLod; geometryStatus?: DevGlbSerializationResult['status']; group?: THREE.Group; key?: string; failedKey?: string }
const normalize = (path: string) => /^dev\//i.test(path.replace(/\\/g, '/')) ? path.replace(/\\/g, '/') : `DEV/${path}`;
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(v => v.toString(16).padStart(2, '0')).join('');
const belongsTo = (object: THREE.Object3D, root?: THREE.Object3D) => {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (parent === root) return true;
  return false;
};

/** Session owner for catalog, templates and camera-driven occurrence representations. */
export class DevLodRuntime {
  readonly diagnostics = { catalogReady: false, currentViewReady: false, baseRepresentationsReady: false, allStationReady: false, catalogHits: 0,
    templateHits: 0, compiled: [0, 0, 0], occurrences: 0, shown: 0, pending: 0, unknownBounds: 0,
    absoluteConeCount: 0, templateResidentBytes: 0, directoryCompleted: 0, readyOccurrences: 0, failedOccurrences: 0,
    emptyOccurrences: 0, unsupportedOccurrences: 0, partialOccurrences: 0, templateParses: 0, templateEvictions: 0, workerCount: 0, activeDevices: [] as string[],
    anchorReady: false, errors: [] as string[], fingerprints: [] as Record<string, unknown>[] };
  private readonly perf = perfCurrentSession();
  private released = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private selected = '';
  private pending = new Map<string, Promise<TemplateRow | null>>();
  private nullResults = new Map<string, 'empty' | 'unsupported'>();
  private priorities = new Map<string, number>();
  private templateSlots = 0;
  private placementUsers = new Map<string, number>();
  private templateWaiters = new Map<string, { resolve: (release: () => void) => void; reject: (error: Error) => void }>();
  private rows = new Map<string, Occurrence>();
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
  constructor(private state: AppState, private ctx: ViewerContext, private session: ProjectLoadSession, private status: (text: string) => void) {
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
    this.worker.onActivity = () => this.ready();
    (this.ctx.world.camera as any).controls?.addEventListener('update', this.schedule);
    const seeds = collectCbmDeviceInstances(this.state.currentCbmTree);
    const byDev = new Map<string, typeof seeds>();
    for (const seed of seeds) {
      const dev = normalize(seed.devPath), list = byDev.get(dev) ?? []; list.push(seed); byDev.set(dev, list);
      this.rows.set(seed.path, { entry: { devPath: dev, sourceBounds: null, boundsQuality: 'unknown', primitiveCounts: {}, unsupportedTypes: [],
        instanceKey: `dev:${dev}#${seed.path}`, rootOccurrence: seed.path, placementMatrix: parseCbmTransformMatrix(seed.transformMatrix), templateStatus: 'unrequested' },
        label: seed.name || seed.devSymbolName || '设备', inView: true, box: null, desired: 0, displayed: 0 });
    }
    this.diagnostics.occurrences = seeds.length;
    this.notifyCoordinateAnchor(); this.update(); // Compilation can begin before any IFC is ready.
    for (const [dev, instances] of byDev) {
      if (!this.current()) return;
      let bounds = await readDevArtifact<DevSourceBounds>('catalog', this.catalogKey(dev), this.session);
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
      this.ready();
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
  private pinned(): Set<string> { return new Set([...this.rows.values()].filter(r => r.group && r.key).map(r => r.key!).concat([...this.placementUsers.keys()])); }
  private acquireTemplateSlot(key: string): Promise<() => void> {
    return new Promise((resolve, reject) => { this.templateWaiters.set(key, { resolve, reject }); this.drainTemplates(); });
  }
  private drainTemplates(): void {
    while (this.current() && this.templateSlots < this.worker.workerCount * 2 && this.templateWaiters.size) {
      const [key, waiter] = [...this.templateWaiters].sort((a,b) => (this.priorities.get(a[0]) ?? 3) - (this.priorities.get(b[0]) ?? 3))[0];
      this.templateWaiters.delete(key); this.templateSlots++;
      let released = false;
      waiter.resolve(() => { if (released) return; released = true; this.templateSlots--; this.drainTemplates(); });
    }
  }
  private async template(dev: string, lod: DeviceLod, priority: number): Promise<TemplateRow | null> {
    const key = this.key(dev, lod), cached = this.templates.get(key); if (cached) return cached;
    if (this.nullResults.has(key)) return null;
    this.priorities.set(key, Math.min(this.priorities.get(key) ?? priority, priority));
    const old = this.pending.get(key); if (old) { this.worker.promote(key, priority); return old; }
    const promise = (async () => {
      const releaseSlot = await this.acquireTemplateSlot(key);
      try {
      if (!this.current()) return null;
      let artifact = await readDevArtifact<CachedTemplate>('templates', key, this.session), parsed: Awaited<ReturnType<typeof parseDevGlbAsset>> = null;
      let generated = false;
      if (!this.current()) return null;
      if (artifact?.result.bytes) {
        try {
          if (await hash(artifact.result.bytes) !== artifact.sha) throw Error('DEV template SHA mismatch');
          parsed = await parseDevGlbAsset(dev, artifact.result.bytes);
          if (!parsed || !validateDevGlbTemplate(parsed).shareable || invalidGeometryExtent(parsed.scene)) throw Error('Invalid DEV cached template');
          this.diagnostics.templateHits++;
        } catch { if (parsed) new DevGlbTemplate(dev, parsed.scene, this.session).dispose(); parsed = null; await deleteDevArtifact('templates', key, this.session); artifact = null; }
      } else if (artifact?.result.status === 'empty' || artifact?.result.status === 'unsupported') {
        setGeometryDiagnostic(this.state, diagnosticFromSerialization(dev, artifact.result.diagnostics, 'warm')); this.nullResults.set(key, artifact.result.status); return null;
      } else artifact = null;
      if (!artifact) {
        if (![...this.rows.values()].some(row => row.desired !== null && this.key(row.entry.devPath, row.desired) === key)) throw new DOMException('DEV request left the view', 'AbortError');
        generated = true;
        const result = await this.worker.compile(dev, lod, key, this.priorities.get(key) ?? priority);
        if (!this.current()) return null;
        this.diagnostics.compiled[lod]++;
        artifact = { result, sha: result.bytes ? await hash(result.bytes) : '' };
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
      const row = { template: new DevGlbTemplate(dev, parsed.scene, this.session), sha: artifact.sha, status: artifact.result.status, diagnostics: artifact.result.diagnostics };
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
      } finally { releaseSlot(); }
    })();
    this.pending.set(key, promise); this.diagnostics.pending = this.pending.size;
    try { return await promise; } finally { if (this.pending.get(key) === promise) { this.pending.delete(key); this.priorities.delete(key); } this.diagnostics.pending = this.pending.size; this.worker.acknowledge(key); }
  }
  private schedule = () => {
    if (!this.current()) return;
    this.diagnostics.currentViewReady = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.update(); }, 200);
  };
  private update(): void {
    if (!this.current()) { this.release(); return; }
    this.notifyCoordinateAnchor();
    const camera = (this.ctx.world.camera as any).three as THREE.Camera;
    const canvas = (this.ctx.world.renderer as any)?.three?.domElement as HTMLCanvasElement | undefined;
    const rect = canvas?.getBoundingClientRect();
    const wanted = new Set<string>();
    for (const row of this.rows.values()) {
      const selected = row.entry.rootOccurrence === this.selected;
      const metrics = this.anchor && row.box ? deviceViewMetrics(row.box, camera, rect?.width || 1000, rect?.height || 800) : null;
      row.inView = selected || !metrics || metrics.visible;
      // Unknown ranges compile actual supported geometry automatically. No
      // invented box, false culling or tree-selection prerequisite is used.
      const lod = selected ? 2 : metrics ? chooseDeviceLod(row.displayed, metrics.visible, metrics.distance, metrics.pixels) : 0;
      row.desired = lod;
      if (row.group) row.group.visible = lod !== null;
      if (lod === null) {
        if (row.group) { row.group.removeFromParent(); this.state.loadedXmlModGroups.delete(row.entry.instanceKey); row.group = undefined; row.key = undefined; }
        continue;
      }
      const key = this.key(row.entry.devPath, lod); wanted.add(key);
      if (row.key !== key && row.failedKey !== key) void this.render(row, lod, selected ? 0 : lod === 2 ? 1 : lod === 1 ? 2 : 3).catch(e => this.failed(row, e));
    }
    this.worker.cancelQueued(wanted); this.templates.trim(this.pinned());
    for (const [key, waiter] of this.templateWaiters) if (!wanted.has(key)) {
      this.templateWaiters.delete(key); waiter.reject(new DOMException('DEV request left the current view', 'AbortError'));
    }
    this.diagnostics.templateResidentBytes = this.templates.bytes;
    this.ready();
  }
  private async render(row: Occurrence, lod: DeviceLod, priority: number): Promise<void> {
    const key = this.key(row.entry.devPath, lod);
    this.placementUsers.set(key, (this.placementUsers.get(key) ?? 0) + 1);
    try {
    const template = await this.template(row.entry.devPath, lod, priority);
    if (!this.current() || row.desired !== lod || row.key === key) return;
    if (!template) { row.entry.templateStatus = this.nullResults.get(key) ?? 'failed'; this.ready(); return; }
    if (!this.anchor) return; // Local GLB is usable; scene placement still awaits the first IFC frame.
    const started = performance.now();
    const group = template.template.createPlacement({ contract: 'source-template', rootOccurrence: row.entry.rootOccurrence,
      instanceKey: row.entry.instanceKey, placementMatrix: row.entry.placementMatrix, projectSourceToViewerMatrix: this.anchor });
    const invalidPlacement = invalidGeometryExtent(group);
    if (invalidPlacement) { group.clear(); throw Error(`DEV placement rejected: ${row.entry.rootOccurrence}: ${invalidPlacement}`); }
    group.userData.deviceLod = lod;
    group.name = row.entry.instanceKey;
    const highlighted = this.state.highlightedModState?.groups.filter(object => belongsTo(object, row.group)) ?? [];
    const highlightScopes = highlighted.map(object => object === row.group ? null : { devPath: object.userData.devPath, assemblyPath: object.userData.assemblyPath, referencePath: object.userData.referencePath });
    if (highlighted.length) resetModHighlight(this.state);
    this.state.modRootGroup!.add(group); row.group?.removeFromParent();
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
      const local = new THREE.Box3().setFromObject(template.template.scene, true), world = new THREE.Box3().setFromObject(group, true);
      const fingerprint = { sourceSha: this.session.sourceSha256, devPath: row.entry.devPath, instanceKey: row.entry.instanceKey, lod,
        templateSha: template.sha, localBounds: tupleBox(local), placementMatrix: row.entry.placementMatrix,
        firstIfc: this.state.currentIfcEntries[0]?.path, projectMatrix: this.state.projectSourceToViewerMatrix?.toArray(),
        worldBounds: tupleBox(world), center: world.getCenter(new THREE.Vector3()).toArray() };
      this.diagnostics.fingerprints.push(fingerprint);
      if (this.diagnostics.fingerprints.length > 128) this.diagnostics.fingerprints.shift();
      perfMark('DEV placement fingerprint', fingerprint, this.perf);
    }
    this.diagnostics.shown = this.state.loadedXmlModGroups.size;
    perfMark('DEV scene commit', { key, instanceKey: row.entry.instanceKey, durationMs: performance.now() - started }, this.perf);
    this.ready();
    } finally {
      const users = (this.placementUsers.get(key) ?? 1) - 1;
      if (users) this.placementUsers.set(key, users); else this.placementUsers.delete(key);
      this.templates.trim(this.pinned());
    }
  }
  private failed(row: Occurrence, error: unknown): void {
    if (!this.current() || (error as Error)?.name === 'AbortError') return;
    row.entry.templateStatus = 'failed';
    row.failedKey = row.desired === null ? undefined : this.key(row.entry.devPath, row.desired);
    this.diagnostics.errors.push(`${row.entry.devPath}: ${String(error)}`);
    if (this.diagnostics.errors.length > 32) this.diagnostics.errors.shift();
    setGeometryDiagnostic(this.state, diagnosticForFailure(row.entry.devPath, 'parse-failed', 'cold', String(error)));
    this.ready();
  }
  private ready(): void {
    if (!this.current()) return;
    const rows = [...this.rows.values()], visible = rows.filter(r => r.inView);
    const complete = (r: Occurrence) => !!r.group || r.entry.templateStatus === 'empty' || r.entry.templateStatus === 'unsupported';
    const ready = this.diagnostics.anchorReady && this.diagnostics.catalogReady && visible.every(r => r.entry.templateStatus === 'empty' || r.entry.templateStatus === 'unsupported'
      || r.key === this.key(r.entry.devPath, r.desired!));
    if (ready && !this.diagnostics.currentViewReady) perfMark('DEV current view ready', { shown: this.diagnostics.shown,
      requested: visible.length, compiled: [...this.diagnostics.compiled], failed: this.diagnostics.errors.length }, this.perf);
    this.diagnostics.currentViewReady = ready;
    this.diagnostics.baseRepresentationsReady = this.diagnostics.anchorReady && this.diagnostics.catalogReady && rows.every(complete);
    // Base outlines and partial representations are useful browser results,
    // but cannot be reported as an all-station full-geometry completion.
    this.diagnostics.allStationReady = this.diagnostics.baseRepresentationsReady && rows.every(r => r.entry.templateStatus === 'empty'
      || r.geometryStatus === 'complete' && r.displayed === 2);
    this.diagnostics.readyOccurrences = rows.filter(r => !!r.group).length;
    this.diagnostics.emptyOccurrences = rows.filter(r => r.entry.templateStatus === 'empty').length;
    this.diagnostics.unsupportedOccurrences = rows.filter(r => r.entry.templateStatus === 'unsupported').length;
    this.diagnostics.partialOccurrences = rows.filter(r => r.geometryStatus === 'partial').length;
    this.diagnostics.failedOccurrences = rows.filter(r => r.entry.templateStatus === 'failed').length;
    this.diagnostics.shown = this.state.loadedXmlModGroups.size;
    this.diagnostics.activeDevices = this.worker?.activePaths ?? [];
    const active = this.diagnostics.activeDevices.map(path => rows.find(r => path.startsWith(r.entry.devPath))?.label ?? '设备').join('、');
    const finished = this.diagnostics.readyOccurrences + this.diagnostics.emptyOccurrences + this.diagnostics.unsupportedOccurrences;
    this.status(`设备 ${finished}/${rows.length} · 目录 ${this.diagnostics.directoryCompleted}/${rows.length} · 编译 ${this.diagnostics.compiled.reduce((a,b) => a+b, 0)} · 缓存 ${this.diagnostics.templateHits} · 淘汰 ${this.diagnostics.templateEvictions} · 失败 ${this.diagnostics.failedOccurrences}${this.diagnostics.partialOccurrences ? ` · 部分表示 ${this.diagnostics.partialOccurrences}` : ''}${active ? ` · ${active}` : ready ? ' · 当前视图就绪' : ' · 准备中'}`);
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
    if (!this.rows.has(rootOccurrence)) await this.catalogDone;
    const row = this.rows.get(rootOccurrence);
    if (!row || !this.current() || this.selected !== rootOccurrence) return [];
    row.desired = 2;
    await this.render(row, 2, 0);
    if (!this.anchor) {
      await this.anchorDone;
      if (!this.current() || this.selected !== rootOccurrence) return [];
      await this.render(row, 2, 0);
    }
    return this.current() && row.group ? [row.group] : [];
  }
  release(): void {
    if (this.released) return; this.released = true; this.finishCatalog(); this.finishAnchor();
    for (const waiter of this.templateWaiters.values()) waiter.reject(new DOMException('DEV session expired', 'AbortError'));
    this.templateWaiters.clear();
    if (this.timer) clearTimeout(this.timer);
    (this.ctx.world.camera as any).controls?.removeEventListener('update', this.schedule);
    this.worker?.cancel();
    for (const row of this.rows.values()) { if (row.group && this.state.highlightedModState?.groups.some(object => belongsTo(object, row.group))) resetModHighlight(this.state); row.group?.removeFromParent(); this.state.loadedXmlModGroups.delete(row.entry.instanceKey); }
    this.templates.clear(); this.rows.clear(); this.catalogByDev.clear(); this.state.deviceUnknownBounds.clear();
  }
}
export async function startDeviceLod(state: AppState, ctx: ViewerContext, session: ProjectLoadSession, status: (text: string) => void): Promise<DevLodRuntime> {
  if (state.deviceLodRuntime instanceof DevLodRuntime && state.deviceLodRuntime.belongsTo(session)) {
    state.deviceLodRuntime.notifyCoordinateAnchor(); await state.deviceLodRuntime.startup; return state.deviceLodRuntime;
  }
  state.deviceLodRuntime?.release();
  const runtime = new DevLodRuntime(state, ctx, session, status); state.deviceLodRuntime = runtime;
  try { runtime.startup = runtime.start(); await runtime.startup; return runtime; }
  catch (error) { runtime.release(); if (state.deviceLodRuntime === runtime) state.deviceLodRuntime = null; throw error; }
}

