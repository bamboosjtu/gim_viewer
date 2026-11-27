import { checkGeometryBudget } from "./geometryBudget.js";
import { plateMesh } from "./perforatedPlate.js";
import { profileMesh } from "./profileFamilies.js";
import { bodyMesh } from "./revolvedBodies.js";
import { curveMesh } from "./curveCable.js";
import {
  loftRings,
  rectangle,
  invalidShape,
  type MeshBuild,
} from "./profiles.js";
import type { Point3 } from "./analysisGeometry.js";
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

function cylinder(
  radius: number,
  height: number,
  segments: number,
  topRadius = radius,
  offsetX = 0,
  offsetY = 0,
): MeshData {
  // Side and cap rings meet at the same positions but have distinct normals.
  const bottomCenter = segments * 4,
    topCenter = bottomCenter + 1;
  const positions = new Float32Array((topCenter + 1) * 3),
    normals = new Float32Array(positions.length);
  const indices = new Uint16Array(segments * 12);
  positions[topCenter * 3 + 2] = height;
  positions[topCenter * 3] = offsetX;
  positions[topCenter * 3 + 1] = offsetY;
  normals[bottomCenter * 3 + 2] = -1;
  normals[topCenter * 3 + 2] = 1;
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    const nx = Math.sin(angle),
      ny = -Math.cos(angle);
    const bottom = [radius * nx, radius * ny, 0],
      top = [offsetX + topRadius * nx, offsetY + topRadius * ny, height];
    const sideTop = segments + i,
      capBottom = 2 * segments + i,
      capTop = 3 * segments + i;
    positions.set(bottom, i * 3);
    positions.set(top, sideTop * 3);
    positions.set(bottom, capBottom * 3);
    positions.set(top, capTop * 3);
    const nz = (radius - topRadius - offsetX * nx - offsetY * ny) / height;
    const norm = Math.hypot(nx, ny, nz);
    const normal = [nx / norm, ny / norm, nz / norm];
    normals.set(normal, i * 3);
    normals.set(normal, sideTop * 3);
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
  const mesh = buildLocal(primitive, segments, options);
  if ("code" in mesh) return failure(mesh);
  return {
    status:
      "family" in primitive && primitive.approximation
        ? "modelEstimate" in primitive && primitive.modelEstimate
          ? "estimated"
          : "preview-only"
        : "standard-derived",
    mesh,
    lod,
    compilerVersion,
    diagnostics:
      "family" in primitive && primitive.approximation
        ? [
            {
              code: "approximated-geometry",
              stage: "compile",
              severity: "info",
              message: primitive.approximation,
            },
          ]
        : [],
  };
}

function sphere(radius: number, n: number, stacks: number): MeshData {
  const north = n * (stacks - 1) + 1;
  const positions = new Float32Array((north + 1) * 3),
    normals = new Float32Array(positions.length);
  positions[2] = -radius;
  normals[2] = -1;
  positions[3 * north + 2] = radius;
  normals[3 * north + 2] = 1;
  const indices = new Uint16Array(6 * n * (stacks - 1));
  let cursor = 0;
  for (let k = 1; k < stacks; k++) {
    const latitude = (Math.PI * k) / stacks - Math.PI / 2;
    for (let j = 0; j < n; j++) {
      const a = 1 + (k - 1) * n + j,
        b = 1 + (k - 1) * n + ((j + 1) % n),
        theta = (2 * Math.PI * j) / n;
      const normal = [
        Math.cos(latitude) * Math.cos(theta),
        Math.cos(latitude) * Math.sin(theta),
        Math.sin(latitude),
      ];
      normals.set(normal, a * 3);
      positions.set(
        normal.map((v) => v * radius),
        a * 3,
      );
      if (k === 1) {
        indices.set([0, b, a], cursor);
        cursor += 3;
      }
      if (k === stacks - 1) {
        indices.set([north, a, b], cursor);
        cursor += 3;
      } else {
        indices.set([a, b, b + n, a, b + n, a + n], cursor);
        cursor += 6;
      }
    }
  }
  return { positions, normals, indices };
}

function buildLocal(
  p: CanonicalPrimitive,
  segments: number,
  options: GeometryCompileOptions,
): MeshBuild {
  if ("family" in p) {
    if (p.family === "body") return bodyMesh(p, segments, options);
    if (p.family === "curve") return curveMesh(p, options);
    return profileMesh(p, segments, options);
  }
  const positive = (...dims: number[]) =>
    dims.every((n) => Math.fround(n) > 0 && Number.isFinite(Math.fround(n)));
  const extent: GeometryDiagnostic = {
    code: "invalid-mesh-extent",
    severity: "error",
    stage: "compile",
    message: "Extent must be positive and representable in Float32",
  };
  switch (p.kind) {
    case "TerminalBlock":
    case "RectangularFixedPlate":
    case "CircularFixedPlate":
      return plateMesh(p, segments, options.limits);
    case "Cuboid":
      return positive(p.length / 2, p.width / 2, p.height)
        ? (checkGeometryBudget({ maxVertices: 24 }, options.limits) ??
            cuboid(p.length / 2, p.width / 2, p.height))
        : extent;
    case "Sphere": {
      const stacks = Math.max(4, segments / 2);
      return positive(p.radius)
        ? (checkGeometryBudget(
            { maxVertices: 2 + segments * (stacks - 1) },
            options.limits,
          ) ?? sphere(p.radius, segments, stacks))
        : extent;
    }
    case "Cylinder":
    case "TruncatedCone":
    case "EccentricTruncatedCone": {
      const br = p.kind === "Cylinder" ? p.radius : p.bottomRadius,
        tr = p.kind === "Cylinder" ? p.radius : p.topRadius;
      const dx = p.kind === "EccentricTruncatedCone" ? p.offsetX : 0,
        dy = p.kind === "EccentricTruncatedCone" ? p.offsetY : 0;
      if (
        !positive(br, tr, p.height) ||
        !Number.isFinite(Math.fround(Math.max(Math.abs(dx), Math.abs(dy)) + tr))
      )
        return extent;
      return (
        checkGeometryBudget(
          { maxVertices: 4 * segments + 2 },
          options.limits,
        ) ?? cylinder(br, p.height, segments, tr, dx, dy)
      );
    }
    case "OffsetRectangularTable": {
      if (
        !positive(
          p.bottomLength,
          p.bottomWidth,
          p.topLength,
          p.topWidth,
          p.height,
        )
      )
        return extent;
      return loftRings(
        [rectangle(p.bottomLength, p.bottomWidth, 0)],
        [rectangle(p.topLength, p.topWidth, p.height, p.offsetX, p.offsetY)],
        options.limits,
      );
    }
    case "StretchedBody": {
      const n = p.contour.length;
      const limit = checkGeometryBudget(
        { maxContourPoints: n, maxVertices: 6 * n },
        options.limits,
      );
      if (limit) return limit;
      const top = p.contour.map(([x, y, z]): Point3 => [
        x + p.displacement[0],
        y + p.displacement[1],
        z + p.displacement[2],
      ]);
      return loftRings([[...p.contour]], [top], options.limits, true);
    }
    default:
      return invalidShape("Unsupported canonical primitive");
  }
}
