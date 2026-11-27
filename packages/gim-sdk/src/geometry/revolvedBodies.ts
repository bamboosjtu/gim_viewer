import type {
  AnalysisGeometry,
  GeometryPort,
  Point3,
} from "./analysisGeometry.js";
import type { GeometryCompileOptions, MeshData } from "./primitiveContracts.js";
import { checkGeometryBudget } from "./geometryBudget.js";
import { invalidShape, type MeshBuild } from "./profiles.js";
import { add3, sub3, mul3, unit3, cross3 } from "./sweep.js";
import type { StandardFields } from "./standardFields.js";

export const BODY_TAGS = [
  "RotationalEllipsoid",
  "PorcelainBushing",
  "ConePorcelainBushing",
  "Insulator",
  "VTypeInsulator",
] as const;
type BodyTag = (typeof BODY_TAGS)[number];
type Skirts = { r1: number; r2: number; count: number };
type StringFields = Skirts & {
  r: number;
  pitch: number;
  front: number;
  rear: number;
  split: number;
};
type Body =
  | {
      kind: "RotationalEllipsoid";
      polar: number;
      equatorial: number;
      height: number;
    }
  | ({ kind: "PorcelainBushing"; height: number; r: number } & Skirts)
  | {
      kind: "ConePorcelainBushing";
      height: number;
      base: number;
      top: number;
      base1: number;
      top1: number;
      base2: number;
      top2: number;
      count: number;
    }
  | ({ kind: "Insulator"; strings: number; spacing: number } & StringFields)
  | ({
      kind: "VTypeInsulator";
      frontSpacing: number;
      rearSpacing: number;
    } & StringFields);
export type BodyPrimitive = Body & { family: "body"; approximation?: string };

