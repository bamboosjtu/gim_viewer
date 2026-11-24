import { Box3, Vector3 } from 'three';
import { expect, it } from 'vitest';
import { gateApproaches, stationGateRank } from '../patrolGate.js';

const bounds = (x: number, y: number, w: number, h: number) =>
  new Box3(new Vector3(x, y, 0), new Vector3(x + w, y + h, 2));
const site = bounds(0, 0, 100, 100);
it('distinguishes the station gate from a guard house, building door and gate post', () => {
  expect(stationGateRank('平开大门:平开大门:1712041 平开大门')).toBe('gate');
  expect(stationGateRank('推拉大门（中小门）')).toBe('gate');
  expect(stationGateRank('平开大门_门杆')).toBeUndefined();
  expect(stationGateRank('平开大门_矩形柱')).toBeUndefined();
  expect(stationGateRank('主控楼平开大门')).toBeUndefined();
  expect(stationGateRank('办公楼主大门')).toBeUndefined();
  expect(stationGateRank('门卫室大门')).toBeUndefined();
});
it('groups adjacent leaves, faces inward, and needs an explicit main gate when entrances are disjoint', () => {
  const a = { rank: 'gate' as const, bounds: bounds(90, 30, 0.3, 3) },
    b = { ...a, bounds: bounds(90, 33.1, 0.3, 3) };
  const start = gateApproaches([a, b], site)[0];
  expect(start.point.x).toBeCloseTo(99.15);
  expect(Math.sin(start.yaw)).toBeCloseTo(-1);
  const second = { ...a, bounds: bounds(5, 30, 0.3, 4) };
  expect(gateApproaches([a, second], site)).toEqual([]);
  expect(gateApproaches([a, { ...second, rank: 'main' }], site)[0].point.x).toBeLessThan(5);
});
