import * as THREE from 'three';

interface Binding {
  root: THREE.Group;
  mesh: THREE.Mesh;
  layers: number;
  bucket: Bucket;
  highlighted: boolean;
}
interface Bucket {
  bindings: Binding[];
  active: Binding[];
  mesh?: THREE.InstancedMesh;
  capacity: number;
  disabled?: boolean;
}
const owners = new WeakMap<THREE.Mesh, { owner: DevInstanceBatches; binding: Binding }>();
const renderBatches = new WeakSet<THREE.Object3D>();
/** Original occurrence meshes remain the authority for scene/overview bounds.
 * GPU batches are an additional draw representation of those same meshes. */
export function isDevRenderBatch(object: THREE.Object3D): boolean {
  return renderBatches.has(object);
}

/** Selection keeps using the original occurrence/assembly hierarchy. Only the
 * selected mesh leaves its GPU batch; its shared base material is untouched. */
export function setDevInstanceHighlight(mesh: THREE.Mesh, highlighted: boolean): void {
  const entry = owners.get(mesh);
  if (entry) entry.owner.highlight(entry.binding, highlighted);
}

function visible(object: THREE.Object3D): boolean {
  for (let item: THREE.Object3D | null = object; item; item = item.parent) if (!item.visible) return false;
  return true;
}
/** Three's instanced normal transform supports orthogonal, positive bases.
 * Mirrored, singular and sheared transforms retain ordinary Mesh rendering. */
function supportedMatrix(matrix: THREE.Matrix4): boolean {
  if (!matrix.elements.every(Number.isFinite) || matrix.determinant() <= 1e-12) return false;
  const e = matrix.elements;
  if (e[3] !== 0 || e[7] !== 0 || e[11] !== 0 || e[15] !== 1) return false;
  const axes = [0, 4, 8].map(index => new THREE.Vector3(e[index], e[index + 1], e[index + 2]));
  return axes.every(axis => axis.lengthSq() > 1e-16) && [[0,1],[0,2],[1,2]].every(([a,b]) =>
    Math.abs(axes[a].dot(axes[b])) <= 1e-6 * axes[a].length() * axes[b].length());
}
function compatible(mesh: THREE.Mesh): boolean {
  for (let parent = mesh.parent; parent; parent = parent.parent) if (parent.renderOrder !== 0) return false;
  const material = mesh.material as THREE.MeshStandardMaterial;
  return mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh
    && !Array.isArray(mesh.material) && !!material?.isMeshStandardMaterial
    && !material.transparent && material.opacity === 1 && material.alphaTest === 0
    && !material.wireframe && !material.clippingPlanes?.length && !material.displacementMap
    && !mesh.morphTargetInfluences && !Object.keys(mesh.geometry.morphAttributes).length
    && !mesh.customDepthMaterial && !mesh.customDistanceMaterial
    && mesh.onBeforeRender === THREE.Object3D.prototype.onBeforeRender
    && mesh.onAfterRender === THREE.Object3D.prototype.onAfterRender
    && material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile
    && material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
}

/** Session-owned render adapter. Geometry/material lifetime remains owned by
 * the DEV template cache; this owner releases only instance buffers. Original
 * hierarchies remain available for assembly selection and exact bounds. */