export function readBody(kind: BodyTag, f: StandardFields): BodyPrimitive {
  const n = (k: string) => f.number(k);
  if (kind === "RotationalEllipsoid") {
    const polar = n("LR"),
      equatorial = n("WR"),
      height = n("H");
    if (height > 2 * polar) f.fail("H", "H exceeds full polar diameter");
    return {
      kind,
      family: "body",
      polar,
      equatorial,
      height,
      ...(height === 2 * polar && polar !== equatorial
        ? {}
        : {
            approximation:
              "Cut retains the +X pole as in figure B.2; other cut conventions remain unverified",
          }),
    };
  }
  let body: Body;
  if (kind === "ConePorcelainBushing") {
    const base = n("BR"),
      top = n("TR"),
      base1 = n("BR1"),
      base2 = n("BR2"),
      top1 = n("TR1"),
      top2 = n("TR2");
    if (Math.min(base1, base2, top1, top2) <= top)
      f.fail("TR", "Table B.22 requires skirt radii greater than TR");
    body = {
      kind,
      base,
      top,
      base1,
      top1,
      base2,
      top2,
      height: n("H"),
      count: f.integer("N"),
    };
  } else {
    const r = n("R"),
      r1 = n("R1"),
      r2 = n("R2");
    if (Math.min(r1, r2) <= r)
      f.fail("R", "Skirts must extend beyond the body");
    if (kind === "PorcelainBushing")
      body = { kind, r, r1, r2, height: n("H"), count: f.integer("N") };
    else {
      const shared = {
        r,
        r1,
        r2,
        count: f.integer("N1"),
        pitch: n("H1"),
        front: n("FL"),
        rear: n("AL"),
        split: f.integer("LN"),
      };
      if (kind === "Insulator") {
        const strings = f.integer("N");
        // Table B.23 defines D as the distance between strings. A single leg is centred at Y=0.
        const spacing = f.number("D", false, strings === 1 ? 0 : undefined);
        if (strings === 1 && spacing < 0)
          f.fail("D", "Spacing cannot be negative");
        if (strings > 1 && spacing <= 2 * r1)
          f.fail("D", "Insufficient double-string spacing");
        body = { kind, ...shared, strings, spacing };
      } else {
        const frontSpacing = n("X"),
          rearSpacing = n("AD");
        if (
          Math.abs(frontSpacing - rearSpacing) / 2 >=
          shared.front + shared.count * shared.pitch + shared.rear
        )
          f.fail(
            "AD",
            "Branch length cannot span the declared attachment offsets",
          );
        body = { kind, ...shared, frontSpacing, rearSpacing };
      }
    }
  }
  return {
    ...body,
    family: "body",
    approximation:
      kind === "Insulator" || kind === "VTypeInsulator"
        ? "String ports use declared spacing and axial lengths; connectors, skirt profiles and split-wire attachments are schematic"
        : "Skirt edge radii and count are declared; intermediate skirt thickness and profile are schematic",
  };
}
type Station = {
  s: number;
  r: number;
  axialNormal?: number;
  radialNormal?: number;
};
type Leg = { start: Point3; end: Point3; direction: Point3; length: number };
type StringBody = Extract<Body, { pitch: number }>;
function legs(p: StringBody): Leg[] {
  if (p.kind === "Insulator" && p.strings > 2) return [];
  const length = p.front + p.pitch * p.count + p.rear;
  const startGap = p.kind === "Insulator" ? p.spacing : p.frontSpacing,
    endGap = p.kind === "Insulator" ? p.spacing : p.rearSpacing;
  const offsets = p.kind === "Insulator" && p.strings === 1 ? [0] : [-0.5, 0.5];
  return offsets.map((k) => {
    const start: Point3 = [0, k * startGap, 0],
      end: Point3 = [
        Math.sqrt(length * length - (k * (endGap - startGap)) ** 2),
        k * endGap,
        0,
      ];
    return { start, end, length, direction: unit3(sub3(end, start)) };
  });
}
function revolve(
  stations: Station[],
  start: Point3,
  axis: Point3,
  sides: number,
  options: GeometryCompileOptions,
): MeshBuild {
  // Independent ring normals at each shoulder, one vertex at an actual pole.
  const ringCount = (s: Station) => (s.r === 0 ? 1 : sides);
  let vertices = 0;
  for (let i = 1; i < stations.length; i++)
    vertices += ringCount(stations[i - 1]) + ringCount(stations[i]);
  for (const s of [stations[0], stations[stations.length - 1]])
    if (s.r > 0) vertices += sides + 1;
  const limit = checkGeometryBudget({ maxVertices: vertices }, options.limits);
  if (limit) return limit;
  const positions = new Float32Array(vertices * 3),
    normals = new Float32Array(positions.length),
    triangles: number[] = [];
  const u = unit3(
      cross3(Math.abs(axis[1]) < 0.8 ? [0, 1, 0] : [0, 0, 1], axis),
    ),
    v = cross3(axis, u);
  const rays = Array.from({ length: sides }, (_, i) =>
    add3(
      mul3(u, Math.cos((2 * Math.PI * i) / sides)),
      mul3(v, Math.sin((2 * Math.PI * i) / sides)),
    ),
  );
  let cursor = 0;
  function ring(s: Station, nz: number, nr: number) {
    const begin = cursor,
      center = add3(start, mul3(axis, s.s));
    for (let j = 0; j < ringCount(s); j++) {
      const ray = rays[j];
      positions.set(add3(center, mul3(ray, s.r)), 3 * cursor);
      normals.set(unit3(add3(mul3(axis, nz), mul3(ray, nr))), 3 * cursor);
      cursor++;
    }
    return begin;
  }
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1],
      b = stations[i],
      ds = b.s - a.s,
      dr = b.r - a.r;
    if (ds === 0 && dr === 0)
      return invalidShape("Duplicate revolution station");
    const low = ring(a, a.axialNormal ?? -dr, a.radialNormal ?? ds),
      high = ring(b, b.axialNormal ?? -dr, b.radialNormal ?? ds);
    for (let j = 0; j < sides; j++) {
      const k = (j + 1) % sides;
      if (a.r > 0) triangles.push(low + j, low + k, high + (b.r ? k : 0));
      if (b.r > 0) triangles.push(low + (a.r ? j : 0), high + k, high + j);
    }
  }
  for (const end of [false, true]) {
    const s = stations[end ? stations.length - 1 : 0];
    if (s.r === 0) continue;
    const dir = end ? 1 : -1,
      edge = ring(s, dir, 0),
      center = cursor++;
    positions.set(add3(start, mul3(axis, s.s)), 3 * center);
    normals.set(mul3(axis, dir), 3 * center);
    for (let j = 0; j < sides; j++) {
      const k = (j + 1) % sides;
      triangles.push(center, edge + (end ? j : k), edge + (end ? k : j));
    }
  }
  return {
    positions,
    normals,
    indices:
      vertices <= 65536
        ? Uint16Array.from(triangles)
        : Uint32Array.from(triangles),
  };
}
function porcelainProfile(
  height: number,
  count: number,
  base: number,
  top: number,
  base1: number,
  top1: number,
  base2: number,
  top2: number,
  outline: boolean,
): Station[] {
  const stations: Station[] = [{ s: 0, r: base }];
  if (!outline)
    for (let i = 0; i < count; i++) {
      const alpha = count === 1 ? 0.5 : i / (count - 1),
        mix = (a: number, b: number) => a + (b - a) * alpha;
      for (const [fraction, edge] of [
        [0.06, 0],
        [0.12, mix(base1, top1)],
        [0.4, 0],
        [0.55, 0],
        [0.62, mix(base2, top2)],
        [0.9, 0],
      ]) {
        const t = (i + fraction) / count;
        stations.push({ s: height * t, r: edge || base + (top - base) * t });
      }
    }
  stations.push({ s: height, r: top });
  return stations;
}
export function bodyMesh(
  p: BodyPrimitive,
  n: number,
  options: GeometryCompileOptions,
): MeshBuild {
  if ("count" in p && (!Number.isSafeInteger(p.count) || p.count < 1))
    return invalidShape("Invalid repetition count");
  if (
    p.kind === "Insulator" &&
    (!Number.isSafeInteger(p.strings) || p.strings < 1)
  )
    return invalidShape("Invalid string count");
  if (
    p.kind === "VTypeInsulator" &&
    Math.abs(p.rearSpacing - p.frontSpacing) / 2 >=
      p.front + p.count * p.pitch + p.rear
  )
    return invalidShape("Invalid V branch reach");
  const range = bodyAnalysis(p).range;
  if (
    range.coverage === "conservative" &&
    [...range.bounds.min, ...range.bounds.max].some(
      (v) => !Number.isFinite(Math.fround(v)),
    )
  )
    return invalidShape("Body exceeds Float32 coordinate range");
  if (p.kind === "RotationalEllipsoid") {
    const from = p.polar - p.height,
      theta = Math.acos(Math.max(-1, Math.min(1, from / p.polar)));
    const axial = [4, 6, 8][options.lod ?? 2];
    const angles = Array.from(
      { length: axial + 1 },
      (_, i) => theta * (1 - i / axial),
    );
    if (
      theta > Math.PI / 2 &&
      !angles.some((a) => Math.abs(a - Math.PI / 2) < 1e-14)
    )
      angles.push(Math.PI / 2);
    const stations = angles
      .sort((a, b) => b - a)
      .map((a) => {
        const x = Math.cos(a),
          r = a === 0 || a === Math.PI ? 0 : Math.sin(a);
        return {
          s: p.polar * x,
          r: p.equatorial * r,
          axialNormal: x / p.polar,
          radialNormal: r / p.equatorial,
        };
      });
    return revolve(
      stations,
      [0, 0, 0],
      [1, 0, 0],
      [8, 12, 16][options.lod ?? 2],
      options,
    );
  }
  const outline = options.lod === 0,
    branches =
      p.kind === "Insulator" ? p.strings : p.kind === "VTypeInsulator" ? 2 : 1;
  if (branches > 2)
    return {
      code: "unverified-layout",
      severity: "warning",
      stage: "compile",
      message: "B.23 layout for more than two strings awaits evidence",
    };
  if (!outline && p.count > 512)
    return {
      code: "capacity-exceeded",
      severity: "error",
      stage: "compile",
      message: "Detailed skirt count exceeds the existing 512-period limit",
    };
  const isString = p.kind === "Insulator" || p.kind === "VTypeInsulator";
  // Two rings per segment plus two independent cap rings. Check before building a repeated profile.
  const segmentCount = (outline ? 1 : 6 * p.count + 1) + (isString ? 4 : 0);
  const budget = checkGeometryBudget(
    { maxVertices: branches * (2 * n * segmentCount + 2 * (n + 1)) },
    options.limits,
  );
  if (budget) return budget;
  if (p.kind === "PorcelainBushing" || p.kind === "ConePorcelainBushing") {
    const profile =
      p.kind === "PorcelainBushing"
        ? porcelainProfile(
            p.height,
            p.count,
            p.r,
            p.r,
            p.r1,
            p.r1,
            p.r2,
            p.r2,
            outline,
          )
        : porcelainProfile(
            p.height,
            p.count,
            p.base,
            p.top,
            p.base1,
            p.top1,
            p.base2,
            p.top2,
            outline,
          );
    return revolve(profile, [0, 0, 0], [0, 0, 1], n, options);
  }
  const shape = porcelainProfile(
    p.pitch * p.count,
    p.count,
    p.r,
    p.r,
    p.r1,
    p.r1,
    p.r2,
    p.r2,
    outline,
  ).map((s) => ({ s: s.s + p.front, r: s.r }));
  const rod = p.r / 4,
    end = p.front + p.pitch * p.count + p.rear;
  const whole = [
    { s: 0, r: rod },
    { s: p.front, r: rod },
    ...shape,
    { s: end - p.rear, r: rod },
    { s: end, r: rod },
  ];
  const branchesMesh: MeshData[] = [];
  for (const leg of legs(p)) {
    const m = revolve(whole, leg.start, leg.direction, n, options);
    if ("code" in m) return m;
    branchesMesh.push(m);
  }
  if (branchesMesh.length === 1) return branchesMesh[0];
  const [a, b] = branchesMesh,
    positions = new Float32Array(a.positions.length + b.positions.length),
    normals = new Float32Array(positions.length);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);
  normals.set(a.normals);
  normals.set(b.normals, a.normals.length);
  const indices =
    positions.length / 3 <= 65536
      ? new Uint16Array(a.indices!.length + b.indices!.length)
      : new Uint32Array(a.indices!.length + b.indices!.length);
  indices.set(a.indices!);
  for (let i = 0; i < b.indices!.length; i++)
    indices[i + a.indices!.length] = a.positions.length / 3 + b.indices![i];
  return { positions, normals, indices };
}
export function bodyAnalysis(p: BodyPrimitive): AnalysisGeometry {
  let min: Point3, max: Point3;
  const ports: GeometryPort[] = [];
  const port = (
    name: string,
    position: Point3,
    direction: Point3,
    estimated = false,
  ) =>
    ports.push({
      name,
      position,
      direction,
      unit: "mm",
      quality: estimated ? "estimated" : "standard-derived",
    });
  if (p.kind === "RotationalEllipsoid") {
    const x = p.polar - p.height,
      r =
        x <= 0
          ? p.equatorial
          : p.equatorial * Math.sqrt(1 - (x / p.polar) ** 2);
    min = [x, -r, -r];
    max = [p.polar, r, r];
    port("cut", [x, 0, 0], [-1, 0, 0]);
    port("pole", [p.polar, 0, 0], [1, 0, 0]);
  } else if (
    p.kind === "PorcelainBushing" ||
    p.kind === "ConePorcelainBushing"
  ) {
    const r =
      p.kind === "PorcelainBushing"
        ? Math.max(p.r, p.r1, p.r2)
        : Math.max(p.base, p.top, p.base1, p.top1, p.base2, p.top2);
    min = [-r, -r, 0];
    max = [r, r, p.height];
    port("base", [0, 0, 0], [0, 0, -1]);
    port("top", [0, 0, p.height], [0, 0, 1]);
  } else {
    const paths = legs(p);
    if (!paths.length) return { range: { coverage: "unknown" }, ports: [] };
    min = [Infinity, Infinity, Infinity];
    max = [-Infinity, -Infinity, -Infinity];
    for (const [i, leg] of paths.entries()) {
      port(
        "frame-" + (i + 1),
        leg.start,
        mul3(leg.direction, -1),
        p.kind === "VTypeInsulator",
      );
      port(
        "wire-" + (i + 1),
        leg.end,
        leg.direction,
        p.kind === "VTypeInsulator",
      );
      for (const k of [0, 1, 2] as const) {
        const radial =
          Math.max(p.r1, p.r2) *
          Math.sqrt(Math.max(0, 1 - leg.direction[k] ** 2));
        min[k] = Math.min(min[k], leg.start[k] - radial, leg.end[k] - radial);
        max[k] = Math.max(max[k], leg.start[k] + radial, leg.end[k] + radial);
      }
    }
    return {
      range: {
        coverage: "conservative",
        bounds: { min, max, quality: "estimated", unit: "mm" },
      },
      ports,
      repetitions: paths.map((leg) => ({
        first: add3(leg.start, mul3(leg.direction, p.front)),
        step: mul3(leg.direction, p.pitch),
        count: p.count,
      })),
      connectionSplitCount: p.split,
    };
  }
  return {
    range: {
      coverage: "conservative",
      bounds: {
        min,
        max,
        quality: p.approximation ? "estimated" : "parameter-derived",
        unit: "mm",
      },
    },
    ports,
  };
}
