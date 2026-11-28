import type { GeometryBounds, Point3 } from "../analysisGeometry.js";
import type {
  CompiledGeometrySource,
  GeometryTemplate,
  LocalGeometryObject,
  NamedGeometryPort,
} from "../contracts/geometryBatch.js";
import type { GeometryDiagnostic } from "../primitiveContracts.js";

export interface LinePointMm {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface TowerSkeletonSection {
  readonly sectionIndex: number;
  readonly points: readonly LinePointMm[];
  readonly rods: readonly {
    ordinal: number;
    start?: LinePointMm;
    end?: LinePointMm;
  }[];
  readonly ports: readonly (LinePointMm & { name: string })[];
}
import { identityPlacement } from "../affineMatrix.js";
function finite(p: LinePointMm | undefined): p is LinePointMm {
  return (
    !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
  );
}
function xyz(p: LinePointMm): Point3 {
  return [p.x, p.y, p.z];
}

/** Consumes resolved source records in tower-local mm; topology lookup and height selection belong to the caller. */
export function compileTowerSkeleton(
  sourcePath: string,
  sourceVersion: string,
  sections: readonly TowerSkeletonSection[],
): CompiledGeometrySource {
  const templates = new Map<string, GeometryTemplate>();
  const objects: LocalGeometryObject[] = sections.map((section) => {
    const ordinal = section.sectionIndex,
      positions: number[] = [],
      recordOrdinals: number[] = [],
      ports: Omit<NamedGeometryPort, "address">[] = [],
      diagnostics: GeometryDiagnostic[] = [];
    const min: Point3 = [Infinity, Infinity, Infinity],
      max: Point3 = [-Infinity, -Infinity, -Infinity];
    const include = (p: LinePointMm) => {
      min[0] = Math.min(min[0], p.x);
      min[1] = Math.min(min[1], p.y);
      min[2] = Math.min(min[2], p.z);
      max[0] = Math.max(max[0], p.x);
      max[1] = Math.max(max[1], p.y);
      max[2] = Math.max(max[2], p.z);
    };
    const issue = (tag: string, i: number) =>
      diagnostics.push({
        code: "unresolved-line-record",
        stage: "interpret",
        severity: "warning",
        message: `Section ${ordinal}, ${tag} record ${i} lacks a 3D point`,
        location: { path: sourcePath, sourceTag: tag, ordinal: i },
      });
    section.points.forEach((p, i) => (finite(p) ? include(p) : issue("P", i)));
    for (const rod of section.rods) {
      if (!finite(rod.start) || !finite(rod.end)) {
        issue("R", rod.ordinal);
        continue;
      }
      include(rod.start);
      include(rod.end);
      positions.push(...xyz(rod.start), ...xyz(rod.end));
      recordOrdinals.push(rod.ordinal);
    }
    section.ports.forEach((p, i) => {
      if (!finite(p)) {
        issue("G", i);
        return;
      }
      include(p);
      ports.push({
        name: p.name,
        position: xyz(p),
        unit: "mm",
        quality: "standard-derived",
        recordOrdinal: i,
      });
    });
    const templateKey = JSON.stringify([
      "line-mod",
      sourceVersion,
      sourcePath,
      "skeleton",
      ordinal,
    ]);
    if (positions.length)
      templates.set(templateKey, {
        kind: "line-segments",
        positions: new Float32Array(positions),
        recordOrdinals,
      });
    const bounds: GeometryBounds | undefined = Number.isFinite(min[0])
      ? { min, max, unit: "mm", quality: "parameter-derived" }
      : undefined;
    return {
      ordinal,
      visible: true,
      localToSource: identityPlacement,
      geometry: positions.length
        ? { templateKey, quality: "preview-only" }
        : undefined,
      ports,
      diagnostics,
      availability: diagnostics.length
        ? bounds
          ? "partial"
          : "unavailable"
        : bounds
          ? "available"
          : "empty",
      range: diagnostics.length
        ? { coverage: "unknown", knownBounds: bounds }
        : bounds
          ? { coverage: "conservative", bounds }
          : { coverage: "empty" },
    };
  });
  return {
    sourceVersion,
    sourcePath,
    format: "line-mod",
    objects,
    templates,
    diagnostics: [],
  };
}
