import type { RawXmlModDocument } from "../parser/rawXmlMod.js";
import { isUsableAffineMatrix } from "../parser/affineMatrix.js";
import { interpretXmlModPrimitive } from "./interpretXmlModPrimitive.js";
import type {
  CanonicalPrimitive,
  GeometryDiagnostic,
} from "./primitiveContracts.js";

export type Point3 = [number, number, number];
export interface GeometryBounds {
  min: Point3;
  max: Point3;
  unit: "mm";
  quality: "parameter-derived" | "estimated";
}
export type BoundsCoverage =
  | { coverage: "conservative"; bounds: GeometryBounds }
  | {
      coverage: "unknown";
      knownBounds?: GeometryBounds;
      diagnostics?: readonly GeometryDiagnostic[];
    }
  | { coverage: "empty" };
export type BoundsPurpose = "analytical" | "display";
export interface GeometryPort {
  name: string;
  position: Point3;
  direction: Point3;
  unit: "mm";
  quality: "standard-derived" | "estimated";
}
export interface AnalysisGeometry {
  range: BoundsCoverage;
  ports: readonly GeometryPort[];
}

export function analyzePrimitive(p: CanonicalPrimitive): AnalysisGeometry {
  const x = p.kind === "Cylinder" ? p.radius : p.length / 2;
  const y = p.kind === "Cylinder" ? p.radius : p.width / 2;
  if (![x, y, p.height].every((n) => n > 0 && Number.isFinite(n)))
    return { range: { coverage: "unknown" }, ports: [] };
  return {
    range: {
      coverage: "conservative",
      bounds: {
        min: [-x, -y, 0],
        max: [x, y, p.height],
        unit: "mm",
        quality: "parameter-derived",
      },
    },
    ports: [
      {
        name: "base",
        position: [0, 0, 0],
        direction: [0, 0, -1],
        unit: "mm",
        quality: "standard-derived",
      },
      {
        name: "top",
        position: [0, 0, p.height],
        direction: [0, 0, 1],
        unit: "mm",
        quality: "standard-derived",
      },
    ],
  };
}

const axes = [0, 1, 2] as const;
function union(a: GeometryBounds, b: GeometryBounds): GeometryBounds {
  const min: Point3 = [...a.min],
    max: Point3 = [...a.max];
  for (const i of axes) {
    min[i] = Math.min(min[i], b.min[i]);
    max[i] = Math.max(max[i], b.max[i]);
  }
  return {
    min,
    max,
    unit: "mm",
    quality:
      a.quality === "estimated" || b.quality === "estimated"
        ? "estimated"
        : "parameter-derived",
  };
}
function place(
  range: BoundsCoverage,
  m: readonly number[],
  purpose: BoundsPurpose,
): BoundsCoverage {
  if (range.coverage !== "conservative") return range;
  const min: Point3 = [Infinity, Infinity, Infinity],
    max: Point3 = [-Infinity, -Infinity, -Infinity];
  const from = range.bounds;
  // The browser may store both the input positions and the baked result in Float32.
  const lower = (n: number) =>
    purpose === "display" ? Math.min(n, Math.fround(n)) : n;
  const upper = (n: number) =>
    purpose === "display" ? Math.max(n, Math.fround(n)) : n;
  const interval = (i: number) => [lower(from.min[i]), upper(from.max[i])];
  const [xs, ys, zs] = axes.map(interval);
  for (const x of xs)
    for (const y of ys)
      for (const z of zs) {
        for (const i of axes) {
          const n = m[i] * x + m[4 + i] * y + m[8 + i] * z + m[12 + i];
          min[i] = Math.min(min[i], n);
          max[i] = Math.max(max[i], n);
        }
      }
  for (const i of axes) {
    min[i] = lower(min[i]);
    max[i] = upper(max[i]);
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite))
    return { coverage: "unknown" };
  return { coverage: "conservative", bounds: { ...from, min, max } };
}
type Op = "Union" | "Difference" | "Intersection";
type Composition = { op: Op; operands: readonly (number | undefined)[] };
type BoundsNode = {
  id?: number;
  visible: boolean;
  transformMatrix: readonly number[];
};
function combine(
  op: Op,
  a: BoundsCoverage,
  b: BoundsCoverage,
  purpose: BoundsPurpose,
): BoundsCoverage {
  if (a.coverage === "unknown" || b.coverage === "unknown")
    return { coverage: "unknown" };
  if (op === "Difference" || (op === "Intersection" && purpose === "display"))
    return a;
  if (a.coverage === "empty") return op === "Union" ? b : a;
  if (b.coverage === "empty") return op === "Union" ? a : b;
  if (op === "Union")
    return { coverage: "conservative", bounds: union(a.bounds, b.bounds) };
  const min: Point3 = [...a.bounds.min],
    max: Point3 = [...a.bounds.max];
  for (const i of axes) {
    min[i] = Math.max(min[i], b.bounds.min[i]);
    max[i] = Math.min(max[i], b.bounds.max[i]);
    if (min[i] > max[i]) return { coverage: "empty" };
  }
  return {
    coverage: "conservative",
    bounds: {
      min,
      max,
      unit: "mm",
      quality:
        a.bounds.quality === "estimated" || b.bounds.quality === "estimated"
          ? "estimated"
          : "parameter-derived",
    },
  };
}

