import { composePlacement, isUsableAffineMatrix } from "../affineMatrix.js";
import {
  placeGeometryRange,
  unionGeometryBounds,
  type GeometryBounds,
  type Point3,
} from "../analysisGeometry.js";
import type {
  GeometryBatch,
  GeometrySourceAddress,
  MeshTemplate,
  PlacedPart,
} from "../contracts/geometryBatch.js";
import type { GeometryDiagnostic } from "../primitiveContracts.js";

/** Describes placed coordinates, independently of the IFC project's authoring units.
 * K maps source -> normalized. A provider that restored source coordinates uses "source". */
export type IfcCoordinateFrame =
  | { readonly kind: "source" }
  | {
      readonly kind: "coordination-applied";
      readonly coordinationMatrix: readonly number[];
    };
export interface IfcMeshPart {
  readonly geometryId?: number;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly matrix: readonly number[];
  readonly color: readonly number[];
}
export interface IfcObjectInput {
  readonly sourceVersion: string;
  readonly sourcePath: string;
  readonly modelId: string;
  readonly expressId: number;
  readonly globalId: string;
  readonly frame: IfcCoordinateFrame;
  readonly parts: readonly IfcMeshPart[];
}

const C = [1000, 0, 0, 0, 0, 0, 1000, 0, 0, -1000, 0, 0, 0, 0, 0, 1];
const inverseC = [0.001, 0, 0, 0, 0, 0, -0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1];

function inverseAffine(m: readonly number[]): number[] | undefined {
  if (!isUsableAffineMatrix(m)) return;
  const [a, b, c, , d, e, f, , g, h, i, , x, y, z] = m;
  const n = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    0,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    0,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
    0,
    0,
    0,
    0,
    1,
  ];
  const det = a * n[0] + b * n[4] + c * n[8];
  for (let col = 0; col < 3; col++)
    for (let row = 0; row < 3; row++) n[4 * col + row] /= det;
  for (let row = 0; row < 3; row++)
    n[12 + row] = -(n[row] * x + n[4 + row] * y + n[8 + row] * z);
  return n;
}

// web-ifc sometimes supplies an unset normal. Visit faces only when the split pass encountered one.
function repairNormals(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  missing: Set<number>,
) {
  for (let i = 0; i < indices.length && missing.size; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    if (!missing.has(a) && !missing.has(b) && !missing.has(c)) continue;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const x = uy * vz - uz * vy,
      y = uz * vx - ux * vz,
      z = ux * vy - uy * vx,
      length = Math.hypot(x, y, z);
    if (!length || !Number.isFinite(length)) continue;
    for (const offset of [a, b, c])
      if (missing.delete(offset))
        normals.set([x / length, y / length, z / length], offset);
  }
  // An unused vertex or degenerate face has no oriented surface.
  for (const offset of missing) normals[offset + 2] = 1;
}

function localTemplate(p: IfcMeshPart, quality: MeshTemplate["quality"]) {
  if (!p.vertices.length || p.vertices.length % 6 || p.indices.length % 3)
    return;
  const positions = new Float32Array(p.vertices.length / 2),
    normals = new Float32Array(positions.length);
  let missing: Set<number> | undefined;
  const min: Point3 = [Infinity, Infinity, Infinity],
    max: Point3 = [-Infinity, -Infinity, -Infinity];
  for (let j = 0, k = 0; j < p.vertices.length; j += 6, k += 3) {
    positions[k] = p.vertices[j] * 1000;
    positions[k + 1] = -p.vertices[j + 2] * 1000;
    positions[k + 2] = p.vertices[j + 1] * 1000;
    const x = p.vertices[j + 3],
      y = p.vertices[j + 4],
      z = p.vertices[j + 5],
      length = Math.hypot(x, y, z);
    if (length && Number.isFinite(length)) {
      normals[k] = x / length;
      normals[k + 1] = -z / length;
      normals[k + 2] = y / length;
    } else (missing ??= new Set()).add(k);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[k + axis]);
      max[axis] = Math.max(max[axis], positions[k + axis]);
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return;
  if (missing) repairNormals(positions, normals, p.indices, missing);
  const bounds: GeometryBounds = {
    min,
    max,
    quality: "mesh-derived",
    unit: "mm",
  };
  const template: MeshTemplate = {
    kind: "mesh",
    mesh: { positions, normals, indices: p.indices },
    quality,
  };
  return { bounds, template };
}

