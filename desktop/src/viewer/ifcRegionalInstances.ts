import * as THREE from 'three';
import type { ObjectFineResult, ObjectFinePart } from './ifcObjectFineData.js';

/** Session-owned template pool. Only eligible fasteners are instanced;
 * mirrored placements retain the ordinary mesh path. Instance slots keep the
 * source ExpressId, and one selected object gets a separate highlight mesh. */
export class IfcRegionalInstances {
  readonly root = new THREE.Group();
  private objects = new Map<number, ObjectFineResult>();
  private templates = new Map<number, THREE.BufferGeometry>();
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private meshes: THREE.InstancedMesh[] = [];
  private overlay: THREE.Group | null = null;
  accepts(result: ObjectFineResult): boolean {
    return (
      /^(IFCMECHANICALFASTENER|IFCFASTENER)$/i.test(result.ifcType) &&
      result.parts.every(
        (part) =>
          part.geometryId !== undefined &&
          new THREE.Matrix4().fromArray(part.matrix).determinant() > 0
      )
    );
  }
  add(result: ObjectFineResult) {
    this.objects.set(result.expressId, result);
  }
  remove(id: number) {
    if (this.overlay?.userData.expressId === id) this.clearHighlight();
    this.objects.delete(id);
  }
  private geometry(part: ObjectFinePart): THREE.BufferGeometry {
    let geometry = this.templates.get(part.geometryId!);
    if (geometry) return geometry;
    geometry = new THREE.BufferGeometry();
    const buffer = new THREE.InterleavedBuffer(part.vertices, 6);
    geometry.setAttribute(
      'position',
      new THREE.InterleavedBufferAttribute(buffer, 3, 0)
    );
    geometry.setAttribute(
      'normal',
      new THREE.InterleavedBufferAttribute(buffer, 3, 3)
    );
    geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
    this.templates.set(part.geometryId!, geometry);
    return geometry;
  }
  private material(part: ObjectFinePart) {
    const key = part.color.join(',');
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(
          ...(part.color.slice(0, 3) as [number, number, number])
        ),
        opacity: part.color[3],
        transparent: part.color[3] < 1,
        side: THREE.DoubleSide,
      });
      this.materials.set(key, material);
    }
    return material;
  }
  rebuild(base: THREE.Matrix4) {
    this.clearMeshes();
    const buckets = new Map<
      string,
      { part: ObjectFinePart; items: { id: number; matrix: THREE.Matrix4 }[] }
    >();
    for (const object of this.objects.values())
      for (const part of object.parts) {
        const key = `${part.geometryId}|${part.color.join(',')}`;
        if (!buckets.has(key)) buckets.set(key, { part, items: [] });
        buckets
          .get(key)!
          .items.push({
            id: object.expressId,
            matrix: base
              .clone()
              .multiply(new THREE.Matrix4().fromArray(part.matrix)),
          });
      }
    const used = new Set<number>(),
      usedMaterials = new Set<string>();
    for (const { part, items } of buckets.values()) {
      const mesh = new THREE.InstancedMesh(
        this.geometry(part),
        this.material(part),
        items.length
      );
      used.add(part.geometryId!);
      usedMaterials.add(part.color.join(','));
      mesh.userData.ifcInstanceIds = items.map((item) => item.id);
      for (let i = 0; i < items.length; i++)
        mesh.setMatrixAt(i, items[i].matrix);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      this.root.add(mesh);
      this.meshes.push(mesh);
    }
    for (const [id, geometry] of this.templates)
      if (!used.has(id)) {
        geometry.dispose();
        this.templates.delete(id);
      }
    for (const [key, material] of this.materials)
      if (!usedMaterials.has(key)) {
        material.dispose();
        this.materials.delete(key);
      }
  }
  identity(hit: THREE.Intersection): number | undefined {
    return hit.instanceId === undefined
      ? undefined
      : hit.object.userData.ifcInstanceIds?.[hit.instanceId];
  }
  highlight(id: number, group: THREE.Group) {
    this.clearHighlight();
    const result = this.objects.get(id);
    if (!result) return;
    for (const part of result.parts) {
      const mesh = new THREE.Mesh(this.geometry(part), this.material(part));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(part.matrix);
      mesh.userData = { ...group.userData };
      group.add(mesh);
    }
    this.overlay = group;
    group.updateMatrixWorld(true);
  }
  clearHighlight() {
    if (this.overlay) {
      this.overlay.clear();
      this.overlay = null;
    }
  }
  private clearMeshes() {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.meshes = [];
  }
  get statistics() {
    return {
      objects: this.objects.size,
      instances: this.meshes.reduce((sum, mesh) => sum + mesh.count, 0),
      drawCalls: this.meshes.length,
      templates: this.templates.size,
    };
  }
  release() {
    this.clearHighlight();
    this.clearMeshes();
    for (const geometry of this.templates.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.templates.clear();
    this.materials.clear();
    this.objects.clear();
    this.root.removeFromParent();
  }
}
