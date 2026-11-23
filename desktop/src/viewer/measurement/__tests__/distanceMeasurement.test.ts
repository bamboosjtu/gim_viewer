import { expect, it } from 'vitest';
import { measureDistance } from '../distanceMeasurement.js';
it('computes a three dimensional distance in engineering metres before rounding either endpoint', () => {
  const a = { xyz: [12.35, 8.2, 3] as [number, number, number], source: 'DEV', lod: 'L1' };
  const b = { xyz: [15.778, 8.2, 3.5] as [number, number, number], source: 'IFC', lod: 'L0' };
  const result = measureDistance(1, a, b);
  expect(result.metres.toFixed(3)).toBe('3.464');
  expect(result.a.source).toBe('DEV');
  expect(result.b.lod).toBe('L0');
  expect(() => measureDistance(2, a, { ...b, xyz: [NaN, 0, 0] })).toThrow();
});
