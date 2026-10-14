import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { RegionalIndex, RegionalObject } from './ifcRegionalData.js';
import { queryRegionalObjects } from './ifcRegionalData.js';
import { objectFineGroup } from './ifcObjectFineRuntime.js';
import type { ObjectFineResult } from './ifcObjectFineData.js';
import {
  readIfcLodArtifact,
  writeIfcLodArtifact,
} from '@desktop/ifcLodCache.js';
import {
  isIfcNearDetailEnabled,
  IFC_NEAR_TEMPLATE_CACHE_VERSION,
} from '../config/features.js';
import { IfcRegionalInstances } from './ifcRegionalInstances.js';

// A source model can consume hundreds of MB. Serialize regional source work
// across IFCs, and release its heap after each request; mesh caches outlive it.
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
    stage: 'idle',
    error: '',
    regionMs: 0,
  };
  private worker: Worker | null = null;
  private opening: Promise<void> | null = null;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (data: any) => void; reject: (e: Error) => void }
  >();
  private groups = new Map<number, THREE.Group>();
  private localIds = new Map<number, number>();
  private guidIds: Promise<Map<string, number[]>> | null = null;
  private epoch = 0;
  private released = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval>;
  private transform: THREE.Matrix4;
  private disposed = ({ value }: { value: any }) => {
    if (value.modelId === this.options.model.modelId) this.release();
  };
  constructor(
    readonly modelId: string,
    readonly sourcePath: string,
    readonly index: RegionalIndex,
    private options: {
      ctx: ViewerContext;
      model: any;
      readBytes: () => Promise<Uint8Array | null>;
      cacheKey: string;
      isCurrent: () => boolean;
      sourceToViewer: THREE.Matrix4;
      onBeforeDisposeGroup?: (group: THREE.Group) => void;
    }
  ) {
    const base =
      options.ctx.fragments.baseCoordinationMatrix?.clone() ??
      new THREE.Matrix4();
    this.transform = options.sourceToViewer ?? base;
    this.root.name = 'IFC regional detail';
    this.root.add(this.instances.root);
    (options.ctx.world.scene as any).three.add(this.root);
    options.ctx.world.camera.controls?.addEventListener(
      'update',
      this.schedule
    );
    window.addEventListener('gim-ifc-detail-mode', this.schedule);
    options.ctx.fragments.list.onBeforeDelete.add(this.disposed);
    this.interval = setInterval(() => {
      const visible = options.model.object.visible;
      if (this.root.visible !== visible) {
        this.root.visible = visible;
        this.schedule();
      }
      if (!this.transform.equals(options.ctx.fragments.baseCoordinationMatrix))
        this.schedule();
      if (!options.isCurrent()) this.release();
    }, 1000);
    this.schedule();
  }
  private current = () => !this.released && this.options.isCurrent();
  private send(message: any, transfer: Transferable[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(Error('Regional worker unavailable'));
        return;
      }
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }
  private async open() {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const bytes = await this.options.readBytes();
      if (!this.current() || !bytes?.byteLength)
        throw Error('Regional source unavailable');
      this.worker = new Worker(
        new URL('./ifcRegionalWorker.ts', import.meta.url),
        { type: 'module' }
      );
      this.worker.onmessage = ({ data }) => {
        if (data.stage) {
          this.diagnostics.stage = data.stage;
          return;
        }
        const p = this.pending.get(data.id);
        if (!p) return;
        this.pending.delete(data.id);
        data.error ? p.reject(Error(data.error)) : p.resolve(data.data);
      };
      this.worker.onerror = (e) => {
        const error = Error(
          e.message || `Regional worker failed at ${e.filename}:${e.lineno}`
        );
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
        [owned.buffer]
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.update().catch((error) =>
        console.warn('[IFC regional]', error)
      );
    }, 250);
  };
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
    this.instances.remove(group.userData.expressId);
    group.removeFromParent();
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
  }
  private closeSource() {
    this.worker?.terminate();
    this.worker = null;
    this.opening = null;
  }
  private async update() {
    if (this.busy || !this.current()) return;
    this.busy = true;
    const epoch = this.epoch,
      started = performance.now(),
      before = this.groups.size;
    const unlock = await acquireRegionalSource();
    try {
      if (!this.current() || epoch !== this.epoch) return;
      // Fragments publishes its final anchor asynchronously, including HIT.
      // Follow that authoritative project matrix; never retain the initial identity.
      const published = this.options.ctx.fragments.baseCoordinationMatrix;
      if (published && !this.transform.equals(published)) {
        const restore = [...this.localIds.values()];
        if (restore.length) await this.options.model.setVisible(restore, true);
        if (this.groups.size !== before) this.instances.rebuild(this.transform);
        for (const group of this.groups.values()) this.disposeGroup(group);
        this.groups.clear();
        this.localIds.clear();
        this.transform.copy(published);
        this.instances.rebuild(this.transform);
      }
      const objects =
        isIfcNearDetailEnabled() && this.options.model.object.visible
          ? queryRegionalObjects(
              this.index.objects,
              this.transform,
              (this.options.ctx.world.camera as any).three
            )
          : [];
      const desired = new Set(objects.map((o) => o.expressId));
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
      if (restore.length) await this.options.model.setVisible(restore, true);
      if (this.groups.size !== before) this.instances.rebuild(this.transform);
      if (!this.current() || epoch !== this.epoch) return;
      if (!objects.length) {
        if (this.pending.size === 0) {
          this.worker?.terminate();
          this.worker = null;
          this.opening = null;
        }
        this.diagnostics.rendered = this.groups.size;
        this.diagnostics.pending = 0;
        return;
      }
      const ids = await this.farIds();
      let prepared = false;
      for (let start = 0; start < objects.length; start += 32) {
        if (!this.current() || epoch !== this.epoch) return;
        const batch = objects
          .slice(start, start + 32)
          .filter((o) => !this.groups.has(o.expressId));
        if (!batch.length) continue;
        this.diagnostics.pending = objects.length - start;
        const results = new Map<number, ObjectFineResult>(),
          missing: RegionalObject[] = [];
        for (const object of batch) {
          const cached = await readIfcLodArtifact<ObjectFineResult>(
            `${this.options.cacheKey}|${IFC_NEAR_TEMPLATE_CACHE_VERSION}|${object.expressId}`
          );
          if (
            cached?.globalId === object.globalId &&
            Array.isArray(cached.parts)
          ) {
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
            if (this.current())
              void writeIfcLodArtifact(
                `${this.options.cacheKey}|${IFC_NEAR_TEMPLATE_CACHE_VERSION}|${result.expressId}`,
                result
              );
          }
        }
        if (!this.current() || epoch !== this.epoch) return;
        for (const object of batch) {
          if (!this.current() || epoch !== this.epoch) return;
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
                {
                  ...object,
                  key: `ifc:${this.modelId.toLowerCase()}:object:${object.expressId}`,
                  modelId: this.modelId,
                  sourcePath: this.sourcePath,
                  provider: 'ifc-regional',
                },
                this.transform
                  .clone()
                  .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
              );
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
          if (candidates.length === 1) {
            await this.options.model.setVisible(candidates, false);
            this.localIds.set(object.expressId, candidates[0]);
          }
        }
        this.diagnostics.rendered = this.groups.size;
        this.instances.rebuild(this.transform);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      this.diagnostics.pending = 0;
      if (this.groups.size !== before)
        this.diagnostics.regionMs = performance.now() - started;
    } catch (error) {
      if (this.current()) {
        this.diagnostics.failed++;
        this.diagnostics.error = String(error);
        this.diagnostics.pending = 0;
      }
      throw error;
    } finally {
      this.closeSource();
      unlock();
      this.busy = false;
      if (this.current() && epoch !== this.epoch) this.schedule();
    }
  }
  pick(
    ray: THREE.Raycaster
  ): { object: RegionalObject; distance: number } | null {
    if (!this.root.visible) return null;
    this.root.updateMatrixWorld(true);
    const hit = ray.intersectObjects(this.root.children, true)[0];
    if (!hit) return null;
    const id = this.instances.identity(hit) ?? hit.object.userData.expressId;
    const object = this.index.objects.find((o) => o.expressId === id);
    return object ? { object, distance: hit.distance } : null;
  }
  group(expressId: number) {
    return this.groups.get(expressId);
  }
  highlightGroup(expressId: number) {
    const group = this.groups.get(expressId);
    if (group) this.instances.highlight(expressId, group);
    return group;
  }
  clearHighlight() {
    this.instances.clearHighlight();
  }
  get instanceStatistics() {
    return this.instances.statistics;
  }
  async properties(expressId: number) {
    const key = `${this.options.cacheKey}|properties|${expressId}`;
    const cached = await readIfcLodArtifact<any>(key);
    if (cached?.attributes) return cached;
    const unlock = await acquireRegionalSource();
    try {
      if (!this.current()) throw Error('Regional model released');
      await this.open();
      const data = await this.send({ type: 'properties', expressId });
      if (this.current()) void writeIfcLodArtifact(key, data);
      return data;
    } finally {
      this.closeSource();
      unlock();
    }
  }
  release() {
    if (this.released) return;
    this.released = true;
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    clearInterval(this.interval);
    this.options.ctx.world.camera.controls?.removeEventListener(
      'update',
      this.schedule
    );
    window.removeEventListener('gim-ifc-detail-mode', this.schedule);
    this.options.ctx.fragments.list.onBeforeDelete.remove(this.disposed);
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values())
      p.reject(Error('Regional model released'));
    this.pending.clear();
    for (const group of this.groups.values()) this.disposeGroup(group);
    this.groups.clear();
    this.instances.release();
    this.root.removeFromParent();
  }
}
