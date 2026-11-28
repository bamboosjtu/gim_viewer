import { afterEach, expect, it, vi } from "vitest";
import { parseXmlModRoot, type XmlModNode } from "../../parser/mod.js";
import * as leaves from "../compilePrimitive.js";
import * as stl from "../formats/stl.js";
import {
  compileGeometrySource,
  queryGeometryRange,
  type GeometryInput,
} from "../geometrySource.js";
import {
  geometryTransferList,
  placeGeometrySource,
} from "../geometryInstances.js";
import type {
  GeometryBatch,
  GeometryTemplate,
} from "../contracts/geometryBatch.js";

const node = (
  tagName: string,
  attrs: Record<string, string> = {},
  children: XmlModNode[] = [],
): XmlModNode => ({ tagName, attrs, children });
const entity = (id: number, shape: XmlModNode, ...other: XmlModNode[]) =>
  node("Entity", { ID: String(id) }, [shape, ...other]);
const doc = (...entities: XmlModNode[]): GeometryInput => ({
  format: "xml-mod",
  sourceVersion: "rev1",
  document: parseXmlModRoot(
    node("Device", {}, [node("Entities", {}, entities)]),
    { sourcePath: "MOD/assembly.mod", matrixLayout: "project-column-major" },
  ),
});
const box = node("Cuboid", { L: "4", W: "6", H: "8" });
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const a = { rootOccurrence: "A", assemblyPath: "solid:0", localToParent: I };
afterEach(() => {
  vi.restoreAllMocks();
});

