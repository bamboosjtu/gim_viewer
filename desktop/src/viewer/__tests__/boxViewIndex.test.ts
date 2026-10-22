import {expect, it} from 'vitest';
import * as THREE from 'three';
import {BoxViewIndex} from '../boxViewIndex.js';

it('matches a full box/frustum scan including long crossing, mirror, scale and coordinate updates', () => {
  const index = new BoxViewIndex(), boxes = new Map<string, THREE.Box3>();
  for (let i = 0; i < 2048; i++) {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))
      .applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3((i % 32) * 8 - 128, Math.floor(i / 32) * 5 - 160, -40),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, i / 50, .2)), new THREE.Vector3(i % 2 ? -2 : 1, 3, 1)));
    boxes.set(String(i), box); index.set(String(i), box);
  }
  const long = new THREE.Box3(new THREE.Vector3(-1000, -1, -30), new THREE.Vector3(1000, 1, -29));
  boxes.set('long', long); index.set('long', long);
  const camera = new THREE.PerspectiveCamera(50, 1.5, .1, 500);
  for (const x of [0, 25, -70]) {
    camera.position.set(x, 0, 20); camera.lookAt(x, 0, -30); camera.updateMatrixWorld(true);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const expected = [...boxes].filter(([,box]) => frustum.intersectsBox(box)).map(([key]) => key).sort();
    expect([...index.query(frustum)].sort()).toEqual(expected);
    expect(index.diagnostics.testedBoxes).toBeLessThan(boxes.size / 2);
  }
  expect(index.diagnostics.rebuilds).toBe(1);
  const moved = long.clone().translate(new THREE.Vector3(0, 10000, 0)); index.set('long', moved);
  index.set('0', null);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  expect(index.query(frustum).has('long')).toBe(false);
  expect(index.diagnostics.entries).toBe(2048);
  expect(index.diagnostics.rebuilds).toBe(2);
  index.clear(); expect(index.query(frustum).size).toBe(0);
});
