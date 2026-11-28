import { expect, it } from "vitest";
import { compileTowerSkeleton } from "../formats/line-mod.js";
import { identityPlacement } from "../affineMatrix.js";
import { placeGeometrySource } from "../geometryInstances.js";
it("keeps 3D rods, isolated P, G and unresolved record ordinals independent of point-marker limits", () => {
  const a = { x: 0, y: 0, z: 0 },
    b = { x: 10, y: 20, z: 30 },
    c = { x: 200, y: 3, z: 5 },
    port = { ...b, name: "anchor" };
  const source = compileTowerSkeleton("a.mod", "sha", [
    {
      sectionIndex: 2,
      points: [a, b, c, { ...a, y: NaN }],
      rods: [
        { ordinal: 7, start: a, end: b },
        { ordinal: 8, start: b },
      ],
      ports: [port],
    },
  ]);
  const batch = placeGeometrySource(source, [
      {
        rootOccurrence: "tower",
        assemblyPath: "body",
        localToParent: identityPlacement,
      },
    ]),
    obj = batch.objects[0];
  expect(obj.availability).toBe("partial");
  expect(obj.diagnostics.map((d) => d.location?.sourceTag)).toEqual(["P", "R"]);
  expect(obj.range).toMatchObject({
    coverage: "unknown",
    knownBounds: { max: [200, 20, 30] },
  });
  expect(obj.ports[0]).toMatchObject({
    name: "anchor",
    position: [10, 20, 30],
    address: { rootOccurrence: "tower", ordinal: 2 },
    recordOrdinal: 0,
  });
  const lines = batch.templates.get(obj.parts[0].templateKey);
  expect(lines?.kind).toBe("line-segments");
  if (lines?.kind === "line-segments") {
    expect([...lines.positions]).toEqual([0, 0, 0, 10, 20, 30]);
    expect(lines.recordOrdinals).toEqual([7]);
  }
});
