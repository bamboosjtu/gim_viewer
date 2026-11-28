import { identityPlacement } from "../affineMatrix.js";
import type { GeometryBounds, Point3 } from "../analysisGeometry.js";
import type {
  CompiledGeometrySource,
  GeometryTemplate,
  LocalGeometryObject,
} from "../contracts/geometryBatch.js";
import type { GeometryDiagnostic, GeometryLod } from "../primitiveContracts.js";
import { add3, sub3, unit3, sweepTube } from "../sweep.js";

export interface WireEnd {
  position: Point3;
  reference: string;
  quality: "source-derived" | "preview-only";
}
export interface WireLane {
  ordinal?: number;
  start?: WireEnd;
  end?: WireEnd;
  /** Confirmed intermediate vertices of an engineering polyline (local project mm). */ viaMm?: readonly Point3[];
  pathKind?: "source-polyline" | "endpoint-chord";
}
export interface LineSpanInput {
  /** Host identity for the selected tower placements and engineering frame. */
  variantKey: string;
  sourcePath: string;
  sourceVersion: string;
  lanes: readonly WireLane[];
  splitCount: number;
  outsideDiameterMm?: number;
  sourceLengthMm?: number;
}
/** A declared outer diameter is meaningful only with a known path. Endpoint chords retain preview quality. */
export function compileLineSpan(input: LineSpanInput, lod: GeometryLod = 2) {
  const templates = new Map<string, GeometryTemplate>(),
    objects: LocalGeometryObject[] = [],
    diagnostics: GeometryDiagnostic[] = [];
  const lengths: {
    lane: number;
    chordMm: number;
    polylineMm: number;
    radialErrorMm?: number;
  }[] = [];
  const completeLayout =
    input.splitCount === 1 ||
    (input.lanes.length === input.splitCount &&
      input.lanes.every((lane) => lane.start && lane.end));
  let located = 0;
  for (const [index, lane] of input.lanes.entries()) {
    const ordinal = lane.ordinal ?? index;
    const ends = [lane.start, lane.end].map((e) =>
      e && e.position.every(Number.isFinite) ? e : undefined,
    );
    const [a, b] = ends,
      origin = a?.position ?? b?.position ?? [0, 0, 0];
    const placement = [...identityPlacement.slice(0, 12), ...origin, 1];
    const ports = ends.flatMap((e, i) =>
      e
        ? [
            {
              name: i ? "end" : "start",
              position: sub3(e.position, origin),
              unit: "mm" as const,
              quality:
                e.quality === "source-derived"
                  ? ("standard-derived" as const)
                  : ("estimated" as const),
              referencePath: e.reference,
            },
          ]
        : [],
    );
    const warn = (code: string) => ({
      code,
      message: code,
      stage: "interpret" as const,
      severity: "warning" as const,
      location: { path: input.sourcePath, ordinal },
    });
    const local: GeometryDiagnostic[] = [];
    let geometry: LocalGeometryObject["geometry"],
      bounds: GeometryBounds | undefined;
    const points: Point3[] = [];
    let length = 0;
    const include = (p: Point3) => {
      if (!bounds) {
        bounds = {
          min: [...p],
          max: [...p],
          unit: "mm",
          quality: "parameter-derived",
        };
        return;
      }
      for (let k = 0; k < 3; k++) {
        bounds.min[k] = Math.min(bounds.min[k], p[k]);
        bounds.max[k] = Math.max(bounds.max[k], p[k]);
      }
    };
    for (const port of ports) include(port.position);
    if (a && b) {
      located++;
      const mids = lane.viaMm ?? [];
      const valid = mids.every((p) => p.every(Number.isFinite));
      if (!valid) local.push(warn("invalid-intermediate-point"));
      for (const p of [a.position, ...(valid ? mids : []), b.position]) {
        const q = sub3(p, origin),
          last = points[points.length - 1],
          d = last ? Math.hypot(...sub3(q, last)) : 0;
        if (last && !d) continue;
        length += d;
        points.push(q);
        include(q);
      }
      const sourcePath =
        valid &&
        lane.pathKind === "source-polyline" &&
        a.quality === "source-derived" &&
        b.quality === "source-derived";
      const quality = sourcePath ? "source-derived" : "preview-only";
      const key = JSON.stringify([
        "line-span",
        input.sourceVersion,
        input.sourcePath,
        input.variantKey,
        ordinal,
        lod,
      ]);
      if (points.length >= 2) {
        const radius = (input.outsideDiameterMm ?? 0) / 2,
          sides = [6, 12, 24][lod];
        let radialErrorMm: number | undefined;
        // A lone attachment in a declared bundle locates the bundle, but cannot locate the individual tubes.
        if (radius > 0 && Number.isFinite(radius) && completeLayout) {
          const frames = points.map((center, i) => {
            const before =
                i > 0 ? unit3(sub3(center, points[i - 1])) : undefined,
              after =
                i + 1 < points.length
                  ? unit3(sub3(points[i + 1], center))
                  : undefined;
            const sum = before && after ? add3(before, after) : undefined;
            return {
              center,
              tangent:
                sum && Math.hypot(...sum) > 1e-8
                  ? unit3(sum)
                  : (after ?? before!),
            };
          });
          const mesh = sweepTube(frames, radius, false, sides);
          if ("positions" in mesh) {
            templates.set(key, { kind: "mesh", mesh, quality });
            radialErrorMm = radius * (1 - Math.cos(Math.PI / sides));
            if (bounds)
              for (let k = 0; k < 3; k++) {
                bounds.min[k] -= radius;
                bounds.max[k] += radius;
              }
          } else local.push(mesh);
        }
        if (!templates.has(key)) {
          const positions = new Float32Array(6 * (points.length - 1));
          for (let i = 1; i < points.length; i++) {
            positions.set(points[i - 1], 6 * (i - 1));
            positions.set(points[i], 6 * (i - 1) + 3);
          }
          templates.set(key, { kind: "line-segments", positions });
        }
        geometry = { templateKey: key, lod, quality };
        lengths.push({
          lane: ordinal,
          chordMm: Math.hypot(...sub3(b.position, a.position)),
          polylineMm: length,
          radialErrorMm,
        });
      } else local.push(warn("coincident-span-ends"));
    } else local.push(warn("unresolved-span-end"));
    if (bounds && geometry?.quality === "preview-only")
      bounds.quality = "estimated";
    diagnostics.push(...local);
    objects.push({
      ordinal,
      visible: true,
      componentKey: "lane/" + ordinal,
      geometry,
      ports,
      localToSource: placement,
      diagnostics: local,
      availability: local.length
        ? ports.length
          ? "partial"
          : "unavailable"
        : "available",
      range:
        local.length || geometry?.quality === "preview-only"
          ? { coverage: "unknown", knownBounds: bounds }
          : bounds
            ? { coverage: "conservative", bounds }
            : { coverage: "unknown" },
    });
  }
  if (input.splitCount > located) {
    const d: GeometryDiagnostic = {
      stage: "interpret",
      severity: "warning",
      code: "incomplete-bundle",
      message: "Declared conductors lack individual endpoints",
      location: { path: input.sourcePath },
    };
    diagnostics.push(d);
    objects.push({
      componentKey: "unresolved-bundle",
      visible: true,
      localToSource: identityPlacement,
      availability: "unavailable",
      ports: [],
      diagnostics: [d],
      range: { coverage: "unknown" },
    });
  }
  const source: CompiledGeometrySource = {
    format: "line-mod",
    sourcePath: input.sourcePath,
    sourceVersion: input.sourceVersion,
    variantKey: input.variantKey,
    objects,
    templates,
    requestedLod: lod,
    diagnostics,
  };
  return { source, lengths, sourceLengthMm: input.sourceLengthMm };
}
