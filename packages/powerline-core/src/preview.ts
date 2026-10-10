import { parseHNumCommaRecord } from './geometry/lineModParser.js';
export interface TowerPreview { bounds: [number, number, number, number]; segments: [number, number, number, number][]; pointCount: number; rodCount: number; unknownCount: number }
/** X/Z equal-scale projection. Unique file-wide IDs support trailing R blocks; reused IDs stay Body-local. */
export function buildTowerPreview(text: string, path: string): TowerPreview {
  const mod = parseHNumCommaRecord(text, path);
  const segments: TowerPreview['segments'] = [];
  const filePoints = new Map<number, (typeof mod.bodySections)[number]['points'][number]>();
  let uniqueFileIds = true;
  for (const body of mod.bodySections) for (const point of body.points) {
    if (filePoints.has(point.id)) uniqueFileIds = false;
    filePoints.set(point.id, point);
  }
  let pointCount = 0, rodCount = 0, unknownCount = 0;
  for (const body of mod.bodySections) {
    const localPoints = new Map(body.points.map(p => [p.id, p])); pointCount += localPoints.size;
    // A repeated ID makes the file scope ambiguous: never borrow a point from another Body.
    const points = uniqueFileIds ? filePoints : localPoints;
    for (const rod of body.rods) {
      rodCount++; if (rod.kind === 'unknown') unknownCount++;
      const a = rod.id1 == null ? undefined : points.get(rod.id1), b = rod.id2 == null ? undefined : points.get(rod.id2);
      if (a && b && [a.x, a.z, b.x, b.z].every(Number.isFinite)) segments.push([a.x, a.z, b.x, b.z]);
    }
  }
  if (!segments.length) throw new Error('HNum 没有可用的骨架杆件');
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [a,b,c,d] of segments) { minX = Math.min(minX,a,c); minZ = Math.min(minZ,b,d); maxX = Math.max(maxX,a,c); maxZ = Math.max(maxZ,b,d); }
  return { bounds: [minX,minZ,maxX,maxZ], segments, pointCount, rodCount, unknownCount };
}
