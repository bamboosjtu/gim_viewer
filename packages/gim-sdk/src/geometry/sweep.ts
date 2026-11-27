import type { Point3 } from "./analysisGeometry.js";
import type { GeometryLimits } from "./primitiveContracts.js";
import { checkGeometryBudget } from "./geometryBudget.js";
import { invalidShape, type MeshBuild } from "./profiles.js";

export const add3 = (a: Point3, b: Point3): Point3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub3 = (a: Point3, b: Point3): Point3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const mul3 = (a: Point3, s: number): Point3 => [
  a[0] * s,
  a[1] * s,
  a[2] * s,
];
export const dot3 = (a: Point3, b: Point3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Point3, b: Point3): Point3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const unit3 = (a: Point3): Point3 => mul3(a, 1 / Math.hypot(...a));
export interface SweepFrame {
  center: Point3;
  tangent: Point3;
  radial?: Point3;
  radialScale?: number;
}
export function pathFrames(points: Point3[]): SweepFrame[] {
  return points.map((center, i) => {
    const before = i ? unit3(sub3(center, points[i - 1])) : undefined,
      after =
        i + 1 < points.length ? unit3(sub3(points[i + 1], center)) : undefined;
    return {
      center,
      tangent:
        before && after
          ? unit3(add3(before, after))
          : (before ?? after ?? [0, 0, 0]),
    };
  });
}
/** Indexed rings with a transported normal frame. End caps have independent normals. */
export function sweepTube(
  frames: SweepFrame[],
  radius: number,
  closed: boolean,
  sides: number,
  limits?: Partial<GeometryLimits>,
): MeshBuild {
  const rings = frames.length,
    spans = closed ? rings : rings - 1,
    vertices = rings * sides + (closed ? 0 : 2 * (sides + 1));
  const budget = checkGeometryBudget(
    { maxVertices: vertices, maxCurveSegments: spans },
    limits,
  );
  if (budget) return budget;
  if (rings < 2 || !(radius > 0 && Number.isFinite(radius)))
    return invalidShape("Invalid tube path or radius");
  const positions = new Float32Array(3 * vertices),
    normals = new Float32Array(positions.length),
    indices =
      vertices <= 65536
        ? new Uint16Array((spans * 2 + (closed ? 0 : 2)) * sides * 3)
        : new Uint32Array((spans * 2 + (closed ? 0 : 2)) * sides * 3);
  let radial: Point3 = [1, 0, 0],
    cursor = 0;
  for (let i = 0; i < rings; i++) {
    const frame = frames[i],
      t = unit3(frame.tangent);
    if (!t.every(Number.isFinite))
      return invalidShape("Undefined tube tangent");
    if (frame.radial) radial = frame.radial;
    radial = sub3(radial, mul3(t, dot3(radial, t)));
    if (Math.hypot(...radial) < 1e-10)
      radial = cross3(t, Math.abs(t[2]) < 0.8 ? [0, 0, 1] : [0, 1, 0]);
    radial = unit3(radial);
    const binormal = cross3(radial, t);
    for (let j = 0; j < sides; j++) {
      const id = i * sides + j,
        angle = (2 * Math.PI * j) / sides,
        c = Math.cos(angle),
        s = Math.sin(angle);
      const n = add3(mul3(radial, c), mul3(binormal, s));
      const point = add3(
        frame.center,
        mul3(
          add3(mul3(radial, c * (frame.radialScale ?? 1)), mul3(binormal, s)),
          radius,
        ),
      );
      if (!point.every((v) => Number.isFinite(Math.fround(v))))
        return invalidShape("Tube exceeds Float32 coordinate range");
      positions.set(point, id * 3);
      normals.set(n, id * 3);
      if (i < spans) {
        const next = ((i + 1) % rings) * sides,
          other = (j + 1) % sides;
        indices.set(
          [id, next + j, next + other, id, next + other, i * sides + other],
          cursor,
        );
        cursor += 6;
      }
    }
  }
  if (!closed)
    for (const end of [0, 1]) {
      const i = end ? rings - 1 : 0,
        offset = rings * sides + end * (sides + 1),
        center = offset + sides,
        n = mul3(unit3(frames[i].tangent), end ? 1 : -1);
      positions.set(frames[i].center, 3 * center);
      normals.set(n, 3 * center);
      for (let j = 0; j < sides; j++) {
        const id = (i * sides + j) * 3;
        positions.set(positions.subarray(id, id + 3), (offset + j) * 3);
        normals.set(n, (offset + j) * 3);
        const next = (j + 1) % sides;
        indices.set(
          [center, offset + (end ? next : j), offset + (end ? j : next)],
          cursor,
        );
        cursor += 3;
      }
    }
  return { positions, normals, indices };
}
