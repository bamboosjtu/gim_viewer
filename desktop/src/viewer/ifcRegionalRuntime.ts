import { logger } from '../utils/logger.js';
import type { IfcVisibilityModel } from './ifcModelVisibility.js';
interface RegionalProperties {
  attributes: Record<string, unknown>;
  propertySets: readonly unknown[];
  typeProperties?: readonly unknown[];
  materials?: readonly unknown[];
}
interface WorkerReplies {
  open: unknown;
  'patrol-catalog': import('./patrol/ifcNavigationSource.js').IfcNavigationCatalog;
  'patrol-mesh': ObjectFineResult;
  'prepare-region': { small: number[]; retained: number; unknown: number };
  region: ObjectFineResult[];
  properties: RegionalProperties;
}
type RegionalMessage =
  | { stage: string; elapsedMs?: number; records?: number; reason?: string }
  | { id: number; error?: string; data?: unknown };
import { setRenderVisibility, requestObjectRender } from './demandRendering.js';
import measuredWorkerAsset from './ifcRegionalWorker.ts?worker&url';
import { createMeasuredWorker, measurementWorkerUrl } from '../measurement/hostWorker.js';
import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { beginIfcGeometryWork } from './geometryWorkGate.js';
import { cameraPoseHub } from './cameraPoseHub.js';
import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { RegionalIndex, RegionalObject } from './ifcRegionalData.js';
import { queryRegionalObjects } from './ifcRegionalData.js';
import { objectFineGroup } from './ifcObjectGeometry.js';
import type { GeometrySourceAddress } from '@gim/gim-sdk/geometry';
import type { ObjectFineResult } from './ifcObjectFineData.js';
import {
  readIfcLodArtifact,
  readIfcLodArtifacts,
  writeIfcLodArtifacts,
  writeIfcLodArtifact,
} from '@desktop/ifcLodCache.js';
import { isIfcNearDetailEnabled, IFC_NEAR_TEMPLATE_CACHE_VERSION } from '../config/features.js';
import { IfcRegionalInstances } from './ifcRegionalInstances.js';
import { IfcObjectFineRuntime } from './ifcObjectFineRuntime.js';
import type { IfcObjectIdentity } from './ifcObjectIdentity.js';
import type { SubstationFineQueue } from '../shared/selectionContracts.js';
import { perfMarkProductMoment } from '../utils/perfTimings.js';
import type { MemoryPressure } from '../utils/memoryPressure.js';
import type { IfcModelVisibility } from './ifcModelVisibility.js';

