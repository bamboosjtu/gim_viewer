import { resolveTowerTopology } from "./towerTopology.js";
import { parseHNumCommaRecord } from "@gim/gim-primitives/geometry/lineModParser.js";
export interface TowerPreview {
  bounds: [number, number, number, number];
  segments: [number, number, number, number][];
  pointCount: number;
  rodCount: number;
  unknownCount: number;
}
/** X/Z equal-scale projection. Unique file-wide IDs support trailing R blocks; reused IDs stay Body-local. */
export function buildTowerPreview(text: string, path: string): TowerPreview {
  const mod = parseHNumCommaRecord(text, path);
  const segments: TowerPreview["segments"] = [];
  let pointCount = 0,
    rodCount = 0,
    unknownCount = 0;
  for (const section of resolveTowerTopology(mod)) {
    pointCount += new Set(section.points.map((point) => point.id)).size;
    for (const { record, start: a, end: b } of section.rods) {
      rodCount++;
      if (record.kind === "unknown") unknownCount++;
      if (a && b && [a.x, a.z, b.x, b.z].every(Number.isFinite))
        segments.push([a.x, a.z, b.x, b.z]);
    }
  }
  if (!segments.length) throw new Error("HNum 没有可用的骨架杆件");
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  for (const [a, b, c, d] of segments) {
    minX = Math.min(minX, a, c);
    minZ = Math.min(minZ, b, d);
    maxX = Math.max(maxX, a, c);
    maxZ = Math.max(maxZ, b, d);
  }
  return {
    bounds: [minX, minZ, maxX, maxZ],
    segments,
    pointCount,
    rodCount,
    unknownCount,
  };
}
