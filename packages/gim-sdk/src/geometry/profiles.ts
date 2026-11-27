import earcut from "earcut";
import type { Point3 } from "./analysisGeometry.js";
import { checkGeometryBudget } from "./geometryBudget.js";
import type {
  GeometryDiagnostic,
  GeometryLimits,
  MeshData,
} from "./primitiveContracts.js";

export type MeshBuild = MeshData | GeometryDiagnostic;
export const invalidShape = (message: string): GeometryDiagnostic => ({
  code: "invalid-geometry",
  severity: "error",
  stage: "compile",
  message,
});
const sub = (a: Point3, b: Point3): Point3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const cross = (a: Point3, b: Point3): Point3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Point3, b: Point3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Point3, k: number): Point3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Point3): Point3 => scale(a, 1 / Math.hypot(...a));
type P2 = [number, number];
const orient = (a: P2, b: P2, c: P2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Compare only edges with overlapping projected intervals. Adjacent edges may share one endpoint. */
function simpleRing(points: P2[]): boolean {
  const edges = points
    .map((a, i) => {
      const b = points[(i + 1) % points.length];
      return {
        a,
        b,
        i,
        x0: Math.min(a[0], b[0]),
        x1: Math.max(a[0], b[0]),
        y0: Math.min(a[1], b[1]),
        y1: Math.max(a[1], b[1]),
      };
    })
    .sort((a, b) => a.x0 - b.x0);
  let active: typeof edges = [];
  for (const edge of edges) {
    active = active.filter((other) => other.x1 >= edge.x0);
    for (const other of active) {
      if (edge.y1 < other.y0 || other.y1 < edge.y0) continue;
      const gap = Math.abs(edge.i - other.i);
      if (gap === 1 || gap === points.length - 1) continue;
      const a = Math.sign(orient(edge.a, edge.b, other.a)),
        b = Math.sign(orient(edge.a, edge.b, other.b));
      const c = Math.sign(orient(other.a, other.b, edge.a)),
        d = Math.sign(orient(other.a, other.b, edge.b));
      if (a * b <= 0 && c * d <= 0) return false;
    }
    active.push(edge);
  }
  return true;
}

export function rectangle(
  length: number,
  width: number,
  z: number,
  x = 0,
  y = 0,
): Point3[] {
  return [
    [x - length / 2, y - width / 2, z],
    [x + length / 2, y - width / 2, z],
    [x + length / 2, y + width / 2, z],
    [x - length / 2, y + width / 2, z],
  ];
}

/** Parallel planar caps with corresponding boundary vertices. The first ring is the shell. */
export function loftRings(
  bottom: Point3[][],
  top: Point3[][],
  limits?: Partial<GeometryLimits>,
  validateContour = false,
): MeshBuild {
  const count = bottom.reduce((n, r) => n + r.length, 0);
  const budget = checkGeometryBudget(
    { maxVertices: 6 * count, maxHoles: bottom.length - 1 },
    limits,
  );
  if (budget) return budget;
  const ring = bottom[0];
  if (
    !ring ||
    ring.length < 3 ||
    bottom.length !== top.length ||
    bottom.some((r, i) => r.length < 3 || r.length !== top[i].length)
  )
    return invalidShape("Invalid loft boundaries");
  if (
    [bottom, top].some((rings) =>
      rings.some((r) =>
        r.some((p) => p.some((v) => !Number.isFinite(Math.fround(v)))),
      ),
    )
  )
    return invalidShape("Profile exceeds Float32 coordinate range");
  const origin = ring[0];
  let area: Point3 = [0, 0, 0],
    extent = 0;
  for (let i = 0; i < ring.length; i++) {
    const v = sub(ring[i], origin),
      w = sub(ring[(i + 1) % ring.length], origin);
    const n = cross(v, w);
    area = [area[0] + n[0], area[1] + n[1], area[2] + n[2]];
    extent = Math.max(extent, Math.hypot(...v));
  }
  if (!(Math.hypot(...area) > 0))
    return invalidShape("Contour has no oriented area");
  let normal = unit(area);
  const separation = dot(normal, sub(top[0][0], origin));
  if (!Number.isFinite(separation) || separation === 0)
    return invalidShape("Extrusion has zero normal height");
  if (separation < 0) normal = scale(normal, -1);
  const u = unit(
      cross(Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0], normal),
    ),
    v = cross(normal, u);
  const project = (p: Point3): P2 => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)];
  };
  if (validateContour) {
    const tolerance = 64 * Number.EPSILON * extent * ring.length;
    if (ring.some((p) => Math.abs(dot(sub(p, origin), normal)) > tolerance))
      return invalidShape("Contour is not coplanar");
    if (!simpleRing(ring.map(project)))
      return invalidShape("Contour intersects itself");
  }
  const positions = new Float32Array(count * 6 * 3),
    normals = new Float32Array(positions.length);
  const triangles: number[] = [];
  let vertex = 0;
  const push = (point: Point3, n: Point3) => {
    positions.set(point, vertex * 3);
    normals.set(n, vertex * 3);
    return vertex++;
  };
  const cap = (rings: Point3[][], upper: boolean) => {
    const flat: number[] = [],
      holes: number[] = [];
    const start = vertex;
    for (let i = 0; i < rings.length; i++) {
      if (i) holes.push(vertex - start);
      for (const p of rings[i]) {
        flat.push(...project(p));
        push(p, upper ? normal : scale(normal, -1));
      }
    }
    const idx = earcut(flat, holes, 2);
    for (let i = 0; i < idx.length; i += 3)
      triangles.push(
        start + idx[i],
        start + idx[i + (upper ? 1 : 2)],
        start + idx[i + (upper ? 2 : 1)],
      );
    return idx.length > 0;
  };
  if (!cap(bottom, false) || !cap(top, true))
    return invalidShape("Cap triangulation produced no faces");
  for (const [k, loop] of bottom.entries()) {
    const uv = loop.map(project);
    const signed = uv.reduce((s, a, i) => {
      const b = uv[(i + 1) % uv.length];
      return s + a[0] * b[1] - a[1] * b[0];
    }, 0);
    const forward = k === 0 ? signed > 0 : signed < 0;
    for (let j = 0; j < loop.length; j++) {
      const next = (j + 1) % loop.length,
        i = forward ? j : next,
        h = forward ? next : j;
      const face = cross(sub(loop[h], loop[i]), sub(top[k][i], loop[i]));
      if (!(Math.hypot(...face) > 0))
        return invalidShape("Degenerate side face");
      const n = unit(face);
      const a = push(loop[i], n),
        b = push(loop[h], n),
        c = push(top[k][h], n),
        d = push(top[k][i], n);
      triangles.push(a, b, c, a, c, d);
    }
  }
  return {
    positions,
    normals,
    indices:
      vertex <= 65536
        ? Uint16Array.from(triangles)
        : Uint32Array.from(triangles),
  };
}
