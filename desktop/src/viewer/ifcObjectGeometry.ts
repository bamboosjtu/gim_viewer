import * as THREE from 'three';
import { compileIfcParts, queryIfcIndexRange } from '../gim/geometry/ifcObject.js';
import { geometryBatchToGroup } from './geometryBatch.js';
import type { IfcObjectIdentity } from './ifcObjectIdentity.js';
import type { ObjectFineResult } from './ifcObjectFineData.js';

const neutralToBackendMetres = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

/** SDK ranges are in neutral millimetres. The live Fragments anchor maps source Y-up metres to scene metres. */
export function ifcBoundsToViewer(box: readonly number[], sourceToViewer: THREE.Matrix4) {
  const range = queryIfcIndexRange(box);
  if (range.coverage !== 'conservative') return;
  const { min, max } = range.bounds;
  return new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)).applyMatrix4(
    sourceToViewer
      .clone()
      .multiply(neutralToBackendMetres)
      .scale(new THREE.Vector3(0.001, 0.001, 0.001)),
  );
}

/** sourceToViewer maps the regional index's Y-up metres into the viewer scene. */
export function objectFineGroup(
  result: ObjectFineResult,
  object: IfcObjectIdentity,
  sourceToViewer: THREE.Matrix4,
  sourceVersion: string,
  lod: 1 | 2,
) {
  const batch = compileIfcParts(object, result, sourceVersion, lod);
  const group = geometryBatchToGroup(batch, (part) => {
    const [r, g, b, a] = part.rgba ?? [1, 1, 1, 1];
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(r, g, b),
      opacity: a,
      transparent: a < 1,
      side: THREE.DoubleSide,
    });
  });
  group.userData = {
    ...object,
    representationProvider: 'web-ifc-object',
    lod,
    approximate: lod === 1,
    geometryAvailability: batch.objects[0].availability,
  };
  group.matrixAutoUpdate = false;
  group.matrix.multiplyMatrices(sourceToViewer, neutralToBackendMetres);
  for (const child of group.children) child.userData = { ...group.userData, ...child.userData };
  group.updateMatrixWorld(true);
  return group;
}