export class DevInstanceBatches {
  readonly root = new THREE.Group();
  private groups = new Map<THREE.Group, Binding[]>();
  private buckets = new Map<string, Bucket>();
  private released = false;
  private failures = 0;
  private lastFailure: string | null = null;
  private inverse = new THREE.Matrix4();
  private readonly minimum = 3;
  constructor(parent: THREE.Object3D) {
    this.root.name = 'DEV shared draw batches';
    this.root.matrixAutoUpdate = false;
    parent.add(this.root);
  }
  private matrix(mesh: THREE.Mesh): THREE.Matrix4 {
    return this.inverse.clone().multiply(mesh.matrixWorld);
  }
  add(group: THREE.Group, batching = true): void {
    if (this.released || this.groups.has(group)) return;
    this.root.updateWorldMatrix(true, false); this.inverse.copy(this.root.matrixWorld).invert();
    group.updateWorldMatrix(true, true);
    const bindings: Binding[] = [], touched = new Set<Bucket>();
    this.groups.set(group, bindings);
    group.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!batching || !mesh.isMesh || !compatible(mesh) || !supportedMatrix(this.matrix(mesh))) return;
      const key = `${mesh.geometry.uuid}|${(mesh.material as THREE.Material).uuid}|${mesh.layers.mask}|${mesh.castShadow}|${mesh.receiveShadow}|${mesh.renderOrder}`;
      let bucket = this.buckets.get(key);
      if (!bucket) { bucket = {bindings: [], active: [], capacity: 0}; this.buckets.set(key, bucket); }
      const binding = {root: group, mesh, layers: mesh.layers.mask, bucket, highlighted: false};
      bindings.push(binding); bucket.bindings.push(binding); touched.add(bucket);
      owners.set(mesh, {owner: this, binding});
    });
    for (const bucket of touched) this.refresh(bucket);
  }
  remove(group: THREE.Group): void {
    const bindings = this.groups.get(group); if (!bindings) return;
    const touched = new Set<Bucket>();
    for (const binding of bindings) {
      owners.delete(binding.mesh); binding.mesh.layers.mask = binding.layers;
      const rows = binding.bucket.bindings, index = rows.indexOf(binding);
      if (index >= 0) rows.splice(index, 1);
      touched.add(binding.bucket);
    }
    this.groups.delete(group);
    for (const bucket of touched) this.refresh(bucket);
    for (const [key, bucket] of this.buckets) if (!bucket.bindings.length) this.buckets.delete(key);
  }
  /** Called on anchor/visibility changes, never in the renderer's frame loop. */
  sync(): void {
    if (this.released) return;
    this.root.updateWorldMatrix(true, false); this.inverse.copy(this.root.matrixWorld).invert();
    for (const group of this.groups.keys()) group.updateWorldMatrix(true, true);
    for (const bucket of this.buckets.values()) this.refresh(bucket);
  }
  private clearMesh(bucket: Bucket): void {
    if (bucket.mesh) { renderBatches.delete(bucket.mesh); bucket.mesh.removeFromParent(); bucket.mesh.dispose(); }
    bucket.mesh = undefined; bucket.capacity = 0; bucket.active = [];
  }
  private refresh(bucket: Bucket): void {
    if (bucket.disabled) return;
    try { this.rebuild(bucket); }
    catch (error) {
      // A rendering optimization must never remove valid source geometry.
      // Stop retrying this bucket after an allocation/upload failure.
      this.clearMesh(bucket); bucket.disabled = true;
      for (const binding of bucket.bindings) binding.mesh.layers.mask = binding.layers;
      this.failures++; this.lastFailure = String(error).slice(0, 256);
    }
  }
  private rebuild(bucket: Bucket): void {
    const eligible = bucket.bindings.filter(binding => supportedMatrix(this.matrix(binding.mesh)));
    if (eligible.length < this.minimum) {
      this.clearMesh(bucket);
      for (const binding of bucket.bindings) binding.mesh.layers.mask = binding.layers;
      return;
    }
    const allowed = new Set(eligible);
    bucket.active = eligible.filter(binding => !binding.highlighted && visible(binding.mesh));
    // Visibility is inherited through each original occurrence. Hidden or
    // selected slots are removed from the draw array, never zero-scaled.
    for (const binding of bucket.bindings) binding.mesh.layers.mask = allowed.has(binding) && !binding.highlighted ? 0 : binding.layers;
    if (!bucket.mesh || bucket.capacity < bucket.active.length) {
      if (bucket.mesh) renderBatches.delete(bucket.mesh);
      bucket.mesh?.removeFromParent(); bucket.mesh?.dispose();
      bucket.mesh = undefined; bucket.capacity = 0;
      const reference = eligible[0];
      bucket.capacity = 2 ** Math.ceil(Math.log2(Math.max(this.minimum, bucket.active.length)));
      bucket.mesh = new THREE.InstancedMesh(reference.mesh.geometry, reference.mesh.material, bucket.capacity);
      renderBatches.add(bucket.mesh);
      bucket.mesh.matrixAutoUpdate = false;
      bucket.mesh.layers.mask = reference.layers;
      bucket.mesh.castShadow = reference.mesh.castShadow; bucket.mesh.receiveShadow = reference.mesh.receiveShadow;
      bucket.mesh.renderOrder = reference.mesh.renderOrder;
      this.root.add(bucket.mesh);
    }
    bucket.mesh.count = bucket.active.length;
    bucket.active.forEach((binding, index) => bucket.mesh!.setMatrixAt(index, this.matrix(binding.mesh)));
    bucket.mesh.instanceMatrix.needsUpdate = true;
    bucket.mesh.computeBoundingBox(); bucket.mesh.computeBoundingSphere();
  }
  highlight(binding: Binding, highlighted: boolean): void {
    if (this.released || binding.highlighted === highlighted) return;
    binding.highlighted = highlighted; this.refresh(binding.bucket);
  }
  pick(ray: THREE.Raycaster): {rootOccurrence: string; instanceKey: string; distance: number} | null {
    if (this.released || !visible(this.root)) return null;
    this.root.updateWorldMatrix(true, true);
    const candidates: {root: THREE.Group; distance: number}[] = [];
    const roots = [...this.groups.keys()].filter(visible);
    for (const hit of ray.intersectObjects(roots, true)) {
      if (!(hit.object as THREE.Mesh).isMesh || !visible(hit.object)) continue;
      let owner: THREE.Object3D | null = hit.object;
      while (owner && !this.groups.has(owner as THREE.Group)) owner = owner.parent;
      if (owner) candidates.push({root: owner as THREE.Group, distance: hit.distance});
    }
    for (const bucket of this.buckets.values()) {
      if (!bucket.mesh || !bucket.mesh.count) continue;
      for (const hit of ray.intersectObject(bucket.mesh)) {
        const binding = hit.instanceId == null ? undefined : bucket.active[hit.instanceId];
        if (binding) candidates.push({root: binding.root, distance: hit.distance});
      }
    }
    const nearest = candidates.sort((a,b) => a.distance - b.distance)[0];
    return nearest ? {rootOccurrence: nearest.root.userData.rootOccurrence,
      instanceKey: nearest.root.userData.instanceKey, distance: nearest.distance} : null;
  }
  get statistics() {
    const batches = [...this.buckets.values()].filter(bucket => bucket.mesh);
    const instances = batches.reduce((sum, bucket) => sum + bucket.active.length, 0);
    return {groups: this.groups.size, batchedMeshes: instances, batches: batches.length,
      avoidedMeshDraws: instances - batches.filter(bucket => bucket.active.length).length,
      instanceBufferBytes: batches.reduce((sum,bucket) => sum + bucket.capacity * 16 * 4, 0),
      failedBuckets: [...this.buckets.values()].filter(bucket => bucket.disabled).length,
      failures: this.failures, lastFailure: this.lastFailure};
  }
  release(): void {
    if (this.released) return;
    for (const bindings of this.groups.values()) for (const binding of bindings) {
      owners.delete(binding.mesh); binding.mesh.layers.mask = binding.layers;
    }
    for (const bucket of this.buckets.values()) this.clearMesh(bucket);
    this.groups.clear(); this.buckets.clear();
    this.root.removeFromParent(); this.released = true;
  }
}
