import type { DistanceResult, SurfacePoint } from '../../shared/viewerCommands.js';

export function measureDistance(id: number, a: SurfacePoint, b: SurfacePoint): DistanceResult {
  const metres = Math.hypot(b.xyz[0] - a.xyz[0], b.xyz[1] - a.xyz[1], b.xyz[2] - a.xyz[2]);
  if (!Number.isFinite(metres)) throw Error('测量坐标无效');
  return { id, a, b, metres };
}
