import { expect, it } from "vitest";
import { compileSelectedLineAssembly } from "../formats/line-assembly.js";
import { selectedFoundationParts } from "../formats/line-foundation.js";
import { placeGeometryRange } from "../analysisGeometry.js";
import { identityPlacement } from "../affineMatrix.js";
import { placeGeometrySource } from "../geometryInstances.js";
it("places shared confirmed assembly members, cap, offset column, solid shaft, and bolt independently", () => {
  const pile = {
    shaftToRimMm: 1000,
    flareHeightMm: 0,
    rimHeightMm: 0,
    toeDepthMm: 0,
    shaftDiameterMm: 100,
    baseDiameterMm: 100,
  };
  const foundation = selectedFoundationParts({
    piles: [{ key: "pileA", topMm: [100, 50, -300], profile: pile }],
    cap: {
      centerMm: [50, 50, -300],
      widthMm: 500,
      lengthMm: 400,
      heightMm: 200,
    },
    column: {
      centerMm: [80, 120, -100],
      heightMm: 100,
      section: { kind: "circle", diameterMm: 100 },
    },
    bolts: [
      {
        key: "bolt",
        diameterMm: 20,
        lengthMm: 100,
        baseToFoundation: identityPlacement,
      },
    ],
  });
  const a = { x: 0, y: 0, z: 0 },
    b = { x: 0, y: 0, z: 2400 };
  const selected = {
    ...foundation,
    selectionKey: "leg-A",
    confirmed: true,
    sections: [
      {
        sectionIndex: 0,
        points: [a, b],
        rods: [
          {
            ordinal: 9,
            start: a,
            end: b,
            record: { kind: "tube", spec: "φ100X5" },
          },
        ],
        ports: [{ ...b, name: "G" }],
      },
    ],
  };
  const pool = new Map(),
    first = compileSelectedLineAssembly("t.mod", "sha", selected, 2, pool);
  const changed = compileSelectedLineAssembly(
    "t.mod",
    "sha",
    { ...selected, selectionKey: "leg-B" },
    2,
    pool,
  );
  const key = first.objects.find((o) => o.componentKey === "Body/0/R/9")!
    .geometry!.templateKey;
  expect(first.templates.get(key)).toBe(changed.templates.get(key));
  expect(first.variantKey).not.toBe(changed.variantKey);
  const occ = (name: string, x: number) => ({
    rootOccurrence: name,
    assemblyPath: "selected",
    localToParent: [...identityPlacement.slice(0, 12), x, 0, 0, 1],
  });
  const batch = placeGeometrySource(first, [occ("A", 0), occ("B", 5000)]);
  const world = (component: string, root: string) => {
    const obj = batch.objects.find(
      (o) =>
        o.address.componentKey === component &&
        o.address.rootOccurrence === root,
    )!;
    return placeGeometryRange(obj.range, obj.analysisToParent!, "analytical");
  };
  expect(world("pileA/shaft", "A")).toMatchObject({
    bounds: { min: [50, 0, -1300], max: [150, 100, -300] },
  });
  expect(world("column", "A")).toMatchObject({
    bounds: { min: [30, 70, -100], max: [130, 170, 0] },
  });
  expect(world("Body/0/R/9", "B")).toMatchObject({
    bounds: { min: [4950, -50, 0], max: [5050, 50, 2400] },
  });
  expect(batch.objects.find((o) => o.ports.length)?.ports[0].position).toEqual([
    0, 0, 2400,
  ]);
  expect(
    batch.objects.find((o) => o.address.componentKey === "bolt")?.parts[0]
      .quality,
  ).toBe("preview-only");
  const fallback = compileSelectedLineAssembly("t.mod", "sha", {
    ...selected,
    confirmed: false,
    missing: ["unresolved-leg"],
    solids: [],
  });
  expect(
    [...fallback.templates.values()].every((t) => t.kind === "line-segments"),
  ).toBe(true);
  expect(fallback.diagnostics[0].code).toBe("incomplete-line-selection");
});
