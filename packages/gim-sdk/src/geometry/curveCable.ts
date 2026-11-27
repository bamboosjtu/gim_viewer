import type { AnalysisGeometry, Point3 } from "./analysisGeometry.js";
import {
  checkGeometryBudget,
  DEFAULT_GEOMETRY_LIMITS,
} from "./geometryBudget.js";
import type {
  GeometryCompileOptions,
  GeometryDiagnostic,
} from "./primitiveContracts.js";
import { invalidShape, type MeshBuild } from "./profiles.js";
import { separateWireSections } from "./wireSweep.js";
import type { StandardFields } from "./standardFields.js";
import { xmlModNumber } from "../parser/xmlModValues.js";
import {
  add3,
  cross3,
  dot3,
  mul3,
  sub3,
  unit3,
  sweepTube,
  type SweepFrame,
} from "./sweep.js";

type Line = { type: 0; start: Point3; end: Point3 };
type Arc = { type: 1; start: Point3; end: Point3; intersection: Point3 };
type Spline = {
  type: 2;
  startVector: Point3;
  endVector: Point3;
  controls: Point3[];
};
type CurveSource =
  | {
      kind: "Wire";
      start: Point3;
      end: Point3;
      startVector?: Point3;
      endVector?: Point3;
      fitPoints: Point3[];
      sag?: number;
      fitOnly: boolean;
    }
  | { kind: "CurveCable"; segments: (Line | Arc | Spline)[] };
export type CurvePrimitive = CurveSource & {
  family: "curve";
  diameter: number;
  approximation?: string;
};
const length = (v: Point3) => Math.hypot(...v);
const close = (a: Point3, b: Point3) =>
  length(sub3(a, b)) <= 64 * Number.EPSILON * Math.max(1, length(a), length(b));
