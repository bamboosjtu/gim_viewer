import { isUsableAffineMatrix } from '../../../gim/geometry/affineMatrix.js';
import type { PatrolSource } from '../../../viewer/patrol/navigationQueryPort.js';
import type { PatrolAsset } from '../../../shared/patrolSpatialAsset.js';
type Vec3 = [number, number, number];
type CachedSource = Omit<PatrolSource, 'load' | 'bounds' | 'matrix'> & {
  bounds: [number, number, number, number, number, number];
  matrix: number[];
};
export interface PatrolSceneManifest {
  sources: CachedSource[];
  unknown: string[];
  unavailable: string[];
  approaches: { point: Vec3; yaw: number }[];
}
const vector = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const bounds = (v: unknown) => vector(v, 6) && v[0] <= v[3] && v[1] <= v[4] && v[2] <= v[5];
const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
export function usableManifest(v: PatrolSceneManifest | undefined): v is PatrolSceneManifest {
  return (
    !!v &&
    Array.isArray(v.sources) &&
    v.sources.every(
      (row) =>
        row &&
        typeof row.id === 'string' &&
        typeof row.assetKey === 'string' &&
        typeof row.support === 'boolean' &&
        bounds(row.bounds) &&
        vector(row.matrix, 16) &&
        isUsableAffineMatrix(row.matrix) &&
        (!row.door ||
          (vector(row.door.hingePosition, 3) &&
            vector(row.door.closedTip, 3) &&
            vector(row.door.hingeAxis, 3) &&
            Number.isFinite(row.door.radius) &&
            row.door.radius > 0 &&
            Number.isFinite(row.door.openAngle) &&
            row.doorAddress &&
            typeof row.doorAddress.path === 'string' &&
            Number.isSafeInteger(row.doorAddress.expressId))),
    ) &&
    strings(v.unknown) &&
    strings(v.unavailable) &&
    Array.isArray(v.approaches) &&
    v.approaches.every((a) => a && vector(a.point, 3) && Number.isFinite(a.yaw))
  );
}
// Validate serialized BVH topology and buffer lengths, without rereading vertex coordinates.
export function usableAsset(a: PatrolAsset | undefined): a is PatrolAsset {
  if (
    !a ||
    !(a.vertices instanceof Float64Array) ||
    !(a.order instanceof Uint32Array) ||
    !a.order.length ||
    a.vertices.length !== a.order.length * 9 ||
    !Array.isArray(a.nodes) ||
    !a.nodes.length
  )
    return false;
  const nodes = a.nodes;
  if (nodes[0]?.start !== 0 || nodes[0]?.end !== a.order.length) return false;
  return nodes.every((n, i) => {
    if (
      !n ||
      !bounds(n.bounds) ||
      !Number.isSafeInteger(n.start) ||
      !Number.isSafeInteger(n.end) ||
      n.start < 0 ||
      n.end > a.order.length ||
      n.start >= n.end
    )
      return false;
    if (n.left === undefined) return n.right === undefined;
    const l = n.left,
      r = n.right;
    return (
      Number.isSafeInteger(l) &&
      r !== undefined &&
      Number.isSafeInteger(r) &&
      i < l &&
      l < r &&
      r < nodes.length &&
      nodes[l]?.start === n.start &&
      nodes[l]?.end === nodes[r]?.start &&
      nodes[r]?.end === n.end
    );
  });
}
