import * as THREE from 'three';
import type { ProjectLoadSession } from '../app/state.js';
import type { ViewerContext } from './viewerEngine.js';
import type { IfcSelectionScope } from './ifcModelVisibility.js';
import { IFC_CONNECTION_BATCH_MAX_BYTES, IFC_CONNECTION_BATCH_MAX_OBJECTS, connectionChunkBytes, type ConnectionGeometryBatch } from './ifcConnectionBatches.js';
import { isRegionalConnectionObject, type RegionalObject } from './ifcRegionalData.js';
import { validEndpointEvidence } from '../gim/connectionEndpoints.js';

export interface ConnectionPreviewBatch extends ConnectionGeometryBatch {
  modelId: string;
  sourcePath: string;
  sourceIdentity: string;
  coordinateBasis: 'ifc-y-up-m';
}
interface Stream {
  sourcePath: string; sourceIdentity: string; next: number;
  objects: Set<number>; completeObjects: Set<number>; chunks: Set<string>;
  groups: THREE.Group[]; final: boolean; settled: boolean;
}
/** Session-owned source meshes. No inferred centerline or electrical topology.
 * Acknowledged small chunks bound the conversion queue; meshes remain until
 * the authoritative Fragments model is available or the session is released. */
export class IfcConnectionPreviewRuntime {
  readonly root = new THREE.Group();
  readonly diagnostics = { batches: 0, objects: 0, bytes: 0, duplicates: 0, outOfOrder: 0,
    completeModels: 0, partialModels: 0, readyModels: 0, meshChunks: 0, invalid: 0, commitMaxMs: 0 };
  private streams = new Map<string, Stream>();
  private ready = new Set<string>();
  private readyObjects = new Map<string, readonly RegionalObject[]>();
  private released = false;
  private onlySelected = false;
  private selectionScopes: ReadonlyMap<string, IfcSelectionScope> = new Map();
  constructor(ctx: ViewerContext, session: ProjectLoadSession, private readonly current: () => boolean) {
    this.root.name = 'IFC source connection previews';
    this.root.userData = { provider: 'ifc-connection-preview', sessionGeneration: session.generation };
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    (ctx.world.scene as any).three.add(this.root);
  }
  acceptBatch(batch: ConnectionPreviewBatch): boolean {
    if (this.released || !this.current() || this.ready.has(batch.modelId.toLowerCase())) return false;
    if (batch.coordinateBasis !== 'ifc-y-up-m' || !batch.sourceIdentity || !batch.sourcePath
      || !Number.isInteger(batch.sequence) || batch.sequence < 0 || batch.bytes > IFC_CONNECTION_BATCH_MAX_BYTES
      || batch.objects.length > IFC_CONNECTION_BATCH_MAX_OBJECTS) { this.diagnostics.invalid++; return false; }
    const key = batch.modelId.toLowerCase();
    let stream = this.streams.get(key);
    if (!stream) {
      stream = { sourcePath: batch.sourcePath, sourceIdentity: batch.sourceIdentity, next: 0,
        objects: new Set(), completeObjects: new Set(), chunks: new Set(), groups: [], final: false, settled: false };
      this.streams.set(key, stream);
    }
    if (batch.sourcePath !== stream.sourcePath || batch.sourceIdentity !== stream.sourceIdentity) { this.diagnostics.invalid++; return false; }
    if (batch.sequence < stream.next) { this.diagnostics.duplicates++; return false; }
    if (batch.sequence !== stream.next || stream.final) { this.diagnostics.outOfOrder++; return false; }
    const chunks = batch.chunks ?? [];
    if (batch.objects.length && !chunks.length) { this.diagnostics.invalid++; return false; }
    if (chunks.some(chunk => !chunk?.object || !(chunk.vertices instanceof Float32Array)
      || typeof chunk.object.globalId !== 'string' || typeof chunk.object.ifcType !== 'string'
      || typeof chunk.object.name !== 'string')) { this.diagnostics.invalid++; return false; }
    if (chunks.some(chunk => chunk.object.connectionEndpoints !== undefined && !validEndpointEvidence(chunk.object.connectionEndpoints))) {
      this.diagnostics.invalid++; return false;
    }
    const bytes = chunks.reduce((sum, chunk) => sum + connectionChunkBytes(chunk), 0);
    if (bytes > IFC_CONNECTION_BATCH_MAX_BYTES || bytes !== batch.bytes) { this.diagnostics.invalid++; return false; }
    // Validate in source order without mutating stream state: a completion
    // marker may follow its first geometry in this same coalesced batch.
    const seenObjects = new Set(stream.objects), seenChunks = new Set(stream.chunks);
    for (const chunk of chunks) {
      const chunkKey = `${chunk.object.expressId}:${chunk.part}:${chunk.chunk}`;
      if (!(chunk.vertices instanceof Float32Array) || chunk.vertices.length % 18
        || !chunk.vertices.every(Number.isFinite) || chunk.matrix.length !== 16 || !chunk.matrix.every(Number.isFinite)
        || chunk.color.length !== 4 || !chunk.color.every(Number.isFinite)
        || !Number.isInteger(chunk.object.expressId) || !chunk.object.globalId
        || seenChunks.has(chunkKey)
        || chunk.objectComplete && !chunk.vertices.length && !seenObjects.has(chunk.object.expressId)) {
        this.diagnostics.invalid++; return false;
      }
      seenChunks.add(chunkKey);
      if (chunk.vertices.length) seenObjects.add(chunk.object.expressId);
    }
    const started = performance.now();
    const group = new THREE.Group();
    for (const chunk of chunks) {
      const id = chunk.object.expressId;
      stream.objects.add(id);
      if (chunk.objectComplete) stream.completeObjects.add(id);
      stream.chunks.add(`${id}:${chunk.part}:${chunk.chunk}`);
      if (!chunk.vertices.length) continue;
      const geometry = new THREE.BufferGeometry();
      const buffer = new THREE.InterleavedBuffer(chunk.vertices, 6);
      geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
      geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(buffer, 3, 3));
      const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(chunk.color[0],chunk.color[1],chunk.color[2]),
        opacity: chunk.color[3], transparent: chunk.color[3] < 1, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(chunk.matrix);
      mesh.userData = { ...chunk.object, modelId: batch.modelId, sourcePath: batch.sourcePath,
        sourceIdentity: batch.sourceIdentity, provider: 'ifc-connection-preview', part: chunk.part, chunk: chunk.chunk };
      mesh.visible = this.inSelection(batch.modelId, id, chunk.object.globalId);
      group.add(mesh);
      this.diagnostics.meshChunks++;
    }
    if (group.children.length) { this.root.add(group); stream.groups.push(group); }
    stream.next++; stream.final = batch.final;
    this.diagnostics.batches++;
    this.countObjects();
    this.diagnostics.bytes += batch.bytes;
    this.diagnostics.commitMaxMs = Math.max(this.diagnostics.commitMaxMs, performance.now() - started);
    return true;
  }
  markComplete(modelId: string, meta: { objectCount: number; sequence: number }): void {
    const stream = this.streams.get(modelId.toLowerCase());
    if (this.released || !this.current() || !stream || stream.settled) return;
    stream.settled = true;
    if (stream.final && stream.next === meta.sequence && stream.objects.size === meta.objectCount
      && stream.completeObjects.size === meta.objectCount) this.diagnostics.completeModels++;
    else this.diagnostics.partialModels++;
  }
  markFailed(modelId: string): void {
    const stream = this.streams.get(modelId.toLowerCase());
    if (stream && !stream.settled) { stream.settled = true; this.diagnostics.partialModels++; }
  }
  private disposeGroup(group: THREE.Group): void {
    group.removeFromParent();
    group.traverse(object => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) material.dispose(); });
    group.clear();
  }
  private countObjects(): void {
    const keys = new Set([...this.streams.keys(), ...this.readyObjects.keys()]);
    this.diagnostics.objects = [...keys].reduce((sum, key) => sum + new Set([
      ...(this.streams.get(key)?.objects ?? []), ...(this.readyObjects.get(key) ?? []).map(object => object.expressId),
    ]).size, 0);
  }
  /** Authoritative far/index restoration does not require retaining a large
   * duplicate preview cache. It is distinct from a complete preview receipt. */
  markModelReady(modelId: string, sourceObjects?: readonly RegionalObject[]): void {
    if (this.released || !this.current()) return;
    const key = modelId.toLowerCase();
    this.ready.add(key);
    if (sourceObjects) this.readyObjects.set(key, sourceObjects.filter(isRegionalConnectionObject));
    this.diagnostics.readyModels = [...this.readyObjects.values()].filter(objects => objects.length > 0).length;
    this.countObjects();
    const stream = this.streams.get(key);
    if (stream) { for (const group of stream.groups) this.disposeGroup(group); stream.groups = []; }
  }
  /** Small identity/coordinate snapshot for diagnostics and cold/warm checks;
   * contains source bounds, never owned vertex buffers. */
  sourceObjects(): ReadonlyArray<{modelId: string; objects: readonly RegionalObject[]}> {
    return [...this.readyObjects].map(([modelId, objects]) => ({modelId, objects}));
  }
  setTransform(projectSourceToViewer: THREE.Matrix4): void {
    if (this.released) return;
    // Source meshes are already Y-up metres. Cancel only the project's Z-up
    // conversion; keep its actual anchor translation and user offset once.
    this.root.matrix.copy(projectSourceToViewer).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    this.root.updateMatrixWorld(true); this.root.visible = true;
  }
  setVisible(visible: boolean): void { this.root.visible = visible; }
  private inSelection(modelId: string, expressId: number, globalId: string): boolean {
    if (!this.onlySelected) return true;
    const scope = this.selectionScopes.get(modelId);
    return !!scope && (scope.expressIds.has(expressId) || scope.globalIds.has(globalId));
  }
  setSelectionScope(only: boolean, scopes: ReadonlyMap<string, IfcSelectionScope>): void {
    this.onlySelected = only; this.selectionScopes = scopes;
    this.root.traverse(object => {
      const data = object.userData;
      if (data.provider === 'ifc-connection-preview' && data.modelId)
        object.visible = this.inSelection(data.modelId, data.expressId, data.globalId);
    });
  }
  release(): void {
    if (this.released) return; this.released = true;
    for (const stream of this.streams.values()) for (const group of stream.groups) this.disposeGroup(group);
    this.streams.clear(); this.ready.clear(); this.readyObjects.clear(); this.root.removeFromParent();
  }
}