function tuple(
  text: string | undefined,
  field: string,
  f: StandardFields,
): Point3 {
  const parts = (text ?? "").trim().split(",").map(xmlModNumber);
  if (parts.length !== 3 || !parts.every(Number.isFinite)) {
    f.fail(field, "Expected exactly three finite coordinates");
    return [0, 0, 0];
  }
  return [parts[0], parts[1], parts[2]];
}
function direction(v: Point3, field: string, f: StandardFields): Point3 {
  if (!(length(v) > 0 && Number.isFinite(length(v))))
    f.fail(field, "Direction must be finite and nonzero");
  return v;
}
/** Read at most limit+1 delimiters before allocating a source-size token list. */
function list(
  text: string,
  separator: string,
  limit: number,
  trailing: boolean,
  field: string,
  f: StandardFields,
  limitName: "maxCurveSegments" | "maxContourPoints",
  consumed = 0,
): string[] {
  const values: string[] = [];
  let start = 0;
  while (start <= text.length) {
    if (start === text.length && start > 0 && trailing) break;
    if (consumed + values.length >= limit) {
      f.diagnostics.push({
        stage: "interpret",
        code: "capacity-exceeded",
        severity: "error",
        message: "Curve source exceeds compilation budget",
        location: { field },
        limit: { name: limitName, allowed: limit, requested: limit + 1 },
      });
      break;
    }
    const end = text.indexOf(separator, start),
      v = text.slice(start, end < 0 ? text.length : end).trim();
    if (!v) {
      f.fail(field, "Empty curve record");
      break;
    }
    values.push(v);
    if (end < 0) break;
    start = end + 1;
  }
  return values;
}
export function readCurve(
  kind: "Wire" | "CurveCable",
  f: StandardFields,
  options: GeometryCompileOptions,
): CurvePrimitive {
  const maxPts =
      options.limits?.maxContourPoints ??
      DEFAULT_GEOMETRY_LIMITS.maxContourPoints,
    maxSeg =
      options.limits?.maxCurveSegments ??
      DEFAULT_GEOMETRY_LIMITS.maxCurveSegments;
  const diameter = f.number("D");
  if (kind === "Wire") {
    const field = "FitCoordArray",
      fitPoints = list(
        (f.get(field) ?? "").trim(),
        ";",
        maxPts,
        true,
        field,
        f,
        "maxContourPoints",
      ).map((s) => tuple(s, field, f));
    const fitOnly =
      options.compatibility?.rule === "wire-fit-preview-v1" &&
      ["StartCoord", "EndCoord", "StartVector", "EndVector", "Sag"].some(
        (k) => f.get(k) === undefined,
      );
    if (fitPoints.length < (fitOnly ? 2 : 3))
      f.fail(field, "Insufficient fit points");
    const start =
        fitOnly && f.get("StartCoord") === undefined
          ? (fitPoints[0] ?? [0, 0, 0])
          : tuple(f.get("StartCoord"), "StartCoord", f),
      end =
        fitOnly && f.get("EndCoord") === undefined
          ? (fitPoints[fitPoints.length - 1] ?? [0, 0, 0])
          : tuple(f.get("EndCoord"), "EndCoord", f);
    return {
      family: "curve",
      kind,
      diameter,
      start,
      end,
      fitPoints,
      fitOnly,
      sag: fitOnly && f.get("Sag") === undefined ? undefined : f.number("Sag"),
      startVector:
        fitOnly && f.get("StartVector") === undefined
          ? undefined
          : direction(
              tuple(f.get("StartVector"), "StartVector", f),
              "StartVector",
              f,
            ),
      endVector:
        fitOnly && f.get("EndVector") === undefined
          ? undefined
          : direction(
              tuple(f.get("EndVector"), "EndVector", f),
              "EndVector",
              f,
            ),
      approximation: fitOnly
        ? "Fit-only project Wire; end directions and sag are unverified"
        : "Endpoint-constrained fit interpolation; sag direction and standard curve family are unspecified (B.28)",
    };
  }
  const types = list(
    (f.get("CurveTypeArray") ?? "").trim(),
    ",",
    maxSeg,
    false,
    "CurveTypeArray",
    f,
    "maxCurveSegments",
  );
  const groups = list(
    (f.get("CurveControlCoordArray") ?? "").trim(),
    "|",
    maxSeg,
    true,
    "CurveControlCoordArray",
    f,
    "maxCurveSegments",
  );
  if (types.length !== groups.length)
    f.fail("CurveTypeArray", "Segment and control-group counts differ");
  const segments: (Line | Arc | Spline)[] = [];
  let previous: Point3 | undefined,
    used = 0;
  for (let i = 0; i < Math.min(types.length, groups.length); i++) {
    const field = "CurveControlCoordArray",
      tokens = list(
        groups[i],
        ";",
        maxPts,
        true,
        field,
        f,
        "maxContourPoints",
        used,
      );
    used += tokens.length;
    const at = (j: number) => tuple(tokens[j], field, f);
    let seg: Line | Arc | Spline;
    switch (types[i]) {
      case "0":
        seg = { type: 0, start: at(0), end: at(1) };
        break;
      case "1":
        seg = { type: 1, start: at(0), end: at(1), intersection: at(2) };
        break;
      case "2": {
        const controls = tokens.slice(2).map((t) => tuple(t, field, f));
        if (controls.length < 2) {
          f.fail(field, "Spline needs at least two control points");
          continue;
        }
        seg = {
          type: 2,
          startVector: direction(at(0), field, f),
          endVector: direction(at(1), field, f),
          controls,
        };
        break;
      }
      default:
        f.fail("CurveTypeArray", "Unknown segment type");
        continue;
    }
    const a = seg.type === 2 ? seg.controls[0] : seg.start,
      b = seg.type === 2 ? seg.controls[seg.controls.length - 1] : seg.end;
    if (previous && !close(previous, a))
      f.fail(field, `Discontinuous connection at segment ${i + 1}`);
    if (seg.type !== 2 && close(a, b))
      f.fail(field, "Segment has coincident endpoints");
    segments.push(seg);
    previous = b;
  }
  const approx = segments.some((s) => s.type !== 0) || segments.length > 1;
  return {
    family: "curve",
    kind,
    segments,
    diameter,
    ...(approx
      ? {
          approximation:
            "Arc orientation, spline basis or inter-segment junction is a browsing convention (B.29)",
        }
      : {}),
  };
}

