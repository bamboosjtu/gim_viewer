import type { GeometryBounds, Point3 } from "../analysisGeometry.js";
import type { GeometryDiagnostic, MeshData } from "../primitiveContracts.js";
import { xmlModNumber } from "../../parser/xmlModValues.js";

export type StlFormat = "binary" | "ascii";
export interface StlCompileResult {
  format: StlFormat;
  status: "ok" | "empty" | "invalid" | "capacity-exceeded";
  triangleCount: number;
  diagnostics: readonly GeometryDiagnostic[];
  mesh?: MeshData;
  bounds?: GeometryBounds;
}
const MAX_TRIANGLES = 5_000_000;
type Input = ArrayBuffer | Uint8Array;
type Sink = {
  put: (normal: Point3, vertices: number[]) => void;
  finish: () => Pick<StlCompileResult, "mesh" | "bounds">;
};

function meshSink(knownCount?: number): Sink {
  type Chunk = { positions: Float32Array; normals: Float32Array; used: number };
  const chunks: Chunk[] = [];
  let size = 0;
  const allocate = (faces: number): Chunk => ({
    positions: new Float32Array(faces * 9),
    normals: new Float32Array(faces * 9),
    used: 0,
  });
  if (knownCount !== undefined) chunks.push(allocate(knownCount));
  return {
    put(normal, vertices) {
      let chunk = chunks[chunks.length - 1];
      if (!chunk || chunk.used === chunk.positions.length) {
        chunk = allocate(Math.min(4096, Math.max(2, size / 9)));
        chunks.push(chunk);
      }
      chunk.positions.set(vertices, chunk.used);
      for (let i = 0; i < 9; i += 3) chunk.normals.set(normal, chunk.used + i);
      chunk.used += 9;
      size += 9;
    },
    finish() {
      const first = chunks[0];
      if (chunks.length === 1 && first.positions.length === size)
        return { mesh: { positions: first.positions, normals: first.normals } };
      const positions = new Float32Array(size),
        normals = new Float32Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        positions.set(chunk.positions.subarray(0, chunk.used), offset);
        normals.set(chunk.normals.subarray(0, chunk.used), offset);
        offset += chunk.used;
      }
      return { mesh: { positions, normals } };
    },
  };
}
function rangeSink(): Sink {
  const min: Point3 = [Infinity, Infinity, Infinity],
    max: Point3 = [-Infinity, -Infinity, -Infinity];
  return {
    put(_, v) {
      for (let i = 0; i < 9; i++) {
        const axis = i % 3;
        min[axis] = Math.min(min[axis], v[i]);
        max[axis] = Math.max(max[axis], v[i]);
      }
    },
    finish() {
      return Number.isFinite(min[0])
        ? { bounds: { min, max, unit: "mm", quality: "parameter-derived" } }
        : {};
    },
  };
}
function decode(
  input: Input,
  mode: "mesh" | "bounds",
  expected?: StlFormat,
): StlCompileResult {
  const bytes = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const solid =
    bytes[0] === 115 &&
    bytes[1] === 111 &&
    bytes[2] === 108 &&
    bytes[3] === 105 &&
    bytes[4] === 100;
  const declared = bytes.length >= 84 ? view.getUint32(80, true) : 0,
    binaryLength = 84 + 50 * declared;
  const format =
    expected ?? (solid && binaryLength !== bytes.length ? "ascii" : "binary");
  const fail = (message: string, capacity = false): StlCompileResult => ({
    format,
    status: capacity ? "capacity-exceeded" : "invalid",
    triangleCount: 0,
    diagnostics: [
      {
        stage: "parse",
        severity: "error",
        code: capacity ? "capacity-exceeded" : "invalid-stl",
        message,
      },
    ],
  });
  const normal: Point3 = [0, 0, 0],
    vertices = Array<number>(9).fill(0);
  let count = 0;
  if (format === "binary") {
    if (bytes.length < 84) return fail("Missing binary STL header");
    if (declared > MAX_TRIANGLES)
      return fail("STL exceeds five million triangles", true);
    if (
      bytes.length < binaryLength ||
      (mode === "bounds" && bytes.length !== binaryLength)
    )
      return fail("Binary STL record length mismatch");
    const sink = mode === "mesh" ? meshSink(declared) : rangeSink();
    for (let start = 84; count < declared; count++, start += 50) {
      for (let i = 0; i < 3; i++)
        normal[i] = view.getFloat32(start + 4 * i, true);
      for (let i = 0; i < 9; i++)
        vertices[i] = view.getFloat32(start + 12 + 4 * i, true);
      if (!normal.every(Number.isFinite) || !vertices.every(Number.isFinite))
        return fail("Nonfinite binary normal or vertex");
      sink.put(normal, vertices);
    }
    return {
      format,
      status: count ? "ok" : "empty",
      triangleCount: count,
      diagnostics: [],
      ...sink.finish(),
    };
  }
  if (!solid) return fail("Expected ASCII solid header");
  const text = new TextDecoder().decode(bytes),
    tokens = /\S+/g;
  const token = () => tokens.exec(text)?.[0];
  const skipName = () => {
    const eol = text.indexOf("\n", tokens.lastIndex);
    tokens.lastIndex = eol < 0 ? text.length : eol + 1;
  };
  const readVector = (out: number[], offset: number) => {
    for (let i = 0; i < 3; i++) {
      const n = Math.fround(xmlModNumber(token()));
      if (!Number.isFinite(n)) return false;
      out[offset + i] = n;
    }
    return true;
  };
  const sink = mode === "mesh" ? meshSink() : rangeSink();
  let keyword = token();
  if (keyword !== "solid") return fail("Invalid ASCII header");
  while (keyword === "solid") {
    skipName();
    keyword = token();
    while (keyword === "facet") {
      if (count >= MAX_TRIANGLES)
        return fail("STL exceeds five million triangles", true);
      if (
        token() !== "normal" ||
        !readVector(normal, 0) ||
        token() !== "outer" ||
        token() !== "loop"
      )
        return fail("Invalid ASCII STL facet");
      for (let i = 0; i < 9; i += 3)
        if (token() !== "vertex" || !readVector(vertices, i))
          return fail("Invalid ASCII STL vertex");
      if (token() !== "endloop" || token() !== "endfacet")
        return fail("Incomplete ASCII STL triangle");
      sink.put(normal, vertices);
      count++;
      keyword = token();
    }
    if (keyword !== "endsolid") return fail("Missing ASCII endsolid");
    skipName();
    keyword = token();
  }
  if (keyword !== undefined) return fail("Unexpected ASCII STL content");
  return {
    format,
    status: count ? "ok" : "empty",
    triangleCount: count,
    diagnostics: [],
    ...sink.finish(),
  };
}
export function compileStl(
  input: Input,
  options: { format?: StlFormat } = {},
): StlCompileResult {
  return decode(input, "mesh", options.format);
}
export function queryStlBounds(input: Input): StlCompileResult {
  return decode(input, "bounds");
}
