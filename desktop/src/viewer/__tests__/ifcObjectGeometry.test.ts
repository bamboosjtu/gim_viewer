import { expect, it } from 'vitest';
import * as THREE from 'three';
import { objectFineGroup } from '../ifcObjectGeometry.js';
import { fineTransferList, type ObjectFineResult } from '../ifcObjectFineData.js';
const identity = {
  key: 'a#17',
  sourcePath: 'a.ifc',
  modelId: 'a',
  expressId: 17,
  globalId: 'G',
  name: 'test',
  ifcType: 'IFCWALL',
  provider: 'web-ifc',
};
const vertices = new Float32Array([1, 2, 3, 0, 0, 1, 2, 2, 3, 0, 0, 1, 1, 3, 3, 0, 0, 1]);
const makePart = (x: number) => ({
  geometryId: 13,
  vertices,
  indices,
  matrix: new THREE.Matrix4().makeTranslation(x, 0, 0).toArray(),
  color: [1, 0.5, 0, 0.7],
});
const indices = new Uint32Array([0, 1, 2]);
it('keeps both model and part identity under a reflected placement and applies the scene anchor once', () => {
  const parts = [makePart(0), makePart(10)];
  parts[1].matrix[0] = -1;
  const result: ObjectFineResult = {
    ...identity,
    parts,
    frame: { kind: 'source' },
    coordinationMatrix: new THREE.Matrix4().makeTranslation(-10, 0, 0).toArray(),
    geometryMs: 0,
    wasmHeapBytes: 0,
  };
  expect(fineTransferList(result)).toHaveLength(2);
  const anchor = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  for (const [modelId, offset] of [
    ['a', 0],
    ['b', 30],
  ] as const) {
    const group = objectFineGroup(
      result,
      { ...identity, modelId },
      new THREE.Matrix4().makeTranslation(offset, 0, 0).multiply(anchor),
      'sha',
      2,
    );
    const [left, right] = group.children as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshStandardMaterial
    >[];
    expect(left.geometry).toBe(right.geometry);
    expect(left.material.opacity).toBe(0.7);
    expect(right.matrixWorld.determinant()).toBeLessThan(0);
    for (const [index, mesh] of [left, right].entries()) {
      mesh.material.side = THREE.FrontSide;
      const centre = new THREE.Vector3(offset + (index ? 10 - 4 / 3 : 4 / 3), -3, 7 / 3);
      const normal = new THREE.Vector3(0, -1, 0)
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
        .normalize();
      const hit = new THREE.Raycaster(
        centre.clone().add(normal),
        normal.clone().negate(),
      ).intersectObject(mesh)[0];
      expect(hit?.point.distanceTo(centre)).toBeLessThan(1e-5);
      expect(hit.object.userData.geometrySourceAddress).toMatchObject({
        modelId,
        expressId: 17,
        geometryId: 13,
        partIndex: index,
      });
    }
  }
});