/** Evaluate visible roots and their hidden dependencies. Each memoized result includes its own placement. */
export function aggregateGeometryBounds<T extends BoundsNode>(
  entities: readonly T[],
  index: ReadonlyMap<number, T>,
  purpose: BoundsPurpose,
  describe: (e: T) => BoundsCoverage | Composition,
  incomplete = false,
): BoundsCoverage {
  const memo = new Map<number, BoundsCoverage>(),
    active = new Set<number>();
  const unknown = { coverage: "unknown" } as const;
  const diagnostics: GeometryDiagnostic[] = [];
  let total: GeometryBounds | undefined;
  function evaluate(root: T): BoundsCoverage {
    if (root.id === undefined || index.get(root.id) !== root) return unknown;
    const stack: { id: number; finish?: Composition }[] = [{ id: root.id }];
    while (stack.length) {
      const { id, finish } = stack.pop()!;
      if (finish) active.delete(id);
      if (memo.has(id)) continue;
      const node = index.get(id);
      if (!node || active.has(id)) {
        diagnostics.push({
          stage: "analyze",
          severity: "warning",
          code: node ? "cyclic-reference" : "missing-reference",
          message: node
            ? "Cyclic Boolean dependency"
            : "Operand has no unique declaration",
          location: { entityId: id },
        });
        memo.set(id, unknown);
        continue;
      }
      if (finish) {
        const [a, b] = finish.operands;
        memo.set(
          id,
          place(
            combine(
              finish.op,
              a === undefined ? unknown : (memo.get(a) ?? unknown),
              b === undefined ? unknown : (memo.get(b) ?? unknown),
              purpose,
            ),
            node.transformMatrix,
            purpose,
          ),
        );
        continue;
      }
      if (!isUsableAffineMatrix(node.transformMatrix)) {
        diagnostics.push({
          stage: "analyze",
          severity: "warning",
          code: "invalid-source-matrix",
          message: "Invalid placed bounds",
          location: { entityId: id },
        });
        memo.set(id, unknown);
        continue;
      }
      const shape = describe(node);
      if ("op" in shape) {
        active.add(id);
        stack.push({ id, finish: shape });
        for (const operand of shape.operands)
          if (operand !== undefined && !memo.has(operand))
            stack.push({ id: operand });
      } else {
        if (shape.coverage === "unknown" && shape.diagnostics)
          diagnostics.push(...shape.diagnostics);
        memo.set(id, place(shape, node.transformMatrix, purpose));
      }
    }
    return memo.get(root.id) ?? unknown;
  }
  for (const root of entities) {
    if (!root.visible) continue;
    const range = evaluate(root);
    if (range.coverage === "unknown") incomplete = true;
    if (range.coverage === "conservative")
      total = total ? union(total, range.bounds) : range.bounds;
  }
  if (incomplete)
    return {
      coverage: "unknown",
      ...(total ? { knownBounds: total } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
    };
  return total
    ? { coverage: "conservative", bounds: total }
    : { coverage: "empty" };
}

export function queryXmlModBounds(
  doc: RawXmlModDocument,
  options: { purpose: BoundsPurpose },
): BoundsCoverage {
  const invalid = new Set(
    doc.diagnostics
      .filter(
        (d) =>
          d.code === "invalid-source-matrix" || d.code === "conflicting-field",
      )
      .map((d) => d.ordinal),
  );
  const result = aggregateGeometryBounds(
    doc.entities,
    doc.entitiesById,
    options.purpose,
    (e) => {
      if (invalid.has(e.ordinal) || !e.primitive)
        return { coverage: "unknown" };
      if (e.operandIds) {
        const attrs = e.primitive.rawAttributes;
        const name = (attrs.Type ?? attrs.TYPE ?? "").trim().toLowerCase();
        const op =
          name === "union"
            ? "Union"
            : name === "difference"
              ? "Difference"
              : name === "intersection"
                ? "Intersection"
                : undefined;
        return op ? { op, operands: e.operandIds } : { coverage: "unknown" };
      }
      const result = interpretXmlModPrimitive(e.primitive);
      return result.status === "standard"
        ? analyzePrimitive(result.canonical).range
        : {
            coverage: "unknown",
            diagnostics: result.diagnostics.map((d) => ({
              ...d,
              location: { ...d.location, entityId: e.id, ordinal: e.ordinal },
            })),
          };
    },
    doc.status === "failed" ||
      doc.diagnostics.some(
        (d) => d.ordinal === undefined && d.severity !== "info",
      ),
  );
  if (result.coverage !== "unknown") return result;
  return {
    ...result,
    diagnostics: [
      ...doc.diagnostics.map((d) => ({
        stage: "parse" as const,
        severity: d.severity,
        code: d.code,
        message: d.message,
        location: {
          path: doc.sourcePath,
          ordinal: d.ordinal,
          entityId: d.entityId,
          sourceTag: d.sourceTag,
          field: d.field,
        },
      })),
      ...(result.diagnostics ?? []).map((d) => ({
        ...d,
        location: { ...d.location, path: doc.sourcePath },
      })),
    ],
  };
}