it("compiles matching shapes once across declarations and occurrences, and retains local ports", () => {
  const compile = vi.spyOn(leaves, "compilePrimitive");
  const source = compileGeometrySource(
    doc(
      entity(7, box),
      entity(8, box, node("Color", { R: "8", G: "7", B: "6", A: "0" })),
    ),
  );
  const batch = placeGeometrySource(source, [a, { ...a, rootOccurrence: "B" }]);
  expect(compile).toHaveBeenCalledTimes(1);
  expect(batch.objects).toHaveLength(4);
  expect(batch.templates.size).toBe(1);
  expect(new Set(batch.objects.map((o) => o.parts[0].instanceId)).size).toBe(4);
  expect(batch.objects[1].parts[0].sourceColor).toEqual({
    R: "8",
    G: "7",
    B: "6",
    A: "0",
  });
  for (const object of batch.objects) {
    expect(object.availability).toBe("available");
    expect(object.parts[0].quality).toBe("standard-derived");
    expect(object.range).toMatchObject({
      coverage: "conservative",
      bounds: { min: [-2, -3, 0], max: [2, 3, 8] },
    });
    expect(object.ports[1]).toMatchObject({
      position: [0, 0, 8],
      address: object.address,
    });
  }
});
it("keeps malformed declarations, hidden operands, empty and unknown coverage distinguishable", () => {
  const bad = node("TransformMatrix", { Value: "broken" });
  const input = doc(
    entity(1, box, bad),
    entity(2, node("Unknown")),
    node("Entity", { ID: "3", Visible: "false" }, [box]),
    entity(4, node("Boolean", { Type: "Union", Entity1: "1", Entity2: "3" })),
  );
  const source = compileGeometrySource(input);
  const batch = placeGeometrySource(source, [a]);
  expect(batch.objects.map((o) => o.availability)).toEqual([
    "partial",
    "unavailable",
    "available",
    "unavailable",
  ]);
  expect(batch.objects[2].visible).toBe(false);
  expect(batch.objects[0].diagnostics[0].location).toMatchObject({
    path: "MOD/assembly.mod",
    ordinal: 1,
    entityId: 1,
  });
  expect(batch.objects[1].range.coverage).toBe("unknown");
  const invalid = placeGeometrySource(source, [{ ...a, localToParent: [] }]);
  expect(invalid.objects[0]).toMatchObject({
    availability: "unavailable",
    parts: [],
    diagnostics: expect.arrayContaining([
      expect.objectContaining({
        code: "invalid-source-matrix",
        stage: "compose",
      }),
    ]),
  });
  expect(
    placeGeometrySource(compileGeometrySource(doc()), [a]).objects[0],
  ).toMatchObject({
    availability: "empty",
    parts: [],
    range: { coverage: "empty" },
  });
  const short = {
    format: "stl" as const,
    bytes: new Uint8Array(2),
    sourceVersion: "a",
    sourcePath: "MOD/bad.stl",
  };
  expect(
    placeGeometrySource(compileGeometrySource(short), [a]).objects[0],
  ).toMatchObject({
    availability: "unavailable",
    diagnostics: [{ location: { path: "MOD/bad.stl" } }],
    range: { coverage: "unknown" },
  });
  expect(queryGeometryRange(short, { purpose: "analytical" }).coverage).toBe(
    "unknown",
  );
});
it("answers both range requests without compiling a primitive or STL mesh", () => {
  const compile = vi.spyOn(leaves, "compilePrimitive");
  const decode = vi.spyOn(stl, "compileStl");
  const input = doc(entity(1, box));
  expect(queryGeometryRange(input, { purpose: "display" })).toMatchObject({
    coverage: "conservative",
    bounds: { max: [2, 3, 8] },
  });
  const raw = {
    format: "stl" as const,
    bytes: new Uint8Array(84),
    sourceVersion: "a",
    sourcePath: "MOD/empty.stl",
  };
  expect(queryGeometryRange(raw, { purpose: "analytical" })).toEqual({
    coverage: "empty",
  });
  expect(compile).not.toHaveBeenCalled();
  expect(decode).not.toHaveBeenCalled();
  expect(compileGeometrySource(raw).objects[0].availability).toBe("empty");
});
it("decodes one STL once and keeps a skipped facet diagnostic on each occurrence", () => {
  const decode = vi.spyOn(stl, "compileStl");
  const bytes = new Uint8Array(184),
    view = new DataView(bytes.buffer);
  view.setUint32(80, 2, true);
  view.setFloat32(108, 2, true);
  view.setFloat32(124, 3, true);
  const source = compileGeometrySource(
    { format: "stl", bytes, sourcePath: "MOD/t.stl", sourceVersion: "sha" },
    { lod: 0 },
  );
  const batch = placeGeometrySource(source, [
    a,
    { ...a, referencePath: "solid:1" },
  ]);
  expect(decode).toHaveBeenCalledTimes(1);
  expect(batch.requestedLod).toBe(0);
  expect(batch.templates.size).toBe(1);
  for (const obj of batch.objects)
    expect(obj).toMatchObject({
      availability: "available",
      parts: [{ quality: "source-derived" }],
      range: { bounds: { min: [0, 0, 0], max: [2, 3, 0] } },
      diagnostics: [
        { code: "degenerate-stl-facet", location: { path: "MOD/t.stl" } },
      ],
    });
});
it("deduplicates transfer by underlying buffer even across attributes and representations", () => {
  const backing = new ArrayBuffer(128);
  const templates = new Map<string, GeometryTemplate>([
    [
      "mesh",
      {
        kind: "mesh",
        quality: "source-derived",
        mesh: {
          positions: new Float32Array(backing, 0, 9),
          normals: new Float32Array(backing, 36, 9),
          indices: new Uint16Array(backing, 72, 3),
          uvs: new Float32Array(backing, 80, 6),
        },
      },
    ],
    [
      "segments",
      { kind: "line-segments", positions: new Float32Array(backing, 0, 6) },
    ],
  ]);
  const batch: GeometryBatch = { templates, objects: [], diagnostics: [] };
  expect(geometryTransferList(batch, "move")).toEqual([backing]);
  expect(geometryTransferList(batch, "retain")).toEqual([]);
});
