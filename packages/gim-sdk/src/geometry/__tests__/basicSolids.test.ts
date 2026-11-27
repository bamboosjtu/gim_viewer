import { expect, it } from "vitest";
import { compilePrimitive } from "../compilePrimitive.js";
import { interpretXmlModPrimitive } from "../interpretXmlModPrimitive.js";
import { analyzePrimitive } from "../analysisGeometry.js";
import type { GeometryCompileOptions } from "../primitiveContracts.js";

it("separates translated contour roundoff from an actual nonplanar face", () => {
  const body = (deviation: number) =>
    shape("StretchedBody", {
      L: "5",
      Normal: "0,0,1",
      Array: `6000,6000,6000;6050,6000,6000;6050,6050,${6000 + deviation};6000,6050,6000`,
    });
  expect(compilePrimitive(body(1e-11)).status).toBe("standard-derived");
  expect(compilePrimitive(body(0.001)).status).toBe("none");
});

function shape(
  sourceTag: string,
  rawAttributes: Record<string, string>,
  options?: GeometryCompileOptions,
) {
  const result = interpretXmlModPrimitive(
    { sourceTag, rawAttributes, diagnostics: [] },
    options,
  );
  if (!result.canonical) throw Error(JSON.stringify(result.diagnostics));
  return result.canonical;
}
it("B.1 measures radius from the sphere centre and keeps the poles at every LOD", () => {
  const p = shape("Sphere", { R: "13" });
  expect(analyzePrimitive(p).range).toMatchObject({
    bounds: { min: [-13, -13, -13], max: [13, 13, 13] },
  });
  for (const lod of [0, 1, 2] as const) {
    const m = compilePrimitive(p, { lod }).mesh!;
    for (let i = 0; i < m.positions.length; i += 3)
      expect(Math.hypot(...m.positions.subarray(i, i + 3))).toBeCloseTo(13, 5);
  }
});
it("G02 preserves absolute top radius and signed offsets in mesh and analytical range", () => {
  const fields = {
    BR: "10",
    TR: "0.5",
    H: "20",
    TOPXOFF: "13",
    TOPYOFF: "-15",
  };
  const p = shape("EccentricTruncatedCone", fields),
    m = compilePrimitive(p, { lod: 2 }).mesh!;
  for (let i = 16; i < 32; i++) {
    expect(m.positions[i * 3 + 2]).toBe(20);
    expect(
      Math.hypot(m.positions[i * 3] - 13, m.positions[i * 3 + 1] + 15),
    ).toBeCloseTo(0.5, 5);
  }
  expect(analyzePrimitive(p)).toMatchObject({
    range: { bounds: { min: [-10, -15.5, 0], max: [13.5, 10, 20] } },
    ports: [{ position: [0, 0, 0] }, { position: [13, -15, 20] }],
  });
  expect(shape("TruncatedCone", fields)).toMatchObject({ topRadius: 0.5 });
  expect(
    shape("TruncatedCone", fields, {
      compatibility: { rule: "cone-top-ratio-v1", evidence: "fixture:ratio" },
    }),
  ).toMatchObject({ topRadius: 5 });
  for (const [dx, dy] of [
    [0, 0],
    [-13, 15],
  ]) {
    const other = shape("EccentricTruncatedCone", {
      ...fields,
      TOPXOFF: String(dx),
      TOPYOFF: String(dy),
    });
    const mesh = compilePrimitive(other, { lod: 0 }).mesh!;
    expect(Array.from(mesh.positions.slice(-3))).toEqual([dx, dy, 20]);
  }
});
it("B.5 places the four top corners about the offset centre", () => {
  const p = shape("OffsetRectangularTable", {
    LL: "8",
    LW: "6",
    TL: "4",
    TW: "2",
    H: "10",
    XOFF: "-7",
    YOFF: "8",
  });
  expect(analyzePrimitive(p).range).toMatchObject({
    bounds: { min: [-9, -3, 0], max: [4, 9, 10] },
  });
  const m = compilePrimitive(p).mesh!,
    top = new Set<string>();
  for (let i = 0; i < m.positions.length; i += 3)
    if (m.positions[i + 2] === 10)
      top.add(m.positions.slice(i, i + 2).join(","));
  expect([...top].sort()).toEqual(["-5,7", "-5,9", "-9,7", "-9,9"]);
});
it("G03 uses direction times L, including an oblique extrusion of a concave polygon", () => {
  const Array = "0,0,0;4,0,0;4,4,0;2,2,0;0,4,0;";
  for (const Normal of ["0,0,1", "0,0,2"]) {
    const p = shape("StretchedBody", { L: "5", Array, Normal });
    const m = compilePrimitive(p).mesh!;
    expect(analyzePrimitive(p).range).toMatchObject({
      bounds: { min: [0, 0, 0], max: [4, 4, 5] },
    });
    let area = 0;
    for (let i = 0; i < m.indices!.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((j) => 3 * m.indices![i + j]);
      if ([a, b, c].every((k) => m.positions[k + 2] === 5))
        area +=
          ((m.positions[b] - m.positions[a]) *
            (m.positions[c + 1] - m.positions[a + 1]) -
            (m.positions[b + 1] - m.positions[a + 1]) *
              (m.positions[c] - m.positions[a])) /
          2;
    }
    expect(area).toBe(12);
  }
  expect(
    shape("StretchedBody", { L: "5", Array, Normal: "3,0,4" }),
  ).toMatchObject({ displacement: [3, 0, 4] });
  expect(
    shape(
      "StretchedBody",
      { L: "5", Array, Normal: "0,0,2" },
      {
        compatibility: {
          rule: "stretch-displacement-v1",
          evidence: "fixture:displacement",
        },
      },
    ),
  ).toMatchObject({ displacement: [0, 0, 2] });
  for (const invalid of [
    "0,0,0;2,2,0;0,2,0;2,0,0",
    "0,0,0;4,0,0;4,4,1;0,4,0",
  ]) {
    expect(
      compilePrimitive(
        shape("StretchedBody", { L: "5", Array: invalid, Normal: "0,0,1" }),
      ),
    ).toMatchObject({
      status: "none",
      diagnostics: [{ code: "invalid-geometry" }],
    });
  }
});

it("stops overlapping contour projections at the edge-work limit", () => {
  const points = Array.from({ length: 2100 }, (_, i) =>
    [i, 1 + (i % 2) * 50, 0].join(","),
  );
  points.push("2099,0,0", "0,0,0");
  const p = shape("StretchedBody", {
    Array: points.join(";"),
    L: "2",
    Normal: "0,0,1",
  });
  expect(compilePrimitive(p).diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "capacity-exceeded",
        message: expect.stringContaining("edge comparison"),
      }),
    ]),
  );
});
