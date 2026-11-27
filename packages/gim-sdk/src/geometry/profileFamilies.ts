import type {
  AnalysisGeometry,
  GeometryPort,
  Point3,
} from "./analysisGeometry.js";
import type { GeometryCompileOptions } from "./primitiveContracts.js";
import { loftRings, rectangle, type MeshBuild } from "./profiles.js";
import { sweepTube, unit3, type SweepFrame } from "./sweep.js";
import type { StandardFields } from "./standardFields.js";

export const PROFILE_TAGS = [
  "Table",
  "BendingCylindrical",
  "Ring",
  "RectangularRing",
  "EllipticRing",
  "CircularGasket",
  "TableGasket",
  "SquareGasket",
  "AngleSteel",
  "I-shapedsteel",
  "ChannelSteel",
  "T-Steels",
] as const;
export type ProfileTag = (typeof PROFILE_TAGS)[number];
type Shape =
  | {
      kind: "Table";
      ll1: number;
      ll2: number;
      tl1: number;
      tl2: number;
      height: number;
    }
  | {
      kind: "BendingCylindrical";
      radius: number;
      length: number;
      angle: number;
    }
  | { kind: "Ring"; radius: number; tube: number; angle: number }
  | { kind: "EllipticRing"; major: number; minor: number; tube: number }
  | {
      kind: "RectangularRing";
      length: number;
      width: number;
      corner: number;
      tube: number;
    }
  | {
      kind: "CircularGasket";
      outer: number;
      inner: number;
      height: number;
      angle: number;
    }
  | {
      kind: "TableGasket";
      outer: number;
      top: number;
      inner: number;
      height: number;
      angle: number;
    }
  | {
      kind: "SquareGasket";
      length: number;
      width: number;
      holeLength: number;
      holeWidth: number;
      height: number;
      ct: number;
      corner: number;
    }
  | {
      kind: "AngleSteel" | "I-shapedsteel" | "ChannelSteel" | "T-Steels";
      width: number;
      height: number;
      web: number;
      flange: number;
      length: number;
      model?: string;
    };
export type ProfilePrimitive = Shape & {
  family: "profile";
  approximation?: string;
  modelEstimate?: boolean;
};
const TAU = 2 * Math.PI;

