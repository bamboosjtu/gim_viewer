import { Box3, Line3, Matrix4, Plane, Triangle, Vector3 } from 'three';
import type { PatrolPart } from '../navigationQueryPort.js';
import { patrolProfile as profile } from '../navigationQueryPort.js';

import type {
  PatrolBounds as Bounds,
  PatrolBranch as Branch,
  PatrolAsset,
} from '../../../shared/patrolSpatialAsset.js';
export type { PatrolAsset } from '../../../shared/patrolSpatialAsset.js';
const v = () => new Vector3();
const tuple = (b: Box3): Bounds => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];

/** Worker-owned construction. The serialized nodes and indices are directly queryable on warm entry. */
export function buildPatrolAsset(parts: PatrolPart[]): PatrolAsset {
  const count = parts.reduce((sum, p) => sum + p.indices.length, 0);
  if (!count || count % 3) throw Error('来源三角形不完整');
  const vertices = new Float64Array(count * 3),
    order = new Uint32Array(count / 3);
  const centers = new Float64Array(count),
    nodes: Branch[] = [];
  const point = v();
  let offset = 0;
  for (const part of parts) {
    const matrix = new Matrix4().fromArray(part.matrix);
    const mirror = matrix.determinant() < 0;
    for (let i = 0; i < part.indices.length; i++) {
      const index = part.indices[mirror && i % 3 ? (i % 3 === 1 ? i + 1 : i - 1) : i];
      point.fromArray(part.positions, index * 3).applyMatrix4(matrix);
      if (!Number.isFinite(point.x + point.y + point.z)) throw Error('来源顶点不可用');
      point.toArray(vertices, offset);
      offset += 3;
    }
  }
  for (let i = 0; i < order.length; i++) {
    order[i] = i;
    for (let axis = 0; axis < 3; axis++)
      centers[i * 3 + axis] =
        (vertices[i * 9 + axis] + vertices[i * 9 + axis + 3] + vertices[i * 9 + axis + 6]) / 3;
  }
  function split(start: number, end: number): number {
    const box = new Box3(),
      id = nodes.length;
    for (let i = start; i < end; i++)
      for (let j = 0; j < 9; j += 3) box.expandByPoint(point.fromArray(vertices, order[i] * 9 + j));
    const node: Branch = { bounds: tuple(box), start, end };
    nodes.push(node);
    if (end - start > 12) {
      const size = box.getSize(point),
        axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
      order.subarray(start, end).sort((a, b) => centers[a * 3 + axis] - centers[b * 3 + axis]);
      const mid = (start + end) >>> 1;
      node.left = split(start, mid);
      node.right = split(mid, end);
    }
    return id;
  }
  split(0, order.length);
  const previewShapes = [...new Set(parts.flatMap((p) => p.previewShapes ?? []))];
  return { vertices, order, nodes, ...(previewShapes.length ? { previewShapes } : {}) };
}

export interface PlacedAsset {
  id: string;
  matrix: Matrix4;
  inverse: Matrix4;
  mirror: boolean;
  support: boolean;
  asset: PatrolAsset;
}
export function visitTriangles(
  row: PlacedAsset,
  world: Box3,
  visit: (t: Triangle, index: number) => boolean,
): boolean {
  const q = world.clone().applyMatrix4(row.inverse),
    stack = [0],
    triangle = new Triangle();
  const { vertices, order, nodes } = row.asset;
  while (stack.length) {
    const n = nodes[stack.pop()!],
      b = n.bounds;
    if (
      q.max.x < b[0] ||
      q.max.y < b[1] ||
      q.max.z < b[2] ||
      q.min.x > b[3] ||
      q.min.y > b[4] ||
      q.min.z > b[5]
    )
      continue;
    if (n.left !== undefined) {
      stack.push(n.left, n.right!);
      continue;
    }
    for (let i = n.start; i < n.end; i++) {
      const off = order[i] * 9;
      triangle.a.fromArray(vertices, off).applyMatrix4(row.matrix);
      triangle.b.fromArray(vertices, off + (row.mirror ? 6 : 3)).applyMatrix4(row.matrix);
      triangle.c.fromArray(vertices, off + (row.mirror ? 3 : 6)).applyMatrix4(row.matrix);
      if (visit(triangle, order[i])) return true;
    }
  }
  return false;
}

const epsilon = 1e-5;
const minUp = Math.cos((profile.maxSlopeDegrees * Math.PI) / 180);
export function supportHeight(
  t: Triangle,
  p: Vector3,
  stepDown: number = profile.stepDown,
  stepUp: number = profile.stepUp,
): number | undefined {
  const normal = t.getNormal(v());
  if (normal.z < minUp) return;
  const z = t.a.z - ((p.x - t.a.x) * normal.x + (p.y - t.a.y) * normal.y) / normal.z;
  if (z < p.z - stepDown - epsilon || z > p.z + stepUp + epsilon) return;
  const bary = t.getBarycoord(new Vector3(p.x, p.y, z), v());
  if (bary && Math.min(bary.x, bary.y, bary.z) >= -epsilon) return z;
}