type Piece =
  | Line
  | { type: "cubic"; a: Point3; b: Point3; c: Point3; d: Point3 }
  | { type: "arc"; center: Point3; x: Point3; y: Point3; angle: number };
function splinePieces(points: Point3[], start?: Point3, end?: Point3): Piece[] {
  const pieces: Piece[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i],
      b = points[i + 1],
      chord = sub3(b, a),
      prev = i ? points[i - 1] : sub3(a, chord),
      next = points[i + 2] ?? add3(b, chord);
    const dt = Math.sqrt(length(chord)),
      left = Math.sqrt(length(sub3(a, prev))) || dt,
      right = Math.sqrt(length(sub3(next, b))) || dt;
    const derivative = (
      p0: Point3,
      p1: Point3,
      p2: Point3,
      d0: number,
      d1: number,
    ) =>
      add3(
        sub3(mul3(sub3(p1, p0), 1 / d0), mul3(sub3(p2, p0), 1 / (d0 + d1))),
        mul3(sub3(p2, p1), 1 / d1),
      );
    const v0 =
      i === 0 && start
        ? mul3(unit3(start), length(chord))
        : mul3(derivative(prev, a, b, left, dt), dt);
    const v1 =
      i === points.length - 2 && end
        ? mul3(unit3(end), length(chord))
        : mul3(derivative(a, b, next, dt, right), dt);
    pieces.push({
      type: "cubic",
      a,
      b: add3(a, mul3(v0, 1 / 3)),
      c: sub3(b, mul3(v1, 1 / 3)),
      d: b,
    });
  }
  return pieces;
}
function fillet(s: Arc): Piece | undefined {
  const va = sub3(s.start, s.intersection),
    vb = sub3(s.end, s.intersection),
    la = length(va),
    lb = length(vb);
  if (!la || !lb || Math.abs(la - lb) > 128 * Number.EPSILON * Math.max(la, lb))
    return;
  const a = unit3(va),
    b = unit3(vb),
    axis = cross3(mul3(a, -1), b);
  if (length(axis) < 1e-12) return;
  const bisector = unit3(add3(a, b)),
    center = add3(s.intersection, mul3(bisector, la / dot3(a, bisector)));
  const x = sub3(s.start, center),
    y = cross3(unit3(axis), x),
    last = sub3(s.end, center);
  const angle = Math.atan2(dot3(y, last), dot3(x, last));
  if (!(angle > 0)) return;
  return { type: "arc", center, x, y, angle };
}
function distinct(points: Point3[]) {
  return points.filter((p, i) => !i || !close(points[i - 1], p));
}

// Wire vectors describe the lead at each terminal. Their signs are preserved
// on the source and the reported ports. The sweep traverses first fit to last.
function alongWire(lead: Point3 | undefined, chord: Point3) {
  return lead && dot3(lead, chord) < 0 ? mul3(lead, -1) : lead;
}