export function readProfile(
  kind: ProfileTag,
  f: StandardFields,
  options: GeometryCompileOptions,
): ProfilePrimitive {
  const n = (key: string) => f.number(key);
  let shape: Shape,
    approximation: string | undefined,
    modelEstimate = false;
  switch (kind) {
    case "Table": {
      const ll1 = n("LL1"),
        ll2 = n("LL2"),
        tl1 = n("TL1"),
        tl2 = n("TL2");
      if (
        Math.abs(tl1 / ll1 - tl2 / ll2) >
        64 * Number.EPSILON * Math.max(tl1 / ll1, tl2 / ll2)
      ) {
        if (options.compatibility?.rule === "non-similar-rhombi-preview-v1")
          approximation =
            "Source declares non-similar rhombi; preview preserves all four diagonals";
        else f.fail("TL1", "B.4 top and bottom rhombi must be similar");
      }
      shape = { kind, ll1, ll2, tl1, tl2, height: n("H") };
      break;
    }
    case "BendingCylindrical": {
      const radius = n("R"),
        length = n("L"),
        angle = f.angle("Rad", false);
      if (radius * Math.abs(1 / Math.tan(angle / 2)) >= length)
        f.fail("Rad", "Miter reaches the end cap");
      shape = { kind, radius, length, angle };
      approximation =
        "B.7 miter seam follows figure B.7; join construction awaits source confirmation";
      break;
    }
    case "Ring": {
      const radius = n("R"),
        tube = n("DR");
      if (tube >= radius)
        f.fail("DR", "Tube radius must be smaller than the path radius");
      shape = { kind, radius, tube, angle: f.angle("Rad") };
      break;
    }
    case "EllipticRing": {
      const major = n("L"),
        minor = n("W"),
        tube = n("DR");
      if (minor >= major) f.fail("W", "W must be the shorter semi-axis");
      if (tube >= (minor * minor) / major)
        f.fail("DR", "Tube intersects at the minimum radius of curvature");
      shape = { kind, major, minor, tube };
      break;
    }
    case "RectangularRing": {
      const length = n("L"),
        width = n("W"),
        corner = n("R"),
        tube = n("DR");
      if (2 * corner > Math.min(length, width) || tube >= corner)
        f.fail("R", "Invalid or self-intersecting rounded sweep");
      if (width === 2 * corner)
        approximation = "B.11 W=2R boundary awaits source confirmation";
      shape = { kind, length, width, corner, tube };
      break;
    }
    case "CircularGasket":
    case "TableGasket": {
      const outer = n("OR"),
        inner = n("IR"),
        height = n("H"),
        angle = f.angle("Rad");
      if (inner >= outer) f.fail("OR", "Outer radius must exceed bore radius");
      if (kind === "TableGasket") {
        const top = n("TR");
        if (top <= inner) f.fail("TR", "Top radius must exceed bore radius");
        shape = { kind, outer, inner, top, height, angle };
      } else shape = { kind, outer, inner, height, angle };
      break;
    }
    case "SquareGasket": {
      const length = n("L1"),
        width = n("W1"),
        holeLength = n("L2"),
        holeWidth = n("W2"),
        height = n("H"),
        ct = f.integer("CT", 1);
      const corner = ct === 2 ? n("Rad") : ct === 3 ? f.number("CL", false) : 0;
      if (holeLength >= length || holeWidth >= width)
        f.fail("L2", "Bore must lie inside shell");
      if (ct > 3 || corner < 0 || 2 * corner > Math.min(length, width))
        f.fail("CT", "Invalid corner treatment");
      const dx = (length - holeLength) / 2,
        dy = (width - holeWidth) / 2;
      if (
        (ct === 3 && corner >= dx + dy) ||
        (ct === 2 &&
          Math.hypot(Math.max(0, corner - dx), Math.max(0, corner - dy)) >=
            corner)
      )
        f.fail("CT", "Bore touches the corner treatment");
      shape = {
        kind,
        length,
        width,
        holeLength,
        holeWidth,
        height,
        ct,
        corner,
      };
      break;
    }
    default: {
      const length = n("L"),
        model = f.get("Model");
      modelEstimate =
        kind === "ChannelSteel" &&
        !!model &&
        ["B", "H", "D", "T"].every((k) => f.get(k) === undefined) &&
        options.compatibility?.rule === "steel-model-section-v1";
      if (modelEstimate && !/^(?:\[10|C10|10#)$/i.test(model.trim()))
        f.diagnostics.push({
          code: "unsupported-section-model",
          stage: "interpret",
          severity: "warning",
          message:
            "No verified dimensions for this channel section designation",
          location: { field: "Model", sourceTag: kind },
        });
      const width = modelEstimate ? 48 : n("B"),
        height = modelEstimate ? 100 : n("H"),
        web = modelEstimate ? 5.3 : n("D");
      const flange = kind === "AngleSteel" ? web : modelEstimate ? 8.5 : n("T");
      if (
        web >= width ||
        flange *
          (kind === "ChannelSteel" || kind === "I-shapedsteel" ? 2 : 1) >=
          height
      )
        f.fail("D", "Web or flange consumes the section");
      if (modelEstimate)
        approximation =
          "Model designation without a verified section series; retained project browsing estimate";
      shape = {
        kind,
        length,
        width,
        height,
        web,
        flange,
        ...(model ? { model } : {}),
      };
      break;
    }
  }
  return {
    ...shape,
    family: "profile",
    ...(approximation ? { approximation } : {}),
    ...(modelEstimate ? { modelEstimate } : {}),
  };
}
type XY = [number, number];
function arcAngles(angle: number, n: number) {
  const steps = Math.max(1, Math.ceil((n * angle) / TAU));
  return Array.from(
    { length: steps + (angle === TAU ? 0 : 1) },
    (_, i) => (i * angle) / steps,
  );
}
function rounded(
  length: number,
  width: number,
  r: number,
  n: number,
): { p: XY; t: XY }[] {
  const result: { p: XY; t: XY }[] = [],
    steps = Math.max(2, Math.ceil(n / 4));
  for (let q = 0; q < 4; q++) {
    const cx = (q === 0 || q === 3 ? 1 : -1) * (length / 2 - r),
      cy = (q < 2 ? 1 : -1) * (width / 2 - r);
    for (let j = 0; j <= steps; j++) {
      const angle = ((q + j / steps) * Math.PI) / 2,
        c = Math.cos(angle),
        s = Math.sin(angle),
        p: XY = [cx + r * c, cy + r * s];
      const prev = result[result.length - 1]?.p;
      if (
        prev &&
        Math.hypot(prev[0] - p[0], prev[1] - p[1]) <=
          Number.EPSILON * 4 * Math.max(length, width)
      )
        continue;
      result.push({ p, t: [-s, c] });
    }
  }
  const first = result[0].p,
    last = result[result.length - 1].p;
  if (
    Math.hypot(first[0] - last[0], first[1] - last[1]) <=
    Number.EPSILON * 4 * Math.max(length, width)
  )
    result.pop();
  return result;
}
function frame(
  x: number,
  y: number,
  tx: number,
  ty: number,
  radialScale = 1,
): SweepFrame {
  const t = unit3([tx, ty, 0]);
  return {
    center: [x, y, 0],
    tangent: t,
    radial: [t[1], -t[0], 0],
    radialScale,
  };
}
function bend(p: Extract<Shape, { kind: "BendingCylindrical" }>): SweepFrame[] {
  const c = Math.cos(p.angle),
    s = Math.sin(p.angle),
    middle = frame(0, 0, c - 1, s);
  middle.radialScale = 1 / Math.abs(middle.tangent[0]);
  return [
    frame(p.length, 0, -1, 0),
    middle,
    frame(p.length * c, p.length * s, c, s),
  ];
}
function section(p: Extract<Shape, { web: number }>): XY[] {
  const b = p.width,
    h = p.height,
    d = p.web,
    t = p.flange;
  switch (p.kind) {
    case "AngleSteel":
      return [
        [0, 0],
        [b, 0],
        [b, d],
        [d, d],
        [d, h],
        [0, h],
      ];
    case "ChannelSteel":
      return [
        [0, -h / 2],
        [b, -h / 2],
        [b, -h / 2 + t],
        [d, -h / 2 + t],
        [d, h / 2 - t],
        [b, h / 2 - t],
        [b, h / 2],
        [0, h / 2],
      ];
    case "I-shapedsteel":
      return [
        [-b / 2, 0],
        [b / 2, 0],
        [b / 2, t],
        [d / 2, t],
        [d / 2, h - t],
        [b / 2, h - t],
        [b / 2, h],
        [-b / 2, h],
        [-b / 2, h - t],
        [-d / 2, h - t],
        [-d / 2, t],
        [-b / 2, t],
      ];
    case "T-Steels":
      return [
        [-b / 2, 0],
        [b / 2, 0],
        [b / 2, -t],
        [d / 2, -t],
        [d / 2, -h],
        [-d / 2, -h],
        [-d / 2, -t],
        [-b / 2, -t],
      ];
  }
}

export function profileMesh(
  p: ProfilePrimitive,
  n: number,
  options: GeometryCompileOptions,
): MeshBuild {
  const limits = options.limits,
    sides = (options.lod ?? 2) === 0 ? 4 : 8;
  switch (p.kind) {
    case "Table": {
      const diamond = (x: number, y: number, z: number): Point3[] => [
        [x / 2, 0, z],
        [0, y / 2, z],
        [-x / 2, 0, z],
        [0, -y / 2, z],
      ];
      return loftRings(
        [diamond(p.ll1, p.ll2, 0)],
        [diamond(p.tl1, p.tl2, p.height)],
        limits,
      );
    }
    case "BendingCylindrical":
      return sweepTube(bend(p), p.radius, false, n, limits);
    case "Ring":
    case "EllipticRing": {
      const a = p.kind === "Ring" ? p.radius : p.major,
        b = p.kind === "Ring" ? p.radius : p.minor,
        rad = p.kind === "Ring" ? p.angle : TAU;
      const path = arcAngles(rad, options.lod === 0 ? 8 : 16).map((t) =>
        frame(
          a * Math.cos(t),
          b * Math.sin(t),
          -a * Math.sin(t),
          b * Math.cos(t),
        ),
      );
      return sweepTube(path, p.tube, rad === TAU, sides, limits);
    }
    case "RectangularRing":
      return sweepTube(
        rounded(p.length, p.width, p.corner, n).map(({ p, t }) =>
          frame(...p, ...t),
        ),
        p.tube,
        true,
        sides,
        limits,
      );
    case "CircularGasket":
    case "TableGasket": {
      const angles = arcAngles(p.angle, p.kind === "CircularGasket" ? 16 : n),
        points = (r: number, z: number) =>
          angles.map((a): Point3 => [r * Math.cos(a), r * Math.sin(a), z]);
      const rings = (outer: number, z: number) =>
        p.angle === TAU
          ? [points(outer, z), points(p.inner, z)]
          : [[...points(outer, z), ...points(p.inner, z).reverse()]];
      return loftRings(
        rings(p.outer, 0),
        rings(p.kind === "TableGasket" ? p.top : p.outer, p.height),
        limits,
      );
    }
    case "SquareGasket": {
      const { length: l, width: w, corner: c } = p;
      const bevel: XY[] = [
        [-l / 2 + c, -w / 2],
        [l / 2 - c, -w / 2],
        [l / 2, -w / 2 + c],
        [l / 2, w / 2 - c],
        [l / 2 - c, w / 2],
        [-l / 2 + c, w / 2],
        [-l / 2, w / 2 - c],
        [-l / 2, -w / 2 + c],
      ];
      const cap = (z: number) => [
        p.ct === 2
          ? rounded(l, w, c, n).map(({ p: [x, y] }): Point3 => [x, y, z])
          : p.ct === 3 && c > 0
            ? bevel
                .filter(
                  ([x, y], i) =>
                    !i || x !== bevel[i - 1][0] || y !== bevel[i - 1][1],
                )
                .map(([x, y]): Point3 => [x, y, z])
            : rectangle(l, w, z),
        rectangle(p.holeLength, p.holeWidth, z),
      ];
      return loftRings(cap(0), cap(p.height), limits);
    }
    default: {
      const cap = (end: number) =>
        section(p).map(([u, v]): Point3 =>
          p.modelEstimate
            ? [u - p.width / 2, (end - 0.5) * p.length, v]
            : [end * p.length, -u, v],
        );
      return loftRings([cap(0)], [cap(1)], limits);
    }
  }
}

export function profileAnalysis(p: ProfilePrimitive): AnalysisGeometry {
  const quality = p.approximation ? "estimated" : "parameter-derived";
  const ports: GeometryPort[] = [];
  function port(name: string, position: Point3, direction: Point3) {
    ports.push({
      name,
      position,
      direction,
      unit: "mm",
      quality: p.approximation ? "estimated" : "standard-derived",
    });
  }
  let min: Point3, max: Point3;
  switch (p.kind) {
    case "BendingCylindrical": {
      min = [Infinity, Infinity, Infinity];
      max = [-Infinity, -Infinity, -Infinity];
      const frames = bend(p);
      for (const [i, f] of frames.entries()) {
        for (const axis of [0, 1, 2] as const) {
          const delta =
            p.radius *
            (axis === 2 ? 1 : Math.abs(f.radial![axis]) * (f.radialScale ?? 1));
          min[axis] = Math.min(min[axis], f.center[axis] - delta);
          max[axis] = Math.max(max[axis], f.center[axis] + delta);
        }
        if (i !== 1)
          port(i ? "end" : "start", f.center, i ? f.tangent : [1, 0, 0]);
      }
      break;
    }
    case "Ring":
    case "CircularGasket":
    case "TableGasket": {
      const tube = p.kind === "Ring" ? p.tube : 0;
      const outer =
        p.kind === "Ring"
          ? p.radius + tube
          : p.kind === "TableGasket"
            ? Math.max(p.top, p.outer)
            : p.outer;
      const inner = p.kind === "Ring" ? p.radius - tube : p.inner;
      const angles = [
        0,
        p.angle,
        ...[Math.PI / 2, Math.PI, (3 * Math.PI) / 2].filter((t) => t < p.angle),
      ];
      const x = angles.flatMap((a) => [
          outer * Math.cos(a),
          inner * Math.cos(a),
        ]),
        y = angles.flatMap((a) => [outer * Math.sin(a), inner * Math.sin(a)]);
      min = [Math.min(...x), Math.min(...y), -tube];
      max = [
        Math.max(...x),
        Math.max(...y),
        p.kind === "Ring" ? tube : p.height,
      ];
      if (p.kind === "Ring" && p.angle < TAU) {
        port("start", [p.radius, 0, 0], [0, -1, 0]);
        port(
          "end",
          [p.radius * Math.cos(p.angle), p.radius * Math.sin(p.angle), 0],
          [-Math.sin(p.angle), Math.cos(p.angle), 0],
        );
      }
      break;
    }
    case "RectangularRing":
    case "EllipticRing": {
      const a = p.kind === "EllipticRing" ? p.major : p.length / 2,
        b = p.kind === "EllipticRing" ? p.minor : p.width / 2;
      min = [-a - p.tube, -b - p.tube, -p.tube];
      max = [a + p.tube, b + p.tube, p.tube];
      break;
    }
    case "Table":
    case "SquareGasket": {
      const l = p.kind === "Table" ? Math.max(p.ll1, p.tl1) : p.length,
        w = p.kind === "Table" ? Math.max(p.ll2, p.tl2) : p.width;
      min = [-l / 2, -w / 2, 0];
      max = [l / 2, w / 2, p.height];
      port("base", [0, 0, 0], [0, 0, -1]);
      port("top", [0, 0, p.height], [0, 0, 1]);
      break;
    }
    default: {
      const xy = section(p),
        u = xy.map((v) => v[0]),
        z = xy.map((v) => v[1]);
      min = p.modelEstimate
        ? [-p.width / 2, -p.length / 2, -p.height / 2]
        : [0, -Math.max(...u), Math.min(...z)];
      max = p.modelEstimate
        ? [p.width / 2, p.length / 2, p.height / 2]
        : [p.length, -Math.min(...u), Math.max(...z)];
      if (!p.modelEstimate) {
        port("start", [0, 0, 0], [-1, 0, 0]);
        port("end", [p.length, 0, 0], [1, 0, 0]);
      }
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite))
    return { range: { coverage: "unknown" }, ports };
  return {
    range: {
      coverage: "conservative",
      bounds: { min, max, unit: "mm", quality },
    },
    ports,
  };
}
