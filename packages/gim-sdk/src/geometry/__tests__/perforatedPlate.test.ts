import { expect, it } from "vitest";
import { interpretXmlModPrimitive } from "../interpretXmlModPrimitive.js";
import { compilePrimitive } from "../compilePrimitive.js";
import { analyzePrimitive } from "../analysisGeometry.js";
import type { MeshData } from "../primitiveContracts.js";
const size = {
  L: "200",
  W: "60",
  T: "8",
  CN: "2",
  RN: "3",
  CS: "20",
  RS: "30",
};
function plate(tag: string, attrs: Record<string, string>) {
  const v = interpretXmlModPrimitive({
    sourceTag: tag,
    rawAttributes: attrs,
    diagnostics: [],
  });
  expect(v.status).toBe("standard");
  return v.canonical!;
}
/** Count intersections with the two caps by projecting each triangle into the plate plane. */
function through(m: MeshData, x: number, y: number, vertical = false) {
  const axis = vertical ? 2 : 1;
  const orientation = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  let hits = 0;
  for (let i = 0; i < m.indices!.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => 3 * m.indices![i + j]),
      p = m.positions;
    if (
      p[a + (vertical ? 1 : 2)] !== p[b + (vertical ? 1 : 2)] ||
      p[b + (vertical ? 1 : 2)] !== p[c + (vertical ? 1 : 2)]
    )
      continue;
    const sides = [
      [a, b],
      [b, c],
      [c, a],
    ].map(([u, v]) => orientation(p[u], p[u + axis], p[v], p[v + axis], x, y));
    if (sides.every((n) => n >= 0) || sides.every((n) => n <= 0)) hits++;
  }
  return hits;
}
it("B.25 changes only the top bevels while all six drilled holes pass along Y", () => {
  for (const CL of ["4", "8"]) {
    const p = plate("TerminalBlock", { ...size, BL: "20", R: "3", CL }),
      m = compilePrimitive(p).mesh!;
    expect(analyzePrimitive(p).range).toMatchObject({
      bounds: { min: [-30, -4, 0], max: [30, 4, 200] },
    });
    for (const x of [-10, 10])
      for (const z of [20, 50, 80]) expect(through(m, x, z, true)).toBe(0);
    expect(through(m, 0.71, 11.4, true)).toBeGreaterThan(0);
    const points = new Set<string>();
    for (let i = 0; i < m.positions.length; i += 3)
      points.add(m.positions.slice(i, i + 3).join(","));
    for (const side of [-1, 1]) {
      expect(points.has([side * (30 - Number(CL)), 4, 200].join(","))).toBe(
        true,
      );
      expect(points.has([side * 30, 4, 200 - Number(CL)].join(","))).toBe(true);
    }
    expect(points.has("13,4,20") && points.has("13,-4,20")).toBe(true);
  }
});
it.each(["0", "1"])(
  "B.26 keeps X column pitch, Y row pitch and an independent MH=%s",
  (MH) => {
    const m = compilePrimitive(
      plate("RectangularFixedPlate", {
        ...size,
        L: "120",
        W: "100",
        D: "6",
        MH,
      }),
    ).mesh!;
    for (const x of [-10, 10])
      for (const y of [-30, 0, 30]) expect(through(m, x, y)).toBe(0);
    expect(through(m, 0.13, 0.17) > 0).toBe(MH === "0");
    const odd = compilePrimitive(
      plate("RectangularFixedPlate", {
        ...size,
        W: "100",
        D: "6",
        MH,
        CN: "3",
      }),
    ).mesh!;
    expect(through(odd, 0.13, 0.17) > 0).toBe(MH === "0");
  },
);
it("B.27 uses +X, a pitch radius, and hole diameter; keeps ambiguous outer shapes unresolved", () => {
  const fields = {
    L: "100",
    W: "100",
    T: "8",
    CS: "30",
    N: "3",
    MH: "0",
    D: "8",
  };
  const m = compilePrimitive(plate("CircularFixedPlate", fields)).mesh!;
  for (let k = 0; k < 3; k++) {
    const a = (k * 2 * Math.PI) / 3;
    expect(through(m, 30 * Math.cos(a), 30 * Math.sin(a))).toBe(0);
  }
  expect(through(m, 34.5, 0.1)).toBeGreaterThan(0);
  const unresolved = plate("CircularFixedPlate", { ...fields, W: "80" });
  expect(compilePrimitive(unresolved)).toMatchObject({
    status: "none",
    diagnostics: [{ code: "unverified-outline" }],
  });
  expect(analyzePrimitive(unresolved).range.coverage).toBe("unknown");
});
it("separates no holes from tangent, overlapping, out-of-bounds and over-budget cases", () => {
  const f = { ...size, D: "10", MH: "0", RN: "1" };
  expect(
    compilePrimitive(plate("RectangularFixedPlate", { ...f, CN: "0" })).mesh,
  ).toBeDefined();
  for (const [CS, code] of [
    ["10", "hole-tangent"],
    ["8", "hole-overlap"],
    ["200", "hole-outside"],
  ]) {
    expect(
      compilePrimitive(plate("RectangularFixedPlate", { ...f, CS })),
    ).toMatchObject({ status: "none", diagnostics: [{ code }] });
  }
  expect(
    compilePrimitive(plate("RectangularFixedPlate", f), {
      limits: { maxHoles: 1 },
    }),
  ).toMatchObject({
    status: "none",
    diagnostics: [{ code: "capacity-exceeded", limit: { requested: 2 } }],
  });
});
