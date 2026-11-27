import type { Point3 } from "./analysisGeometry.js";
import type {
  GeometryDiagnostic,
  GeometryLimits,
} from "./primitiveContracts.js";
import { checkGeometryBudget } from "./geometryBudget.js";
import { loftRings, type MeshBuild } from "./profiles.js";

type Grid = {
  readonly columns: number;
  readonly rows: number;
  readonly columnSpacing: number;
  readonly rowSpacing: number;
};
type Size = {
  readonly length: number;
  readonly width: number;
  readonly thickness: number;
};
export type PlatePrimitive =
  | (Size &
      Grid & {
        readonly kind: "TerminalBlock";
        readonly holeRadius: number;
        readonly bevel: number;
        readonly bottomMargin: number;
      })
  | (Size &
      Grid & {
        readonly kind: "RectangularFixedPlate";
        readonly diameter: number;
        readonly middle: boolean;
      })
  | (Size & {
      readonly kind: "CircularFixedPlate";
      readonly diameter: number;
      readonly count: number;
      readonly pitchRadius: number;
      readonly middle: boolean;
    });
type XY = [number, number];
const issue = (code: string, message: string): GeometryDiagnostic => ({
  code,
  message,
  stage: "compile",
  severity: "warning",
});
function circle(x: number, y: number, r: number, n: number): XY[] {
  return Array.from({ length: n }, (_, k) => [
    x + r * Math.cos((2 * Math.PI * k) / n),
    y + r * Math.sin((2 * Math.PI * k) / n),
  ]);
}
export function plateMesh(
  p: PlatePrimitive,
  segments: number,
  limits?: Partial<GeometryLimits>,
): MeshBuild {
  const terminal = p.kind === "TerminalBlock",
    round = p.kind === "CircularFixedPlate";
  const radius = terminal ? p.holeRadius : p.diameter / 2;
  const counts = round ? [p.count] : [p.rows, p.columns],
    spacingFields = round ? [p.pitchRadius] : [p.rowSpacing, p.columnSpacing];
  if (
    counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    spacingFields.some((n) => !(n > 0 && Number.isFinite(n)))
  )
    return issue("invalid-field-value", "Invalid hole count or spacing");
  if (
    ![p.length, p.width, p.thickness, radius].every(
      (v) => Number.isFinite(v) && v > 0,
    )
  )
    return issue("invalid-field-value", "Plate dimensions must be positive");
  if (round && p.length !== p.width)
    return issue(
      "unverified-outline",
      "B.27 outer outline is undetermined for unequal L and W",
    );
  if (terminal && (p.bevel > p.width / 2 || p.bevel >= p.length))
    return issue("invalid-geometry", "CL cuts beyond the plate perimeter");
  const hasGridCentre =
    !round && !terminal && p.columns % 2 === 1 && p.rows % 2 === 1;
  const holes = round
    ? p.count + Number(p.middle)
    : p.columns * p.rows -
      Number(hasGridCentre) +
      Number(!terminal && p.middle);
  const outerCount = round ? segments : terminal ? 6 : 4;
  const budget = checkGeometryBudget(
    { maxHoles: holes, maxVertices: 6 * (outerCount + segments * holes) },
    limits,
  );
  if (budget) return budget;
  const centres: XY[] = [];
  if (round) {
    for (let i = 0; i < p.count; i++)
      centres.push([
        p.pitchRadius * Math.cos((2 * Math.PI * i) / p.count),
        p.pitchRadius * Math.sin((2 * Math.PI * i) / p.count),
      ]);
  } else if (p.columns > 0 && p.rows > 0) {
    for (let row = 0; row < p.rows; row++)
      for (let col = 0; col < p.columns; col++) {
        const x = (col - (p.columns - 1) / 2) * p.columnSpacing;
        const y = terminal
          ? p.bottomMargin + row * p.rowSpacing
          : (row - (p.rows - 1) / 2) * p.rowSpacing;
        if (!terminal && x === 0 && y === 0) continue;
        centres.push([x, y]);
      }
  }
  if (!terminal && p.middle) centres.push([0, 0]);
  const w = p.width / 2,
    l = p.length / 2;
  const outline: XY[] = round
    ? circle(0, 0, l, segments)
    : terminal
      ? [
          [-w, 0],
          [w, 0],
          [w, p.length - p.bevel],
          [w - p.bevel, p.length],
          [-w + p.bevel, p.length],
          [-w, p.length - p.bevel],
        ]
      : [
          [-l, -w],
          [l, -w],
          [l, w],
          [-l, w],
        ];
  if (terminal && p.bevel === w) outline.splice(4, 1);
  const buckets = new Map<string, XY[]>(),
    spacing = radius * 2;
  for (const [x, y] of centres) {
    let gap = Infinity;
    if (round) gap = l - Math.hypot(x, y) - radius;
    else
      for (let j = 0; j < outline.length; j++) {
        const [a, b] = outline[j],
          [c, d] = outline[(j + 1) % outline.length];
        gap = Math.min(
          gap,
          ((c - a) * (y - b) - (d - b) * (x - a)) / Math.hypot(c - a, d - b) -
            radius,
        );
      }
    const epsilon = 16 * Number.EPSILON * Math.max(p.length, p.width, radius);
    if (gap <= epsilon)
      return issue(
        gap < -epsilon ? "hole-outside" : "hole-tangent",
        "Hole reaches the outer perimeter",
      );
    const cx = Math.floor(x / spacing),
      cy = Math.floor(y / spacing);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const [u, v] of buckets.get(`${cx + dx},${cy + dy}`) ?? []) {
          const sep = Math.hypot(u - x, v - y) - spacing;
          if (sep <= epsilon)
            return issue(
              sep < -epsilon ? "hole-overlap" : "hole-tangent",
              "Holes overlap or touch",
            );
        }
      }
    const key = `${cx},${cy}`,
      list = buckets.get(key) ?? [];
    list.push([x, y]);
    buckets.set(key, list);
  }
  // For the round shell, insert the directions of all hole vertices into the
  // outer polygon so its chords cannot clip a near-edge hole at coarse LOD.
  let outer = outline;
  if (round && centres.length) {
    const furthest = centres.reduce(
      (v, [x, y]) => Math.max(v, Math.hypot(x, y) + radius),
      0,
    );
    const count = Math.max(
      segments,
      4 * Math.ceil((1 + Math.PI / Math.acos(furthest / l)) / 4),
    );
    const limit = checkGeometryBudget(
      { maxVertices: 6 * (count + segments * holes) },
      limits,
    );
    if (limit) return limit;
    outer = circle(0, 0, l, count);
  }
  const rings = centres.map(([x, y]) => circle(x, y, radius, segments));
  const pos = ([x, y]: XY, top: boolean): Point3 =>
    terminal
      ? [x, (top ? 0.5 : -0.5) * p.thickness, y]
      : [x, y, top ? p.thickness : 0];
  const contours = [outer, ...rings];
  return loftRings(
    contours.map((r) => r.map((pt) => pos(pt, false))),
    contours.map((r) => r.map((pt) => pos(pt, true))),
    limits,
  );
}
