import type { TowerMarker, WireSegment } from '../gim/lineMapData.js';
import { pointToSegmentDist, wireLayerKey, wireScreenPoints, type RuntimeWire } from './lineMapGeometry.js';

type Point = { x: number; y: number };

/** Use the current projection for overlay hits and the drawn snapshot for Canvas hits. */
export function nearestTower<T extends { tower: TowerMarker }>(
  rows: readonly T[], project: (row: T) => Point,
  x: number, y: number, radius: number,
): TowerMarker | null {
  let best: TowerMarker | null = null;
  let bestDist = radius;
  for (const row of rows) {
    const point = project(row);
    const dx = point.x - x, dy = point.y - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= bestDist) { bestDist = distance; best = row.tower; }
  }
  return best;
}

/** Hit-test the same visible straight or sagging path that Canvas draws. */
export function nearestWire(
  rows: readonly RuntimeWire[], enabled: (layer: ReturnType<typeof wireLayerKey>) => boolean,
  project: (point: RuntimeWire['start']) => Point,
  width: number, height: number, x: number, y: number, threshold: number,
): WireSegment | null {
  let best: WireSegment | null = null;
  let bestDist = threshold;
  for (const row of rows) {
    if (!enabled(wireLayerKey(row.wire.wireType))) continue;
    const start = project(row.start), end = project(row.end);
    if ((start.x < 0 && end.x < 0) || (start.x > width && end.x > width)) continue;
    if ((start.y < 0 && end.y < 0) || (start.y > height && end.y > height)) continue;
    const points = wireScreenPoints(start, end, row);
    let distance = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
      const segment = points[i], next = points[i + 1];
      const segmentDistance = pointToSegmentDist(x, y, segment.x, segment.y, next.x, next.y);
      if (segmentDistance < distance) distance = segmentDistance;
    }
    if (distance <= bestDist) { bestDist = distance; best = row.wire; }
  }
  return best;
}
