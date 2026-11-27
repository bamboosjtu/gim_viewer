import { checkGeometryBudget } from "./geometryBudget.js";
import type {
  CanonicalPrimitive,
  GeometryCompileOptions,
  GeometryCompileResult,
  GeometryDiagnostic,
  MeshData,
} from "./primitiveContracts.js";

export const xmlModCompilerVersion = "xml-mod-mesh-v1";
const cylinderSegments = [6, 12, 16] as const;

function cuboid(x: number, y: number, height: number): MeshData {
  const corners = [
    [-x, -y, 0],
    [x, -y, 0],
    [x, y, 0],
    [-x, y, 0],
    [-x, -y, height],
    [x, -y, height],
    [x, y, height],
    [-x, y, height],
  ];
  const faces = [
    { corners: [0, 3, 2, 1], normal: [0, 0, -1] },
    { corners: [4, 5, 6, 7], normal: [0, 0, 1] },
    { corners: [0, 1, 5, 4], normal: [0, -1, 0] },
    { corners: [1, 2, 6, 5], normal: [1, 0, 0] },
    { corners: [2, 3, 7, 6], normal: [0, 1, 0] },
    { corners: [3, 0, 4, 7], normal: [-1, 0, 0] },
  ];
  const positions = new Float32Array(24 * 3),
    normals = new Float32Array(24 * 3),
    indices = new Uint16Array(36);
  for (const [i, face] of faces.entries()) {
    const base = i * 4;
    face.corners.forEach((corner, j) => {
      positions.set(corners[corner], (base + j) * 3);
      normals.set(face.normal, (base + j) * 3);
    });
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], i * 6);
  }
  return { positions, normals, indices };
}

function cylinder(radius: number, height: number, segments: number): MeshData {
  // Side and cap rings meet at the same positions but have distinct normals.
  const bottomCenter = segments * 4,
    topCenter = bottomCenter + 1;
  const positions = new Float32Array((topCenter + 1) * 3),
    normals = new Float32Array(positions.length);
  const indices = new Uint16Array(segments * 12);
  positions[topCenter * 3 + 2] = height;
  normals[bottomCenter * 3 + 2] = -1;
  normals[topCenter * 3 + 2] = 1;
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    const nx = Math.sin(angle),
      ny = -Math.cos(angle);
    const bottom = [radius * nx, radius * ny, 0],
      top = [bottom[0], bottom[1], height];
    const sideTop = segments + i,
      capBottom = 2 * segments + i,
      capTop = 3 * segments + i;
    positions.set(bottom, i * 3);
    positions.set(top, sideTop * 3);
    positions.set(bottom, capBottom * 3);
    positions.set(top, capTop * 3);
    normals.set([nx, ny, 0], i * 3);
    normals.set([nx, ny, 0], sideTop * 3);
    normals[capBottom * 3 + 2] = -1;
    normals[capTop * 3 + 2] = 1;
    const next = (i + 1) % segments;
    indices.set(
      [
        i,
        next,
        segments + next,
        i,
        segments + next,
        sideTop,
        bottomCenter,
        2 * segments + next,
        capBottom,
        topCenter,
        capTop,
        3 * segments + next,
      ],
      i * 12,
    );
  }
  return { positions, normals, indices };
}

export function compilePrimitive(
  primitive: CanonicalPrimitive,
  options: GeometryCompileOptions = {},
): GeometryCompileResult {
  const compilerVersion = xmlModCompilerVersion;
  const lod = options.lod ?? 2;
  if (!Number.isInteger(lod) || lod < 0 || lod > 2)
    throw new RangeError("Invalid MOD mesh LOD");
  const segments = cylinderSegments[lod];
  const failure = (issue: GeometryDiagnostic): GeometryCompileResult => ({
    status: "none",
    lod,
    compilerVersion,
    diagnostics: [issue],
  });
  if (primitive.kind !== "Cuboid" && primitive.kind !== "Cylinder") {
    return failure({
      code: "unsupported-primitive",
      severity: "warning",
      stage: "compile",
      message: "Unsupported canonical primitive",
    });
  }
  const vertices = primitive.kind === "Cuboid" ? 24 : 4 * segments + 2;
  const budget = checkGeometryBudget({ maxVertices: vertices }, options.limits);
  if (budget) return failure(budget);
  const extents =
    primitive.kind === "Cuboid"
      ? [primitive.length / 2, primitive.width / 2, primitive.height]
      : [primitive.radius, primitive.height];
  if (
    !extents.every((n) => Math.fround(n) > 0 && Number.isFinite(Math.fround(n)))
  ) {
    return failure({
      code: "invalid-mesh-extent",
      severity: "error",
      stage: "compile",
      message: "Extent must be positive and representable in Float32",
    });
  }
  const mesh =
    primitive.kind === "Cuboid"
      ? cuboid(extents[0], extents[1], primitive.height)
      : cylinder(primitive.radius, primitive.height, segments);
  return {
    status: "standard-derived",
    mesh,
    lod,
    compilerVersion,
    diagnostics: [],
  };
}
