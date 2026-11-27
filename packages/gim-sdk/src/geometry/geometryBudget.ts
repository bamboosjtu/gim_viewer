import type {
  GeometryDiagnostic,
  GeometryLimits,
} from "./primitiveContracts.js";

export const DEFAULT_GEOMETRY_LIMITS: Readonly<GeometryLimits> = Object.freeze({
  maxVertices: 1_048_576,
  maxContourPoints: 65_536,
  maxHoles: 4_096,
  maxCurveSegments: 256,
});

export function checkGeometryBudget(
  requested: Partial<GeometryLimits>,
  limits: Partial<GeometryLimits> = {},
): GeometryDiagnostic | undefined {
  for (const name of Object.keys(
    DEFAULT_GEOMETRY_LIMITS,
  ) as (keyof GeometryLimits)[]) {
    const allowed = limits[name] ?? DEFAULT_GEOMETRY_LIMITS[name];
    if (!Number.isSafeInteger(allowed) || allowed <= 0)
      throw new RangeError(`Invalid geometry budget: ${name}`);
    const count = requested[name] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count > allowed) {
      return {
        code: "capacity-exceeded",
        stage: "compile",
        severity: "error",
        message: `Geometry budget exceeded: ${name}`,
        limit: { name, requested: count, allowed },
      };
    }
  }
}
