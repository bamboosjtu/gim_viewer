import { expect, it } from 'vitest';
import { Box3, Matrix4, Vector3 } from 'three';
import { initialSection, sectionPlanes } from '../sectionController.js';
it('uses the same transformed Z-up metre half spaces for surfaces, boxes and reversed planes', () => {
  const anchor = new Matrix4().makeRotationX(-Math.PI / 2).setPosition(110, -47, 32);
  const bounds = new Box3(new Vector3(0, 0, 2), new Vector3(10, 10, 14));
  const s = initialSection('horizontal', bounds);
  expect(s.offset).toBe(8);
  const inside = (shape: typeof s, p: Vector3) => {
    const world = p.clone().applyMatrix4(anchor);
    return sectionPlanes(shape, anchor).every((plane) => plane.distanceToPoint(world) >= -1e-8);
  };
  expect(inside(s, new Vector3(2, 2, 7))).toBe(true);
  expect(inside(s, new Vector3(2, 2, 9))).toBe(false);
  expect(inside({ ...s, flipped: true }, new Vector3(2, 2, 9))).toBe(true);
  const planes = sectionPlanes(initialSection('box', bounds), anchor);
  expect(planes).toHaveLength(6);
  for (const [p, expected] of [
    [new Vector3(2, 2, 7), true],
    [new Vector3(11, 2, 7), false],
  ] as const) {
    const q = p.applyMatrix4(anchor);
    expect(planes.every((plane) => plane.distanceToPoint(q) >= -1e-8)).toBe(expected);
  }
});
