import { Box3, Matrix4, Triangle, Vector3 } from 'three';
import { describe, it, expect } from 'vitest';
import {
  bodyHits,
  buildPatrolAsset,
  supportHeight,
  supportedInterval,
  visitTriangles,
} from '../patrolGeometry.js';
const p = (x: number, y: number, z: number) => new Vector3(x, y, z);
describe('source navigation geometry', () => {
  it('tests the entire capsule sweep including a thin wall between clear endpoints', () => {
    const wall = new Triangle(p(0, -2, 0), p(0, 2, 0), p(0, 0, 3));
    const a = p(-1, 0, 0),
      b = p(1, 0, 0);
    expect(bodyHits(wall, a, a)).toBe(false);
    expect(bodyHits(wall, b, b)).toBe(false);
    expect(bodyHits(wall, a, b)).toBe(true);
    expect(bodyHits(wall, p(-1, 3, 0), p(1, 3, 0))).toBe(false);
  });
  it('tests head clearance and resolves support relative to the current floor', () => {
    const ceiling = new Triangle(p(-2, -2, 1.5), p(2, -2, 1.5), p(0, 2, 1.5));
    expect(bodyHits(ceiling, p(0, 0, 0), p(0, 0, 0))).toBe(true);
    expect(supportHeight(ceiling, p(0, 0, 0))).toBeUndefined();
    expect(supportHeight(ceiling, p(0, 0, 1.4))).toBe(1.5);
  });
  it('exposes unsupported intervals between two supported endpoints', () => {
    const a = p(0, 0, 0),
      b = p(1, 0, 0);
    const left = new Triangle(p(-2, -1, 0), p(0.45, -1, 0), p(0.45, 1, 0));
    const right = new Triangle(p(0.55, -1, 0), p(2, -1, 0), p(0.55, 1, 0));
    expect(supportedInterval(left, a, b)![1]).toBeCloseTo(0.45);
    expect(supportedInterval(right, a, b)![0]).toBeCloseTo(0.55);
  });
  it('reuses a local BVH on mirrored, sheared and non-uniform occurrences', () => {
    const asset = buildPatrolAsset([
      {
        positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
        indices: new Uint32Array([0, 1, 2]),
        matrix: new Matrix4().toArray(),
      },
    ]);
    for (const sign of [-1, 1]) {
      const matrix = new Matrix4().set(2 * sign, 0.2, 0, 5, 0, 0.5, 0, 3, 0, 0, 1, 1, 0, 0, 0, 1);
      const q = p(0.25, 0.25, 0).applyMatrix4(matrix);
      expect(
        visitTriangles(
          {
            asset,
            matrix,
            inverse: matrix.clone().invert(),
            mirror: sign < 0,
            id: 'occurrence',
            support: true,
          },
          new Box3(q.clone(), q.clone()).expandByScalar(0.01),
          (t) => supportHeight(t, q) === 1,
        ),
      ).toBe(true);
    }
  });
});