/** Consume owned web-ifc part buffers. All engine calls, WASM lifetimes and the viewer anchor belong to the caller. */
export function compileIfcObject(
  input: IfcObjectInput,
  lod: 1 | 2 = 2,
): GeometryBatch {
  const { sourceVersion, sourcePath, modelId, expressId, globalId } = input;
  const address: GeometrySourceAddress = {
    format: "ifc",
    sourceVersion,
    sourcePath,
    modelId,
    expressId,
    globalId,
    rootOccurrence: JSON.stringify([modelId, expressId]),
    assemblyPath: "",
  };
  const templates = new Map<string, MeshTemplate>(),
    localBounds = new Map<string, GeometryBounds>();
  const parts: PlacedPart[] = [],
    diagnostics: GeometryDiagnostic[] = [];
  let total: GeometryBounds | undefined;
  const quality = lod === 2 ? "source-derived" : "preview-only";
  let toNeutral: readonly number[] | undefined = C;
  if (input.frame.kind === "coordination-applied") {
    const restore = inverseAffine(input.frame.coordinationMatrix);
    toNeutral = restore && composePlacement(C, restore);
  }
  const issue = (code: string, message: string, ordinal?: number) =>
    diagnostics.push({
      stage: "compose",
      severity: "warning",
      code,
      message,
      location: { path: sourcePath, entityId: expressId, ordinal },
    });
  if (!toNeutral)
    issue("invalid-coordination-matrix", "Cannot restore IFC source placement");
  else
    for (const [partIndex, p] of input.parts.entries()) {
      if (!p.indices.length) continue;
      const matrix = composePlacement(
        composePlacement(toNeutral, p.matrix),
        inverseC,
      );
      if (!isUsableAffineMatrix(matrix)) {
        issue("invalid-source-matrix", "Invalid IFC part placement", partIndex);
        continue;
      }
      const key = JSON.stringify([
        "ifc",
        sourceVersion,
        sourcePath,
        modelId,
        lod,
        p.geometryId ?? [expressId, partIndex],
      ]);
      let bounds = localBounds.get(key);
      if (!bounds) {
        const local = localTemplate(p, quality);
        if (!local) {
          issue(
            "invalid-ifc-part",
            "No representable IFC triangle buffer",
            partIndex,
          );
          continue;
        }
        templates.set(key, local.template);
        bounds = local.bounds;
        localBounds.set(key, bounds);
      }
      const placed = placeGeometryRange(
        { coverage: "conservative", bounds },
        matrix,
        "analytical",
      );
      if (placed.coverage !== "conservative") {
        issue(
          "invalid-ifc-range",
          "Unrepresentable IFC part bounds",
          partIndex,
        );
        continue;
      }
      total = total ? unionGeometryBounds(total, placed.bounds) : placed.bounds;
      parts.push({
        address: { ...address, partIndex, geometryId: p.geometryId },
        templateKey: key,
        instanceId: JSON.stringify([
          sourceVersion,
          sourcePath,
          modelId,
          expressId,
          partIndex,
        ]),
        localToParent: matrix,
        quality,
        lod,
        rgba: p.color,
      });
    }
  return {
    templates,
    requestedLod: lod,
    diagnostics: [],
    objects: [
      {
        address,
        visible: true,
        parts,
        ports: [],
        diagnostics,
        availability: diagnostics.length
          ? parts.length
            ? "partial"
            : "unavailable"
          : parts.length
            ? "available"
            : "empty",
        range: diagnostics.length
          ? { coverage: "unknown", knownBounds: total }
          : total
            ? { coverage: "conservative", bounds: total }
            : { coverage: "empty" },
      },
    ],
  };
}
