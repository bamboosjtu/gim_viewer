import { expect, it } from "vitest";
import { interpretXmlModPrimitive } from "../interpretXmlModPrimitive.js";
import { compilePrimitive } from "../compilePrimitive.js";
import { analyzePrimitive } from "../analysisGeometry.js";
import type {
  MeshData,
  GeometryCompileOptions,
} from "../primitiveContracts.js";

const read = (
  tag: string,
  attrs: Record<string, string>,
  options?: GeometryCompileOptions,
) =>
  interpretXmlModPrimitive(
    { sourceTag: tag, rawAttributes: attrs, diagnostics: [] },
    options,
  );
function model(
  tag: string,
  attrs: Record<string, string>,
  options?: GeometryCompileOptions,
) {
  const p = read(tag, attrs, options);
  if (!p.canonical) throw Error(JSON.stringify(p.diagnostics));
  const result = compilePrimitive(p.canonical, options);
  expect(result.mesh).toBeDefined();
  return { p: p.canonical, mesh: result.mesh!, result };
}
function volume(m: MeshData) {
  let v = 0;
  for (let i = 0; i < m.indices!.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) =>
      m.positions.subarray(3 * m.indices![i + k], 3 * m.indices![i + k] + 3),
    );
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) +
        a[1] * (b[2] * c[0] - b[0] * c[2]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return v;
}
it("B.4 lofts two similar rhombi about the bottom centre", () => {
  const f = { LL1: "8", LL2: "6", TL1: "4", TL2: "3", H: "9" };
  const { mesh } = model("Table", f);
  expect(volume(mesh)).toBeCloseTo((9 * (24 + 12 + 6)) / 3);
  expect(read("Table", { ...f, TL1: "6" }).status).toBe("invalid");
});
it("B.7 retains both capped axes and declares the miter assumption", () => {
  const { p, result } = model("BendingCylindrical", {
    R: "1",
    L: "10",
    Rad: String(Math.PI / 2),
  });
  expect(result.status).toBe("preview-only");
  const mesh = result.mesh!;
  const sides = (mesh.positions.length / 3 - 2) / 5;
  const vertex = (j: number) =>
    mesh.positions.subarray(3 * (sides + j), 3 * (sides + j + 1));
  for (let j = 0; j < sides; j++) {
    const next = vertex((j + 1) % sides),
      prev = vertex((j + sides - 1) % sides);
    const n = mesh.normals.subarray(3 * (sides + j), 3 * (sides + j + 1));
    const along = next.reduce((sum, x, i) => sum + (x - prev[i]) * n[i], 0);
    expect(along).toBeCloseTo(0, 5);
  }
  const ports = analyzePrimitive(p).ports;
  expect(ports[0].position).toEqual([10, 0, 0]);
  expect(ports[1].position[1]).toBeCloseTo(10);
  expect(ports[1].direction[0]).toBeCloseTo(0);
  expect(ports[1].direction[1]).toBeCloseTo(1);
});
it("B.10–B.12 retain separate path, tangent, bore and seam semantics", () => {
  const { p, mesh } = model("Ring", {
    R: "20",
    DR: "2",
    RAD: String(Math.PI / 2),
  });
  expect(volume(mesh)).toBeGreaterThan(0);
  const ports = analyzePrimitive(p).ports;
  expect(ports[0].position).toEqual([20, 0, 0]);
  expect(ports[1].position[1]).toBeCloseTo(20);
  for (const lod of [0, 1, 2] as const) {
    const rect = model(
        "RectangularRing",
        { L: "60", W: "40", R: "8", DR: "2" },
        { lod },
      ),
      ellipse = model("EllipticRing", { L: "30", W: "15", DR: "2" }, { lod });
    expect(volume(rect.mesh)).toBeGreaterThan(0);
    expect(volume(ellipse.mesh)).toBeGreaterThan(0);
    expect(analyzePrimitive(rect.p).range).toMatchObject({
      bounds: { max: [32, 22, 2] },
    });
    expect(analyzePrimitive(ellipse.p).range).toMatchObject({
      bounds: { max: [32, 17, 2] },
    });
  }
  expect(
    model("RectangularRing", { L: "60", W: "16", R: "8", DR: "2" }).result
      .status,
  ).toBe("preview-only");
  expect(read("EllipticRing", { L: "30", W: "6", DR: "3" }).status).toBe(
    "invalid",
  );
});
it("B.13/B.14 keep the bore and radial end faces, including equal and flared outside radii", () => {
  for (const tr of [20, 30, 40]) {
    const { mesh } = model("TableGasket", {
      IR: "10",
      OR: "30",
      TR: String(tr),
      H: "5",
    });
    const radii = (z: number) =>
      Array.from({ length: mesh.positions.length / 3 }, (_, i) =>
        mesh.positions.slice(3 * i, 3 * i + 3),
      )
        .filter((p) => p[2] === z)
        .map((p) => Math.hypot(p[0], p[1]));
    expect(Math.max(...radii(0))).toBeCloseTo(30, 4);
    expect(Math.max(...radii(5))).toBeCloseTo(tr, 4);
    expect(Math.min(...radii(5))).toBeCloseTo(10, 4);
  }
  const { mesh } = model("CircularGasket", {
    IR: "10",
    OR: "20",
    H: "5",
    Rad: String(Math.PI / 2),
  });
  expect(volume(mesh)).toBeCloseTo(
    0.5 * (400 - 100) * 4 * Math.sin(Math.PI / 8) * 5,
    3,
  );
  expect(
    read("TableGasket", { IR: "10", OR: "30", TR: "10", H: "5" }).status,
  ).toBe("invalid");
});
it("B.15 selects only the active corner field and preserves the rectangular hole", () => {
  const f = { L1: "40", W1: "30", L2: "20", W2: "10", H: "5" };
  expect(
    volume(model("SquareGasket", { ...f, CT: "1", Rad: "garbage" }).mesh),
  ).toBeCloseTo(5000);
  expect(
    volume(model("SquareGasket", { ...f, CT: "3", CL: "3" }).mesh),
  ).toBeCloseTo(4910);
  const rounded = volume(
    model("SquareGasket", { ...f, CT: "2", Rad: "3", CL: "unused" }).mesh,
  );
  expect(rounded).toBeGreaterThan(4910);
  expect(rounded).toBeLessThan(5000);
});
it("B.17–B.20 extrude along +X and preserve the four drawing origins and areas", () => {
  const f = { B: "40", H: "60", D: "3", T: "5", L: "100" };
  for (const [tag, area, y, zmin, zmax] of [
    ["AngleSteel", 3 * (40 + 60 - 3), -40, 0, 60],
    ["I-shapedsteel", 2 * 40 * 5 + 3 * 50, -20, 0, 60],
    ["ChannelSteel", 2 * 40 * 5 + 3 * 50, -40, -30, 30],
    ["T-Steels", 40 * 5 + 3 * 55, -20, -60, 0],
  ] as const) {
    const { mesh, p } = model(tag, f);
    expect(volume(mesh)).toBeCloseTo(area * 100, 3);
    expect(analyzePrimitive(p).range).toMatchObject({
      bounds: { min: [0, y, zmin], max: [100, expect.any(Number), zmax] },
    });
  }
  const estimate = model(
    "ChannelSteel",
    { L: "100", Model: "C10" },
    { compatibility: { rule: "steel-model-section-v1", evidence: "fixture" } },
  );
  expect(estimate.result.status).toBe("estimated");
  expect(analyzePrimitive(estimate.p).range).toMatchObject({
    bounds: { quality: "estimated" },
  });
});
