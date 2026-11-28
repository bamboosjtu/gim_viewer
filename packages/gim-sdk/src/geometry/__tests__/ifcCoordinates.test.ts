import { expect, it } from "vitest";
import { compileIfcObject, type IfcObjectInput } from "../formats/ifc.js";
import { composePlacement } from "../affineMatrix.js";
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const tr = (x: number, y = 0, z = 0) => [...I.slice(0, 12), x, y, z, 1];
const v = new Float32Array([
  1, 2, 3, 0, 0, 1, 2, 2, 3, 0, 0, 1, 1, 3, 3, 0, 0, 1,
]);
const part = {
  geometryId: 1,
  vertices: v,
  indices: new Uint32Array([0, 1, 2]),
  matrix: I,
  color: [0.1, 0.2, 0.3, 1],
};
const source: IfcObjectInput = {
  modelId: "M",
  sourcePath: "a.ifc",
  sourceVersion: "sha",
  expressId: 17,
  globalId: "GUID",
  frame: { kind: "source" },
  parts: [part],
};
const xyz = (m: readonly number[], p: ArrayLike<number>) =>
  [0, 1, 2].map(
    (i) => m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12],
  );
function first(input: IfcObjectInput) {
  const batch = compileIfcObject(input);
  const p = batch.objects[0].parts[0],
    t = batch.templates.get(p.templateKey)!;
  if (t.kind !== "mesh") throw Error();
  return { point: xyz(p.localToParent, t.mesh.positions), p, t, batch };
}
it("I1 permanent unit and axis golden: [1,2,3] m -> [1000,-3000,2000] mm", () => {
  expect(first(source).point).toEqual([1000, -3000, 2000]);
});
it("composes child then parent and keeps mirrored and scaled instances independent", () => {
  const xy = new Float32Array([
    1,
    1,
    1,
    Math.SQRT1_2,
    Math.SQRT1_2,
    0,
    2,
    0,
    1,
    Math.SQRT1_2,
    Math.SQRT1_2,
    0,
    1,
    1,
    0,
    Math.SQRT1_2,
    Math.SQRT1_2,
    0,
  ]);
  const scale = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1];
  const { point, batch, t, p } = first({
    ...source,
    parts: [
      { ...part, vertices: xy, matrix: scale },
      { ...part, vertices: xy, matrix: [-1, ...I.slice(1)] },
    ],
  });
  expect(point).toEqual([2000, -4000, 3000]);
  expect(batch.templates.size).toBe(1);
  expect(p.localToParent[0]).toBe(2);
  expect(p.localToParent[5]).toBe(4);
  expect(p.localToParent[10]).toBe(3);
  const [nx, ny, nz] = t.mesh.normals,
    n = [nx / 2, ny / 4, nz / 3],
    len = Math.hypot(...n);
  expect(n[0] / len).toBeCloseTo(3 / Math.sqrt(13));
  expect(n[2] / len).toBeCloseTo(2 / Math.sqrt(13));
  expect(
    xyz(batch.objects[0].parts[1].localToParent, t.mesh.positions),
  ).toEqual([-1000, -1000, 1000]);
  expect(Array.from(t.mesh.indices!)).toEqual([0, 1, 2]);
  const child = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  expect(
    first({
      ...source,
      parts: [
        {
          ...part,
          vertices: new Float32Array([
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
          ]),
          matrix: composePlacement(tr(10), child),
        },
      ],
    }).point,
  ).toEqual([10000, 0, 1000]);
});
it("restores K exactly once; an already restored placement follows the source path", () => {
  const vertices = v.slice();
  vertices.set([0, 0, 0]);
  const K = tr(-10);
  const normalized = first({
    ...source,
    frame: { kind: "coordination-applied", coordinationMatrix: K },
    parts: [{ ...part, vertices, matrix: tr(1) }],
  });
  const restored = first({
    ...source,
    parts: [{ ...part, vertices, matrix: tr(11) }],
  });
  expect(normalized.point).toEqual([11000, 0, 0]);
  expect(restored.point).toEqual(normalized.point);
  const rotated = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, -7, 8, 9, 1];
  expect(
    first({
      ...source,
      frame: { kind: "coordination-applied", coordinationMatrix: rotated },
      parts: [{ ...part, vertices, matrix: composePlacement(rotated, tr(11)) }],
    }).point,
  ).toEqual(normalized.point);
});
it("scopes equal Express IDs and geometry IDs by source model and isolates failed parts", () => {
  const a = first(source),
    b = first({ ...source, modelId: "M2" });
  expect(a.p.templateKey).not.toBe(b.p.templateKey);
  expect(a.p.instanceId).not.toBe(b.p.instanceId);
  expect(b.p.address).toMatchObject({
    modelId: "M2",
    expressId: 17,
    globalId: "GUID",
    geometryId: 1,
    partIndex: 0,
  });
  expect(
    compileIfcObject({ ...source, parts: [part, { ...part, matrix: [] }] })
      .objects[0],
  ).toMatchObject({
    availability: "partial",
    range: { coverage: "unknown" },
    diagnostics: [{ code: "invalid-source-matrix" }],
  });
  expect(
    compileIfcObject({
      ...source,
      frame: { kind: "coordination-applied", coordinationMatrix: [] },
    }).objects[0].availability,
  ).toBe("unavailable");
  expect(
    compileIfcObject({ ...source, parts: [] }).objects[0].availability,
  ).toBe("empty");
});