/** Clip the horizontal path to each source tread. A positive gap, even between two
 * supported endpoints, has no supporting floor and must not be bridged by a tick. */
export function supportedInterval(
  t: Triangle,
  from: Vector3,
  to: Vector3,
): [number, number] | null {
  const n = t.getNormal(v());
  if (n.z < minUp) return null;
  const relative = (p: Vector3) =>
    t.getBarycoord(
      new Vector3(p.x, p.y, t.a.z - ((p.x - t.a.x) * n.x + (p.y - t.a.y) * n.y) / n.z),
      v(),
    );
  const a = relative(from),
    b = relative(to);
  if (!a || !b) return null;
  let start = 0,
    end = 1;
  const clip = (x: number, y: number) => {
    if (x < 0 && y < 0) return false;
    if (x < 0) start = Math.max(start, -x / (y - x));
    else if (y < 0) end = Math.min(end, x / (x - y));
    return start <= end;
  };
  for (const k of ['x', 'y', 'z'] as const) if (!clip(a[k] + 1e-9, b[k] + 1e-9)) return null;
  const za = t.a.z - ((from.x - t.a.x) * n.x + (from.y - t.a.y) * n.y) / n.z - from.z;
  const zb = t.a.z - ((to.x - t.a.x) * n.x + (to.y - t.a.y) * n.y) / n.z - from.z;
  return clip(za + profile.stepDown, zb + profile.stepDown) &&
    clip(profile.stepUp - za, profile.stepUp - zb)
    ? [start, end]
    : null;
}

/** Minimum distance between two finite segments, including parallel/degenerate cases. */
function segmentDistance(a: Vector3, b: Vector3, c: Vector3, d: Vector3) {
  const u = b.clone().sub(a),
    w = d.clone().sub(c),
    delta = a.clone().sub(c);
  const A = u.lengthSq(),
    B = u.dot(w),
    C = w.lengthSq(),
    D = u.dot(delta),
    E = w.dot(delta);
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const den = A * C - B * B;
  let s = den > 1e-14 ? clamp((B * E - C * D) / den) : 0;
  const t = C > 1e-14 ? clamp((B * s + E) / C) : 0;
  s = A > 1e-14 ? clamp((B * t - D) / A) : 0;
  return delta.addScaledVector(u, s).addScaledVector(w, -t).lengthSq();
}
function segmentTriangle(a: Vector3, b: Vector3, t: Triangle): number {
  const plane = t.getPlane(new Plane());
  const hit = plane.intersectLine(new Line3(a, b), v());
  if (hit && t.containsPoint(hit)) return 0;
  return Math.min(
    t.closestPointToPoint(a, v()).distanceToSquared(a),
    t.closestPointToPoint(b, v()).distanceToSquared(b),
    segmentDistance(a, b, t.a, t.b),
    segmentDistance(a, b, t.b, t.c),
    segmentDistance(a, b, t.c, t.a),
  );
}

export function triangleDistanceSquared(a: Triangle, b: Triangle): number {
  let best = Infinity;
  for (const [p, q] of [
    [a, b],
    [b, a],
  ])
    for (const [u, v] of [
      [p.a, p.b],
      [p.b, p.c],
      [p.c, p.a],
    ])
      best = Math.min(best, segmentTriangle(u, v, q));
  return best;
}
/** At a step, the capsule travels vertically at the lower endpoint and horizontally at the upper level. */
export function bodyHits(t: Triangle, from: Vector3, to: Vector3, padding = 0): boolean {
  const r = profile.radius,
    lower = Math.min(from.z, to.z),
    upper = Math.max(from.z, to.z);
  const lo = upper + r + epsilon;
  const hi = upper + profile.height - r;
  const limit = (r + padding - epsilon) ** 2;
  if (
    Math.max(t.a.z, t.b.z, t.c.z) <= lower + epsilon - padding ||
    Math.min(t.a.z, t.b.z, t.c.z) >= hi + r + padding
  )
    return false;
  if (upper > lower) {
    const foot = from.z < to.z ? from : to;
    if (segmentTriangle(foot.clone().setZ(lower + r + epsilon), foot.clone().setZ(hi), t) < limit)
      return true;
  }
  const a = new Vector3(from.x, from.y, lo),
    b = new Vector3(to.x, to.y, lo);
  const c = b.clone().setZ(hi),
    d = a.clone().setZ(hi);
  if (
    Math.max(t.a.z, t.b.z, t.c.z) <= lo - r - padding ||
    Math.min(t.a.z, t.b.z, t.c.z) >= hi + r + padding
  )
    return false;
  if (segmentTriangle(a, d, t) < limit) return true;
  if (a.distanceToSquared(b) < epsilon ** 2) return false;
  for (const edge of [
    [a, b],
    [b, c],
    [c, d],
  ])
    if (segmentTriangle(edge[0], edge[1], t) < limit) return true;
  const faces = [new Triangle(a, b, c), new Triangle(a, c, d)];
  for (const face of faces)
    for (const edge of [
      [t.a, t.b],
      [t.b, t.c],
      [t.c, t.a],
    ])
      if (segmentTriangle(edge[0], edge[1], face) < limit) return true;
  return false;
}
