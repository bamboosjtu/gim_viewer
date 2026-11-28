import * as THREE from 'three';
import type { GeometryBatch, GeometryTemplate, MeshData, PlacedPart } from '@gim/gim-sdk/geometry';

/** Borrow the local arrays. Only MOD merge/CSG needs UVs when none were supplied. */
export function geometryFromMeshData(mesh: MeshData, mergeUvs = true) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  if (mesh.uvs || mergeUvs)
    geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(mesh.uvs ?? new Float32Array((mesh.positions.length / 3) * 2), 2),
    );
  if (mesh.indices) geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return geometry;
}

/** A cache may be shared by batches with the same host resource lifetime. */
export function geometryBatchToGroup(
  batch: GeometryBatch,
  materialFor: (part: PlacedPart) => THREE.Material,
  geometries = new WeakMap<GeometryTemplate, THREE.BufferGeometry>(),
) {
  const group = new THREE.Group();
  for (const object of batch.objects) {
    if (!object.visible) continue;
    for (const part of object.parts) {
      const template = batch.templates.get(part.templateKey);
      if (!template) throw Error('Missing geometry template: ' + part.templateKey);
      let geometry = geometries.get(template);
      if (!geometry) {
        geometry =
          template.kind === 'mesh'
            ? geometryFromMeshData(template.mesh, false)
            : new THREE.BufferGeometry().setAttribute(
                'position',
                new THREE.BufferAttribute(template.positions, 3),
              );
        geometries.set(template, geometry);
      }
      const material = materialFor(part);
      const node =
        template.kind === 'mesh'
          ? new THREE.Mesh(geometry, material)
          : new THREE.LineSegments(geometry, material);
      // Keep the affine placement intact (including shear/reflection) and units out of the template.
      node.matrixAutoUpdate = false;
      node.matrix.fromArray(part.localToParent).premultiply(mmToMetres);
      node.userData = {
        geometrySourceAddress: part.address,
        geometryInstanceId: part.instanceId,
        representationQuality: part.quality,
      };
      group.add(node);
    }
  }
  return group;
}
const mmToMetres = new THREE.Matrix4().makeScale(0.001, 0.001, 0.001);
