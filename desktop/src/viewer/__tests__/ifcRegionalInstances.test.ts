import { expect, it } from 'vitest';
import * as THREE from 'three';
import { IfcRegionalInstances } from '../ifcRegionalInstances.js';
import type { ObjectFineResult } from '../ifcObjectFineData.js';
const vertices = new Float32Array([
  0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
]);
const make = (id: number, x: number): ObjectFineResult => ({
  expressId: id,
  globalId: String(id),
  ifcType: 'IFCMECHANICALFASTENER',
  geometryMs: 0,
  wasmHeapBytes: 0,
  coordinationMatrix: [],
  parts: [
    {
      geometryId: 100,
      vertices,
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0, 0, 1],
      matrix: new THREE.Matrix4().makeTranslation(x, 0, 0).elements,
    },
  ],
});
it('shares a template while preserving instance picking, one-object highlight and identity after slots change', () => {
  const pool = new IfcRegionalInstances();
  pool.add(make(10, 0));
  pool.add(make(20, 3));
  pool.rebuild(new THREE.Matrix4());
  pool.root.updateMatrixWorld(true);
  expect(pool.statistics).toEqual({
    objects: 2,
    instances: 2,
    drawCalls: 1,
    templates: 1,
  });
  const ray = new THREE.Raycaster(
    new THREE.Vector3(3.2, 0.2, 2),
    new THREE.Vector3(0, 0, -1)
  );
  const hit = ray.intersectObject(pool.root, true)[0];
  expect(pool.identity(hit)).toBe(20);
  const group = new THREE.Group();
  group.userData.expressId = 20;
  pool.highlight(20, group);
  expect(group.children).toHaveLength(1);
  pool.clearHighlight();
  expect(group.children).toHaveLength(0);
  pool.remove(10);
  pool.rebuild(new THREE.Matrix4());
  pool.root.updateMatrixWorld(true);
  expect(pool.identity(ray.intersectObject(pool.root, true)[0])).toBe(20);
  pool.remove(20);
  pool.rebuild(new THREE.Matrix4());
  expect(pool.statistics).toEqual({
    objects: 0,
    instances: 0,
    drawCalls: 0,
    templates: 0,
  });
  pool.release();
});
it('mirrored placements keep the ordinary mesh path', () => {
  const pool = new IfcRegionalInstances(),
    object = make(1, 0);
  object.parts[0].matrix = new THREE.Matrix4().makeScale(-1, 1, 1).elements;
  expect(pool.accepts(object)).toBe(false);
  pool.release();
});