function piecesFor(p: CurvePrimitive): Piece[] | GeometryDiagnostic {
  if (p.kind === "Wire") {
    const points = distinct([p.start, ...p.fitPoints, p.end]);
    if (points.length < 2) return invalidShape("Wire fit points coincide");
    const last = points.length - 1;
    return splinePieces(
      points,
      alongWire(p.startVector, sub3(points[1], points[0])),
      alongWire(p.endVector, sub3(points[last], points[last - 1])),
    );
  }
  const pieces: Piece[] = [];
  for (const s of p.segments) {
    if (s.type === 0) pieces.push(s);
    else if (s.type === 1) {
      const arc = fillet(s);
      if (!arc)
        return {
          code: "unverified-arc",
          stage: "compile",
          severity: "warning",
          message: "No unique circular fillet from these endpoint tangents",
        };
      pieces.push(arc);
    } else {
      if (distinct(s.controls).length !== s.controls.length)
        return invalidShape("Repeated adjacent spline controls");
      for (const piece of splinePieces(s.controls, s.startVector, s.endVector))
        pieces.push(piece);
    }
  }
  return pieces.length ? pieces : invalidShape("Empty curve");
}
function evaluate(s: Piece, t: number): SweepFrame {
  const u = 1 - t;
  if (s.type === 0)
    return {
      center: add3(mul3(s.start, u), mul3(s.end, t)),
      tangent: unit3(sub3(s.end, s.start)),
    };
  if (s.type === "arc") {
    const a = s.angle * t,
      c = Math.cos(a),
      v = Math.sin(a);
    return {
      center: add3(s.center, add3(mul3(s.x, c), mul3(s.y, v))),
      tangent: unit3(add3(mul3(s.x, -v), mul3(s.y, c))),
    };
  }
  return {
    center: add3(
      add3(mul3(s.a, u * u * u), mul3(s.b, 3 * u * u * t)),
      add3(mul3(s.c, 3 * u * t * t), mul3(s.d, t * t * t)),
    ),
    tangent: unit3(
      add3(
        add3(mul3(sub3(s.b, s.a), u * u), mul3(sub3(s.c, s.b), 2 * u * t)),
        mul3(sub3(s.d, s.c), t * t),
      ),
    ),
  };
}
function framesFor(
  p: CurvePrimitive,
  options: GeometryCompileOptions,
): SweepFrame[] | GeometryDiagnostic {
  const minSpans =
    p.kind === "Wire"
      ? distinct([p.start, ...p.fitPoints, p.end]).length - 1
      : p.segments.reduce(
          (n, s) => n + (s.type === 2 ? s.controls.length - 1 : 1),
          0,
        );
  const previewSamples =
    p.kind === "Wire" && p.fitOnly
      ? Math.min(256, Math.max(8, p.fitPoints.length))
      : undefined;
  const preflight = checkGeometryBudget(
    { maxCurveSegments: previewSamples ?? Math.max(0, minSpans) },
    options.limits,
  );
  if (preflight) return preflight;
  const pieces = piecesFor(p);
  if (!Array.isArray(pieces)) return pieces;
  if (previewSamples !== undefined) {
    const limit = checkGeometryBudget(
      { maxVertices: (previewSamples + 1) * 6 + 14 },
      options.limits,
    );
    if (limit) return limit;
    const frames: SweepFrame[] = [];
    for (let i = 0; i <= previewSamples; i++) {
      const at = (pieces.length * i) / previewSamples,
        part = Math.min(pieces.length - 1, Math.floor(at));
      const frame = evaluate(pieces[part], at - part);
      if (!frame.tangent.every(Number.isFinite))
        return invalidShape("Undefined curve tangent");
      frames.push(frame);
    }
    return frames;
  }
  const count = pieces.length,
    desired = Math.max(8, count);
  const steps = pieces.map((s, i) =>
    s.type === 0
      ? 1
      : s.type === "arc"
        ? Math.max(2, Math.ceil((s.angle * 8) / Math.PI))
        : Math.floor(desired / count) + Number(i < desired % count),
  );
  const total = steps.reduce((a, b) => a + b, 0);
  const limit = checkGeometryBudget(
    { maxCurveSegments: total, maxVertices: (total + 1) * 6 + 14 },
    options.limits,
  );
  if (limit) return limit;
  const frames: SweepFrame[] = [];
  for (const [i, s] of pieces.entries()) {
    if (i) {
      const t = add3(frames[frames.length - 1].tangent, evaluate(s, 0).tangent);
      if (length(t) < 1e-12)
        return invalidShape("Curve reverses at a junction");
      frames[frames.length - 1].tangent = unit3(t);
    }
    for (let j = i ? 1 : 0; j <= steps[i]; j++) {
      const frame = evaluate(s, j / steps[i]);
      if (!frame.tangent.every(Number.isFinite))
        return invalidShape("Undefined curve tangent");
      frames.push(frame);
    }
  }
  return frames;
}
export function curveMesh(
  p: CurvePrimitive,
  options: GeometryCompileOptions,
): MeshBuild {
  const frames = framesFor(p, options);
  if (!Array.isArray(frames)) return frames;
  if (p.kind === "Wire" && !separateWireSections(frames, p.diameter / 2)) {
    return {
      code: "unresolved-wire-sweep",
      stage: "compile",
      severity: "warning",
      message:
        "Wire cross-sections cannot be separated at the declared radius with these sampled centres and end planes",
    };
  }
  frames[0].radial =
    Math.abs(frames[0].tangent[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  return sweepTube(frames, p.diameter / 2, false, 6, options.limits);
}
export function curveCenterline(p: CurvePrimitive): Point3[] {
  const frames = framesFor(p, {});
  return Array.isArray(frames) ? frames.map((f) => f.center) : [];
}
export function curveAnalysis(p: CurvePrimitive): AnalysisGeometry {
  const pieces = piecesFor(p);
  if (!Array.isArray(pieces))
    return { range: { coverage: "unknown", diagnostics: [pieces] }, ports: [] };
  const min: Point3 = [Infinity, Infinity, Infinity],
    max: Point3 = [-Infinity, -Infinity, -Infinity],
    r = p.diameter / 2;
  const include = (v: Point3) => {
    for (const i of [0, 1, 2] as const) {
      min[i] = Math.min(min[i], v[i] - r);
      max[i] = Math.max(max[i], v[i] + r);
    }
  };
  for (const s of pieces) {
    if (s.type === "arc") {
      const ext = s.x.map((v, i) => Math.hypot(v, s.y[i])) as Point3;
      include(add3(s.center, ext));
      include(sub3(s.center, ext));
    } else
      for (const a of s.type === 0 ? [s.start, s.end] : [s.a, s.b, s.c, s.d])
        include(a);
  }
  const first = evaluate(pieces[0], 0),
    last = evaluate(pieces[pieces.length - 1], 1);
  const roundoff = 32 * Number.EPSILON * Math.max(1, length(min), length(max));
  if (!Number.isFinite(roundoff))
    return { range: { coverage: "unknown" }, ports: [] };
  for (const i of [0, 1, 2] as const) {
    min[i] -= roundoff;
    max[i] += roundoff;
  }
  const declared = p.kind === "Wire" ? [p.startVector, p.endVector] : [];
  const ports = [first, last].map((f, i) => ({
    name: i ? "end" : "start",
    position: f.center,
    direction: declared[i] ? unit3(declared[i]) : f.tangent,
    unit: "mm" as const,
    quality: p.approximation
      ? ("estimated" as const)
      : ("standard-derived" as const),
  }));
  let maxFitDistanceFromChord: number | undefined;
  if (p.kind === "Wire" && !close(p.start, p.end)) {
    const axis = unit3(sub3(p.end, p.start));
    maxFitDistanceFromChord = p.fitPoints.reduce(
      (largest, v) => Math.max(largest, length(cross3(sub3(v, p.start), axis))),
      0,
    );
  }
  return {
    range: {
      coverage: "conservative",
      bounds: {
        min,
        max,
        unit: "mm",
        quality: p.approximation ? "estimated" : "parameter-derived",
      },
    },
    ports,
    curve: {
      diameter: p.diameter,
      declaredSag: p.kind === "Wire" ? p.sag : undefined,
      segmentCount: p.kind === "CurveCable" ? p.segments.length : 1,
      sagReference: p.kind === "Wire" ? "unspecified" : undefined,
      fitPointCount: p.kind === "Wire" ? p.fitPoints.length : undefined,
      maxFitDistanceFromChord,
      ...(p.kind === "Wire"
        ? { travelTangents: { start: first.tangent, end: last.tangent } }
        : {}),
    },
  };
}