// A source model can consume hundreds of MB. Serialize regional source work
// across IFCs. Keep one source resident for nearby requests, with idle eviction.
let residentSource: IfcRegionalRuntime | null = null;
let regionalQueue = Promise.resolve();
async function acquireRegionalSource(): Promise<() => void> {
  const previous = regionalQueue;
  let release!: () => void;
  regionalQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

export class IfcRegionalRuntime {
  readonly root = new THREE.Group();
  private instances = new IfcRegionalInstances();
  readonly diagnostics = {
    requested: 0,
    rendered: 0,
    cacheHits: 0,
    computed: 0,
    failed: 0,
    pending: 0,
    skippedSmallOpenings: 0,
    retainedOpenings: 0,
    unknownOpenings: 0,
    sourceReads: 0,
    sourceBytes: 0,
    sourceChecks: 0,
    sourceOpenCount: 0,
    sourceOpenWallMs: 0,
    subsetBuilds: 0,
    subsetBuildWallMs: 0,
    subsetIndexWallMs: 0,
    subsetRecords: 0,
    subsetFallbacks: 0,
    subsetFallbackReason: '',
    stage: 'idle',
    error: '',
    regionMs: 0,
    memoryPressure: 'unknown' as MemoryPressure,
    memoryReclaims: 0,
  };
  private worker: Worker | null = null;
  private fineRuntime: IfcObjectFineRuntime | null = null;
  private opening: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private static useSource(source: IfcRegionalRuntime) {
    if (residentSource === source) return;
    residentSource?.closeSource();
    residentSource = source;
  }
  private retainSource() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.current() && this.worker)
      this.idleTimer = setTimeout(() => {
        if (!this.pending.size) this.closeSource();
      }, 30_000);
  }
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (data: unknown) => void; reject: (e: Error) => void }
  >();
  private groups = new Map<number, THREE.Group>();
  /** Explicit L2 objects remain visible until the user returns to browsing. */
  private fineOwners = new Map<number, Set<'selection' | symbol>>();
  private patrolMeshRequests = new Map<number, AbortController>();
  /** Deduplicate concurrent clicks on the same IFC object. */
  private finePending = new Map<number, Promise<THREE.Group | undefined>>();
  private fineQueueCancels = new Map<number, () => boolean>();
  private fineGeneration = new Map<number, number>();
  private browseAllowed: ReadonlySet<number> | null = null;
  private browseHidden: ReadonlySet<number> = new Set();
  setBrowseMask(allowed: ReadonlySet<number> | null, hidden: ReadonlySet<number>) {
    this.browseAllowed = allowed;
    this.browseHidden = hidden;
    this.applyOnlySelected();
  }
  private permits(id: number) {
    return (
      !this.browseHidden.has(id) &&
      (!this.browseAllowed || this.browseAllowed.has(id)) &&
      (!this.onlySelected || this.isIsolatedMember(id))
    );
  }
  private onlySelected = false;
  private selectedExpressId: number | null = null;
  private isolationIds: ReadonlySet<number> | null = null;
  private localIds = new Map<number, number>();
  private guidIds: Promise<Map<string, number[]>> | null = null;
  private epoch = 0;
  private released = false;
  private sourceGeneration = 0;
  private memoryPressure: MemoryPressure = 'unknown';
  private busy = false;
  private pendingView = false;
  private unsubscribeCamera: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval>;
  private transform: THREE.Matrix4;
  private disposed = ({ value }: { value: { modelId: string } }) => {
    if (value.modelId === this.options.model.modelId) this.release();
  };
  constructor(
    readonly modelId: string,
    readonly sourcePath: string,
    readonly index: RegionalIndex,
    private options: {
      ctx: ViewerContext;
      model: Pick<
        IfcVisibilityModel,
        'modelId' | 'object' | 'setVisible' | 'getGuidsByLocalIds' | 'getItemsIdsWithGeometry'
      >;
      readBytes: () => Promise<Uint8Array | null>;
      cacheKey: string;
      isCurrent: () => boolean;
      sourceToViewer: THREE.Matrix4;
      fineQueue?: SubstationFineQueue | null;
      visibility?: IfcModelVisibility;
      onBeforeDisposeGroup?: (group: THREE.Group) => void;
      onRepresentationChanged?: (
        object: RegionalObject,
        group: THREE.Group | undefined,
        localId: number | undefined,
        isCurrent: () => boolean,
        prepareHighlight: () => void,
      ) => Promise<void>;
    },
  ) {
    const base = options.ctx.fragments.baseCoordinationMatrix?.clone() ?? new THREE.Matrix4();
    this.transform = options.sourceToViewer ?? base;
    this.root.name = 'IFC regional detail';
    this.root.add(this.instances.root);
    options.ctx.world.scene.three.add(this.root);
    this.unsubscribeCamera = cameraPoseHub(options.ctx).subscribe(this.scheduleView);
    window.addEventListener('gim-ifc-detail-mode', this.schedule);
    options.ctx.fragments.list.onBeforeDelete.add(this.disposed);
    this.interval = setInterval(() => {
      const visible = this.root.visible;
      this.refreshVisibility();
      if (visible !== this.root.visible) this.schedule();
      if (!options.isCurrent()) this.release();
    }, 1000);
    this.schedule();
  }
  private current = () => !this.released && this.options.isCurrent();
  private send<K extends keyof WorkerReplies>(
    message: { type: K } & Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<WorkerReplies[K]> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.worker) {
        reject(Error('Regional worker unavailable'));
        return;
      }
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    }).then((value) => value as WorkerReplies[K]);
  }
  private async open() {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const generation = this.sourceGeneration;
      const bytes = await this.options.readBytes();
      if (!this.current() || generation !== this.sourceGeneration || !bytes?.byteLength)
        throw Error('Regional source unavailable');
      this.diagnostics.sourceReads++;
      this.diagnostics.sourceBytes += bytes.byteLength;
      this.worker = createMeasuredWorker(
        'ifc-regional',
        (identity) =>
          new Worker(measurementWorkerUrl(measuredWorkerAsset, identity), {
            type: 'module',
            ...(identity ? { name: identity } : {}),
          }),
        this.sourcePath,
      );
      this.worker.onmessage = ({ data }: MessageEvent<RegionalMessage>) => {
        if ('stage' in data) {
          this.diagnostics.stage = data.stage;
          if (data.stage === 'source-check') this.diagnostics.sourceChecks++;
          if (data.stage === 'source-open' || data.stage === 'source-reopen')
            this.diagnostics.sourceOpenCount++;
          if (data.stage === 'source-open-complete')
            this.diagnostics.sourceOpenWallMs += Number(data.elapsedMs) || 0;
          if (data.stage === 'subset-index')
            this.diagnostics.subsetIndexWallMs += Number(data.elapsedMs) || 0;
          if (data.stage === 'subset-built') {
            this.diagnostics.subsetBuilds++;
            this.diagnostics.subsetBuildWallMs += Number(data.elapsedMs) || 0;
            this.diagnostics.subsetRecords = Number(data.records) || 0;
          }
          if (data.stage === 'subset-fallback') {
            this.diagnostics.subsetFallbacks++;
            this.diagnostics.subsetFallbackReason = String(data.reason);
          }
          return;
        }
        const p = this.pending.get(data.id);
        if (!p) return;
        this.pending.delete(data.id);
        if (data.error) p.reject(Error(data.error));
        else p.resolve(data.data);
      };
      this.worker.onerror = (e) => {
        const error = Error(e.message || `Regional worker failed at ${e.filename}:${e.lineno}`);
        this.diagnostics.error = error.message;
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
        this.opening = null;
      };
      const owned =
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
          ? bytes
          : new Uint8Array(bytes);
      await this.send(
        {
          type: 'open',
          bytes: owned,
          index: this.index,
          wasm: { ...this.options.ctx.ifcLoader.settings.wasm },
        },
        [owned.buffer],
      );
    })().catch((error) => {
      this.opening = null;
      throw error;
    });
    return this.opening;
  }
  private schedule = () => {
    if (!this.current()) return;
    this.epoch++;
    this.scheduleView();
  };
  private scheduleView = () => {
    if (!this.current() || cameraPoseHub(this.options.ctx).current.source === 'patrol') return;
    if (this.busy) {
      this.pendingView = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.update().catch((error) => logger.warn('[IFC regional]', error));
    }, 250);
  };
  private setFarVisible(ids: number[], visible: boolean): Promise<void> {
    return this.options.visibility
      ? this.options.visibility.setDetailVisible(ids, visible)
      : this.options.model.setVisible(ids, visible);
  }
  async patrolSource<K extends 'patrol-catalog' | 'patrol-mesh'>(
    type: K,
    signal: AbortSignal,
    object?: { expressId: number; globalId: string },
  ): Promise<WorkerReplies[K]> {
    const unlock = await acquireRegionalSource();
    try {
      signal.throwIfAborted();
      if (!this.current()) throw Error('旧 IFC 工程');
      const release = await beginIfcGeometryWork();
      try {
        signal.throwIfAborted();
        if (!this.current()) throw Error('旧 IFC 工程');
        IfcRegionalRuntime.useSource(this);
        if (this.idleTimer) clearTimeout(this.idleTimer);
        await this.open();
        signal.throwIfAborted();
        const request = object
          ? { type, expressId: object.expressId, globalId: object.globalId }
          : { type };
        const cancel = () => this.closeSource();
        signal.addEventListener('abort', cancel, { once: true });
        try {
          return await this.send<K>(request);
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      } finally {
        this.retainSource();
        release();
      }
    } finally {
      unlock();
    }
  }
  private async farIds() {
    if (!this.guidIds)
      this.guidIds = (async () => {
        const model = this.options.model,
          ids = await model.getItemsIdsWithGeometry(),
          map = new Map<string, number[]>();
        for (let start = 0; start < ids.length; start += 2048) {
          const batch = ids.slice(start, start + 2048),
            guids = await model.getGuidsByLocalIds(batch);
          for (let i = 0; i < batch.length; i++) {
            const guid = guids[i];
            if (guid) {
              if (!map.has(guid)) map.set(guid, []);
              map.get(guid)!.push(batch[i]);
            }
          }
        }
        return map;
      })();
    return this.guidIds;
  }
  private disposeGroup(group: THREE.Group) {
    this.options.onBeforeDisposeGroup?.(group);
    if (this.groups.get(Number(group.userData.expressId)) === group)
      this.instances.remove(Number(group.userData.expressId));
    group.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.userData.owned === false) return;
      if (mesh.geometry) geometries.add(mesh.geometry);
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    for (const geometry of geometries) geometry.dispose();
  }
  private async representationChanged(
    object: RegionalObject,
    group: THREE.Group | undefined,
    localId: number | undefined,
  ): Promise<void> {
    const current = () => this.current() && this.groups.get(object.expressId) === group;
    if (current())
      await this.options.onRepresentationChanged?.(object, group, localId, current, () => {
        if (group?.userData.lod === 1) this.instances.highlight(object.expressId, group, true);
      });
  }
  private closeSource() {
    this.sourceGeneration++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (residentSource === this) residentSource = null;
    for (const task of this.pending.values()) task.reject(Error('Regional source released'));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.opening = null;
  }
  private async update() {
    if (this.busy || !this.current() || cameraPoseHub(this.options.ctx).current.source === 'patrol')
      return;
    this.busy = true;
    const epoch = this.epoch,
      started = performance.now(),
      before = this.groups.size;
    const unlock = await acquireRegionalSource();
    const releaseGeometry = await beginIfcGeometryWork();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    IfcRegionalRuntime.useSource(this);
    try {
      if (
        !this.current() ||
        epoch !== this.epoch ||
        cameraPoseHub(this.options.ctx).current.source === 'patrol'
      )
        return;
      // sourceToViewer was resolved from the first model's public coordinates.
      // Its frame is immutable for this session; the manager's initially cached
      // identity must never replace it while its own query is still pending.
      const candidates =
        isIfcNearDetailEnabled() && this.root.visible
          ? queryRegionalObjects(
              this.index.objects,
              this.transform,
              this.options.ctx.world.camera.three,
            )
          : [];
      const scopedCandidates = this.onlySelected
        ? candidates.filter((object) => this.isIsolatedMember(object.expressId))
        : candidates;
      const pressured = this.memoryPressure === 'high' || this.memoryPressure === 'critical';
      // Preserve visible existing L1 and the selected object. Under pressure
      // no new automatic region is admitted; far geometry stays available.
      const objects = pressured
        ? scopedCandidates.filter((object) => this.groups.has(object.expressId))
        : scopedCandidates;
      // L1 follows the camera, while an explicitly refined object is retained
      // until the user releases it.  Ordinary selection never enters this set.
      const desired = new Set([...objects.map((o) => o.expressId), ...this.fineOwners.keys()]);
      if (this.selectedExpressId !== null) desired.add(this.selectedExpressId);
      this.diagnostics.requested = objects.length;
      const restore: number[] = [];
      for (const [id, group] of this.groups)
        if (!desired.has(id)) {
          this.disposeGroup(group);
          this.groups.delete(id);
          const local = this.localIds.get(id);
          if (local !== undefined) restore.push(local);
          this.localIds.delete(id);
        }
      if (restore.length) await this.setFarVisible(restore, true);
      if (this.groups.size !== before) this.instances.rebuild(this.transform);
      if (!this.current() || epoch !== this.epoch) return;
      if (!objects.length) {
        this.diagnostics.rendered = this.groups.size;
        this.diagnostics.pending = 0;
        return;
      }
      const ids = await this.farIds();
      if (objects.some((o) => !this.groups.has(o.expressId)))
        cameraPoseHub(this.options.ctx).admitted('ifc');
      let prepared = false;
      for (let start = 0; start < objects.length; start += 32) {
        if (!this.current() || epoch !== this.epoch) return;
        const batch = objects.slice(start, start + 32).filter((o) => !this.groups.has(o.expressId));
        if (!batch.length) continue;
        this.diagnostics.pending = objects.length - start;
        const results = new Map<number, ObjectFineResult>(),
          missing: RegionalObject[] = [];
        const cachedBatch = await readIfcLodArtifacts<ObjectFineResult>(
          batch.map(
            (object) =>
              `${this.options.cacheKey}|${IFC_NEAR_TEMPLATE_CACHE_VERSION}|${object.expressId}`,
          ),
        );
        for (let i = 0; i < batch.length; i++) {
          const object = batch[i],
            cached = cachedBatch[i];
          if (cached?.globalId === object.globalId && Array.isArray(cached.parts)) {
            results.set(object.expressId, cached);
            this.diagnostics.cacheHits++;
          } else missing.push(object);
        }
        if (missing.length) {
          await this.open();
          if (!this.current() || epoch !== this.epoch) return;
          if (!prepared) {
            const policy = await this.send({
              type: 'prepare-region',
              objects: objects.map((o) => o.expressId),
            });
            prepared = true;
            this.diagnostics.skippedSmallOpenings += policy.small.length;
            this.diagnostics.retainedOpenings += policy.retained;
            this.diagnostics.unknownOpenings += policy.unknown;
          }
          if (!this.current() || epoch !== this.epoch) return;
          const computed: ObjectFineResult[] = await this.send({
            type: 'region',
            objects: missing.map((o) => ({
              expressId: o.expressId,
              globalId: o.globalId,
            })),
          });
          for (const result of computed) {
            results.set(result.expressId, result);
            this.diagnostics.computed++;
          }
          if (this.current())
            void Promise.resolve(
              writeIfcLodArtifacts(
                computed.map((result) => ({
                  key: `${this.options.cacheKey}|${IFC_NEAR_TEMPLATE_CACHE_VERSION}|${result.expressId}`,
                  value: result,
                })),
              ),
            ).catch(reportBackgroundError);
        }
        if (!this.current() || epoch !== this.epoch) return;
        for (const object of batch) {
          if (!this.current() || epoch !== this.epoch) return;
          if (this.groups.has(object.expressId)) continue;
          const result = results.get(object.expressId);
          if (!result?.parts.length) {
            this.diagnostics.failed++;
            continue;
          }
          const candidates = ids.get(object.globalId) ?? [];
          if (candidates.length > 1) {
            this.diagnostics.failed++;
            continue;
          }
          const metadata = {
            ...object,
            key: `ifc:${this.modelId.toLowerCase()}:object:${object.expressId}`,
            modelId: this.modelId,
            sourcePath: this.sourcePath,
            provider: 'ifc-regional',
          };
          const instanced = this.instances.accepts(result);
          const group = instanced
            ? new THREE.Group()
            : objectFineGroup(
                result,
                metadata,
                this.transform,
                this.index.sourceSha256 ?? this.options.cacheKey,
                1,
              );
          if (!instanced && !group.children.length) {
            this.diagnostics.failed++;
            continue;
          }
          if (instanced) {
            group.userData = { ...metadata };
            group.matrixAutoUpdate = false;
            group.matrix.copy(this.transform);
            this.instances.add(result);
          }
          group.userData.lod = 1;
          group.userData.approximate = true;
          this.root.add(group);
          this.groups.set(object.expressId, group);
          setRenderVisibility(group, this.permits(object.expressId));
          if (candidates.length === 1) {
            await this.setFarVisible(candidates, false);
            if (this.released) {
              await this.setFarVisible(candidates, true);
              return;
            }
            this.localIds.set(object.expressId, candidates[0]);
          }
          await this.representationChanged(
            object,
            group,
            candidates.length === 1 ? candidates[0] : undefined,
          );
        }
        this.diagnostics.rendered = this.groups.size;
        this.instances.rebuild(this.transform);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      this.diagnostics.pending = 0;
      if (this.groups.size !== before) this.diagnostics.regionMs = performance.now() - started;
    } catch (error) {
      if (this.current()) {
        this.diagnostics.failed++;
        this.diagnostics.error = String(error);
        this.diagnostics.pending = 0;
      }
      this.closeSource();
      throw error;
    } finally {
      this.retainSource();
      unlock();
      releaseGeometry();
      this.busy = false;
      if (this.current() && (this.pendingView || epoch !== this.epoch)) {
        this.pendingView = false;
        this.scheduleView();
      }
    }
  }
  pick(
    ray: THREE.Raycaster,
    accepts?: (point: THREE.Vector3) => boolean,
  ): {
    object: RegionalObject;
    distance: number;
    point: THREE.Vector3;
    lod: number;
    address?: GeometrySourceAddress;
  } | null {
    if (!this.root.visible) return null;
    this.root.updateMatrixWorld(true);
    const hit = ray.intersectObjects(this.root.children, true).find((hit) => {
      if (accepts && !accepts(hit.point)) return false;
      if (!this.instances.identity(hit) && !hit.object.userData.expressId) return false;
      for (let object: THREE.Object3D | null = hit.object; object; object = object.parent)
        if (!object.visible) return false;
      return true;
    });
    if (!hit) return null;
    const id = this.instances.identity(hit) ?? Number(hit.object.userData.expressId);
    const object = this.index.objects.find((o) => o.expressId === id);
    return object
      ? {
          object,
          distance: hit.distance,
          point: hit.point,
          address: hit.object.userData.geometrySourceAddress as GeometrySourceAddress | undefined,
          lod: Number(this.groups.get(object.expressId)?.userData.lod ?? 1),
        }
      : null;
  }
  hoverGroup(expressId: number): THREE.Group | undefined {
    return this.groups.get(expressId);
  }
  highlightGroup(expressId: number, append = false) {
    this.selectedExpressId = expressId;
    const group = this.groups.get(expressId);
    if (group) this.instances.highlight(expressId, group, append);
    this.applyOnlySelected();
    return group;
  }
  /** Exact source product bounds are available even before its near mesh.
   * A far Fragments item may batch several products and cannot frame a leaf. */
  worldBounds(object: RegionalObject): THREE.Box3 | undefined {
    const b = object.bounds;
    if (!b || b.length !== 6 || !b.every(Number.isFinite)) return;
    return new THREE.Box3(
      new THREE.Vector3(b[0], b[1], b[2]),
      new THREE.Vector3(b[3], b[4], b[5]),
    ).applyMatrix4(this.transform);
  }
  clearHighlight() {
    this.instances.clearHighlight();
  }
  clearSelectionFilter(): void {
    this.selectedExpressId = null;
    this.applyOnlySelected();
  }
  private applyOnlySelected(): void {
    this.refreshVisibility();
    for (const [expressId, group] of this.groups) {
      setRenderVisibility(group, this.permits(expressId));
    }
    if (this.browseAllowed || this.browseHidden.size) {
      this.instances.setFilter(
        new Set(
          this.index.objects.filter((o) => this.permits(o.expressId)).map((o) => o.expressId),
        ),
        this.transform,
      );
    } else
      this.instances.setFilter(
        this.onlySelected
          ? (this.isolationIds ??
              new Set(this.selectedExpressId === null ? [] : [this.selectedExpressId]))
          : null,
        this.transform,
      );
  }
  private isIsolatedMember(expressId: number): boolean {
    return this.isolationIds
      ? this.isolationIds.has(expressId)
      : expressId === this.selectedExpressId;
  }
  refreshVisibility(): void {
    const layer = this.options.visibility?.layerVisible ?? this.options.model.object.visible;
    setRenderVisibility(
      this.root,
      layer &&
        (!this.onlySelected ||
          (this.isolationIds ? this.isolationIds.size > 0 : this.selectedExpressId !== null)),
    );
  }
  setSelectionScope(only: boolean, ids: ReadonlySet<number>): void {
    const changed =
      this.onlySelected !== only ||
      this.isolationIds === null ||
      ids.size !== this.isolationIds.size ||
      [...ids].some((id) => !this.isolationIds!.has(id));
    this.onlySelected = only;
    this.isolationIds = new Set(ids);
    this.applyOnlySelected();
    if (changed) this.schedule();
  }
  setOnlySelected(only: boolean): void {
    this.onlySelected = only;
    this.applyOnlySelected();
  }
  setMemoryPressure(pressure: MemoryPressure): void {
    if (!this.current()) return;
    const changed = this.memoryPressure !== pressure;
    this.memoryPressure = pressure;
    this.diagnostics.memoryPressure = pressure;
    if (pressure === 'critical') {
      // Idle WASM can be discarded without touching any shared in-flight
      // property request or the source needed by an active region task.
      if (!this.busy && !this.pending.size && this.worker) {
        this.closeSource();
        this.diagnostics.memoryReclaims++;
      }
      if (!this.finePending.size && this.fineRuntime?.hasModel()) {
        this.fineRuntime.cancel();
        this.diagnostics.memoryReclaims++;
      }
    }
    if (changed) this.schedule();
  }
  /** Explicit user request for precise IFC object geometry. */
  async refine(object: RegionalObject): Promise<THREE.Group | undefined> {
    return this.acquireFine(object, 'selection');
  }

  private async acquireFine(
    object: RegionalObject,
    owner: 'selection' | symbol,
  ): Promise<THREE.Group | undefined> {
    const id = object.expressId;
    const existing = this.finePending.get(id);
    const ready = this.groups.get(id);
    if (!existing && ready?.userData.lod !== 2 && this.memoryPressure === 'critical')
      throw Error('当前内存压力过高，暂不能加载更多精细模型');
    const owners = this.fineOwners.get(id) ?? new Set<'selection' | symbol>();
    this.fineOwners.set(id, owners);
    owners.add(owner);
    if (existing) return existing;
    if (ready?.userData.lod === 2) return ready;
    let result: THREE.Group | undefined;
    const generation = (this.fineGeneration.get(object.expressId) ?? 0) + 1;
    this.fineGeneration.set(object.expressId, generation);
    const meshRequest = owner === 'selection' ? undefined : new AbortController();
    if (meshRequest) this.patrolMeshRequests.set(id, meshRequest);
    const run = async (): Promise<void> => {
      const mesh = meshRequest
        ? await this.patrolSource('patrol-mesh', meshRequest.signal, object)
        : undefined;
      result = await this.refineObject(object, generation, mesh);
    };
    const queued =
      !meshRequest &&
      this.options.fineQueue?.enqueueUserIfcFine(
        `ifc:${this.modelId.toLowerCase()}:${object.expressId}`,
        run,
      );
    const pending = queued ? queued.promise.then(() => result) : run().then(() => result);
    if (queued) this.fineQueueCancels.set(object.expressId, queued.cancel);
    this.finePending.set(object.expressId, pending);
    try {
      return await pending;
    } catch (error) {
      // A failed/cancelled precision request must remain an explicit failure;
      // it must not turn the camera-driven L1 scheduler into an implicit L2
      // retry loop.  The inspector can issue a fresh request.
      if (this.fineGeneration.get(object.expressId) === generation)
        this.releaseRepresentation(object.expressId);
      throw error;
    } finally {
      if (meshRequest && this.patrolMeshRequests.get(id) === meshRequest)
        this.patrolMeshRequests.delete(id);
      if (this.finePending.get(object.expressId) === pending) {
        this.finePending.delete(object.expressId);
        this.fineQueueCancels.delete(object.expressId);
      }
    }
  }
  private async refineObject(
    object: RegionalObject,
    generation: number,
    patrolResult?: ObjectFineResult,
  ): Promise<THREE.Group | undefined> {
    const wanted = () =>
      this.current() &&
      this.fineOwners.has(object.expressId) &&
      this.fineGeneration.get(object.expressId) === generation;
    if (!wanted()) return undefined;
    const existing = this.groups.get(object.expressId);
    if (existing?.userData.lod === 2) return existing;
    if (this.memoryPressure === 'critical') throw Error('当前内存压力过高，暂不能加载更多精细模型');
    if (!patrolResult && !this.fineRuntime) {
      this.fineRuntime = new IfcObjectFineRuntime({
        sourcePath: this.sourcePath,
        wasm: { ...this.options.ctx.ifcLoader.settings.wasm },
        readBytes: this.options.readBytes,
        webIfcSettings: undefined,
        onTiming: (data) => {
          if (data.stage === 'object')
            this.diagnostics.regionMs = Number(data.geometryMs) || this.diagnostics.regionMs;
        },
      });
    }
    const identity: IfcObjectIdentity = {
      key: `ifc:${this.modelId.toLowerCase()}:object:${object.expressId}`,
      modelId: this.modelId,
      sourcePath: this.sourcePath,
      expressId: object.expressId,
      globalId: object.globalId,
      ifcType: object.ifcType,
      name: object.name,
      provider: 'ifc-object-fine',
    };
    const result = patrolResult ?? (await this.fineRuntime!.load(identity));
    // Selection may have moved while the isolated IFC worker was evaluating.
    // Do not let a late result resurrect L2 after the user returned to the
    // browser representation.
    if (!wanted()) return undefined;
    const candidates = (await this.farIds()).get(object.globalId) ?? [];
    if (!wanted()) return undefined;
    const group = objectFineGroup(
      result,
      identity,
      this.transform,
      this.index.sourceSha256 ?? this.options.cacheKey,
      2,
    );
    if (!group.children.length) return undefined;
    group.userData.lod = 2;
    group.userData.approximate = false;
    setRenderVisibility(group, this.permits(object.expressId));
    // Keep the old highlighted representation until every asynchronous commit
    // prerequisite succeeds. An obsolete request must not delete a newer group.
    try {
      if (candidates.length === 1) await this.setFarVisible(candidates, false);
    } catch (error) {
      this.disposeGroup(group);
      if (candidates.length === 1)
        await this.setFarVisible(candidates, !this.groups.has(object.expressId)).catch(
          () => undefined,
        );
      throw error;
    }
    if (!wanted()) {
      this.disposeGroup(group);
      if (candidates.length === 1)
        await this.setFarVisible(candidates, !this.groups.has(object.expressId)).catch(
          () => undefined,
        );
      return undefined;
    }
    const old = this.groups.get(object.expressId);
    if (old) this.disposeGroup(old);
    this.root.add(group);
    this.groups.set(object.expressId, group);
    if (candidates.length === 1) this.localIds.set(object.expressId, candidates[0]);
    this.diagnostics.rendered = this.groups.size;
    this.instances.rebuild(this.transform);
    await this.representationChanged(
      object,
      group,
      candidates.length === 1 ? candidates[0] : undefined,
    );
    if (!wanted()) return undefined;
    perfMarkProductMoment('selectedFineReady', {
      kind: 'ifc',
      modelId: this.modelId,
      expressId: object.expressId,
      globalId: object.globalId,
      lod: 2,
    });
    return group;
  }
  /** An articulated source leaf owns an exact, unbatched representation while open. */
  async movePatrolLeaf(
    id: number,
    motion: THREE.Matrix4,
    frame: THREE.Matrix4,
    signal: AbortSignal,
  ): Promise<() => void> {
    const object = this.index.objects.find((o) => o.expressId === id);
    if (!object || !this.permits(id) || !this.root.visible) throw Error('门扇表示不可用');
    signal.throwIfAborted();
    const owner = Symbol('patrol-door');
    const release = () => this.releaseOwner(id, owner);
    signal.addEventListener('abort', release, { once: true });
    try {
      const group = await this.acquireFine(object, owner);
      signal.throwIfAborted();
      if (
        !group ||
        !this.current() ||
        this.groups.get(id) !== group ||
        !this.permits(id) ||
        !this.root.visible
      )
        throw Error('门扇表示已变更');
      const original = group.matrix.clone();
      group.matrix.premultiply(frame.clone().multiply(motion).multiply(frame.clone().invert()));
      group.updateMatrixWorld(true);
      requestObjectRender(group);
      return () => {
        if (!this.fineOwners.get(id)?.has(owner)) return;
        group.matrix.copy(original);
        group.updateMatrixWorld(true);
        requestObjectRender(group);
        release();
      };
    } catch (error) {
      release();
      throw error;
    } finally {
      signal.removeEventListener('abort', release);
    }
  }
  releaseFine(expressId: number): void {
    this.releaseOwner(expressId, 'selection');
  }
  private releaseOwner(expressId: number, owner: 'selection' | symbol) {
    const owners = this.fineOwners.get(expressId);
    if (owners?.delete(owner) && !owners.size) this.releaseRepresentation(expressId);
  }
  private releaseRepresentation(expressId: number) {
    this.patrolMeshRequests.get(expressId)?.abort();
    this.patrolMeshRequests.delete(expressId);
    this.fineGeneration.set(expressId, (this.fineGeneration.get(expressId) ?? 0) + 1);
    this.finePending.delete(expressId);
    this.fineOwners.delete(expressId);
    this.fineQueueCancels.get(expressId)?.();
    this.fineQueueCancels.delete(expressId);
    const group = this.groups.get(expressId);
    if (group?.userData.lod === 2) {
      this.disposeGroup(group);
      this.groups.delete(expressId);
    }
    const local = this.localIds.get(expressId);
    if (local !== undefined && !this.groups.has(expressId)) {
      this.localIds.delete(expressId);
      void this.setFarVisible([local], true)
        .then(async () => {
          const object = this.index.objects.find((value) => value.expressId === expressId);
          if (object) await this.representationChanged(object, undefined, local);
        })
        .catch(() => undefined);
    }
    this.fineRuntime?.forget(expressId);
    if (!this.fineOwners.size) this.fineRuntime?.cancel();
    // A cancelled selection must not leave a late exact result able to replace
    // the restored browser representation. The worker request itself remains
    // session-scoped and is rejected by release/selection guards when needed.
    this.schedule();
  }
  /** Release all precise objects when the application selection moves away.
   * The browser keeps the cheap regional representation and never treats an
   * old selection as a permanent L2 residency request. */
  clearFineSelection(): void {
    for (const id of this.fineOwners.keys()) this.releaseFine(id);
  }
  async properties(expressId: number) {
    const key = `${this.options.cacheKey}|properties|${expressId}`;
    const cached = await readIfcLodArtifact<RegionalProperties>(key);
    if (cached?.attributes) return cached;
    const unlock = await acquireRegionalSource();
    const releaseGeometry = await beginIfcGeometryWork();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    IfcRegionalRuntime.useSource(this);
    try {
      if (!this.current()) throw Error('Regional model released');
      await this.open();
      const data = await this.send({ type: 'properties', expressId });
      if (this.current())
        void Promise.resolve(writeIfcLodArtifact(key, data)).catch(reportBackgroundError);
      return data;
    } finally {
      this.retainSource();
      unlock();
      releaseGeometry();
    }
  }
  release() {
    if (this.released) return;
    this.released = true;
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    clearInterval(this.interval);
    this.unsubscribeCamera();
    window.removeEventListener('gim-ifc-detail-mode', this.schedule);
    this.options.ctx.fragments.list.onBeforeDelete.remove(this.disposed);
    this.closeSource();
    this.fineRuntime?.release();
    this.fineRuntime = null;
    this.fineOwners.clear();
    for (const request of this.patrolMeshRequests.values()) request.abort();
    this.patrolMeshRequests.clear();
    this.finePending.clear();
    this.fineGeneration.clear();
    for (const cancel of this.fineQueueCancels.values()) cancel();
    this.fineQueueCancels.clear();
    for (const p of this.pending.values()) p.reject(Error('Regional model released'));
    this.pending.clear();
    const restore = [...this.localIds.values()];
    this.localIds.clear();
    if (restore.length)
      void Promise.resolve(
        (async () => {
          try {
            await this.setFarVisible(restore, true);
          } catch {
            /* Model may already be disposed. */
          }
        })(),
      ).catch(reportBackgroundError);
    for (const group of this.groups.values()) this.disposeGroup(group);
    this.groups.clear();
    this.instances.release();
    this.root.removeFromParent();
  }
}
