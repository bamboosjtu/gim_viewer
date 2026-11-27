import { expect, it } from "vitest";
import {
  interpretXmlModPrimitive,
  compilePrimitive,
  analyzePrimitive,
  curveCenterline,
} from "../geometry.js";
import type { GeometryCompileOptions } from "../primitiveContracts.js";

it("preserves the bounded fit-only browser tessellation for long wire point lists", () => {
  const points = Array.from({ length: 300 }, (_, i) => `${i},0,0`).join(";");
  const r = read(
    "Wire",
    { D: "2", FitCoordArray: points },
    { compatibility: { rule: "wire-fit-preview-v1", evidence: "fixture" } },
  );
  expect(r.status).toBe("compatible");
  expect(compilePrimitive(r.canonical!, { lod: 0 })).toMatchObject({
    status: "preview-only",
  });
  expect(
    compilePrimitive(r.canonical!, { limits: { maxCurveSegments: 255 } })
      .diagnostics[0],
  ).toMatchObject({ code: "capacity-exceeded", limit: { requested: 256 } });
});
const read = (
  sourceTag: string,
  rawAttributes: Record<string, string>,
  options?: GeometryCompileOptions,
) =>
  interpretXmlModPrimitive(
    { sourceTag, rawAttributes, diagnostics: [] },
    options,
  );
function shape(t: string, f: Record<string, string>) {
  const result = read(t, f);
  if (!result.canonical) throw Error(JSON.stringify(result.diagnostics));
  return result.canonical;
}
const body = { R: "10", R1: "20", R2: "15", N: "3", H: "60" };
const string = {
  R: "3",
  R1: "5",
  R2: "4",
  N1: "4",
  H1: "10",
  FL: "3",
  AL: "7",
  LN: "2",
};
it("B.2 follows the X cut, closes the cut plane and recovers the full ellipsoid", () => {
  for (const [H, left] of [
    ["700", -100],
    ["1200", -600],
  ] as const) {
    const p = shape("RotationalEllipsoid", { LR: "600", WR: "300", H });
    expect(analyzePrimitive(p).range).toMatchObject({
      bounds: { min: [left, -300, -300], max: [600, 300, 300] },
    });
    let faceCount = 0,
      lastError = Infinity;
    for (const lod of [0, 1, 2] as const) {
      const m = compilePrimitive(p, { lod }).mesh!;
      expect(m.indices!.length).toBeGreaterThan(faceCount);
      faceCount = m.indices!.length;
      let maxError = 0;
      for (let i = 0; i < m.indices!.length; i += 3) {
        const v = [0, 0, 0];
        for (let j = 0; j < 3; j++)
          for (let k = 0; k < 3; k++)
            v[k] += m.positions[m.indices![i + j] * 3 + k] / 3;
        if (Math.abs(v[0] - left) > 1e-5)
          maxError = Math.max(
            maxError,
            1 - Math.hypot(v[0] / 600, v[1] / 300, v[2] / 300),
          );
      }
      expect(maxError).toBeLessThan(lastError);
      lastError = maxError;
    }
    const m = compilePrimitive(p).mesh!;
    let caps = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      const [x, y, z] = m.positions.subarray(i, i + 3);
      if (x === left && m.normals[i] === -1) {
        caps++;
        continue;
      }
      expect((x / 600) ** 2 + (y / 300) ** 2 + (z / 300) ** 2).toBeCloseTo(
        1,
        5,
      );
    }
    expect(caps).toBeGreaterThan(0);
    const status = compilePrimitive(p).status;
    expect(status).toBe(H === "700" ? "preview-only" : "standard-derived");
  }
  expect(read("RotationalEllipsoid", { LR: "2", WR: "1", H: "5" }).status).toBe(
    "invalid",
  );
});
it("B.21/B.22 preserve the envelope, both skirt families, count and L0 core", () => {
  for (const p of [
    shape("PorcelainBushing", body),
    shape("ConePorcelainBushing", {
      BR: "10",
      TR: "8",
      BR1: "24",
      TR1: "16",
      BR2: "22",
      TR2: "14",
      H: "60",
      N: "3",
    }),
  ]) {
    const low = compilePrimitive(p, { lod: 0 }),
      high = compilePrimitive(p, { lod: 2 });
    expect(high.status).toBe("preview-only");
    expect(high.mesh!.positions.length).toBeGreaterThan(
      low.mesh!.positions.length,
    );
    const radiiByZ = new Map<number, number>();
    const pos = high.mesh!.positions;
    for (let i = 0; i < pos.length; i += 3) {
      const z = pos[i + 2];
      radiiByZ.set(
        z,
        Math.max(radiiByZ.get(z) ?? 0, Math.hypot(pos[i], pos[i + 1])),
      );
    }
    const peaks = [...radiiByZ]
      .filter(([, r]) => r > 10.01)
      .sort((a, b) => a[0] - b[0])
      .map((v) => Math.round(v[1]));
    expect(peaks).toEqual(
      p.kind === "PorcelainBushing"
        ? [20, 15, 20, 15, 20, 15]
        : [24, 22, 20, 18, 16, 14],
    );
    expect(Math.min(...radiiByZ.keys())).toBe(0);
    expect(Math.max(...radiiByZ.keys())).toBe(60);
    expect(analyzePrimitive(p).ports.map((port) => port.position[2])).toEqual([
      0, 60,
    ]);
  }
});
it("B.23/B.24 preserve repetition counts, end spacing, branch length and split count", () => {
  const straight = shape("Insulator", { ...string, N: "2", D: "16" }),
    v = shape("VTypeInsulator", { ...string, X: "20", AD: "8" });
  for (const p of [straight, v]) {
    const a = analyzePrimitive(p);
    expect(a.repetitions?.map((part) => part.count)).toEqual([4, 4]);
    expect(a.connectionSplitCount).toBe(2);
    const [s0, e0, s1, e1] = a.ports.map((p) => p.position);
    expect(s1[1] - s0[1]).toBe(p.kind === "Insulator" ? 16 : 20);
    expect(e1[1] - e0[1]).toBe(p.kind === "Insulator" ? 16 : 8);
    expect(Math.hypot(...e0.map((n, i) => n - s0[i]))).toBeCloseTo(50);
    const detailed = compilePrimitive(p),
      low = compilePrimitive(p, { lod: 0 });
    expect(detailed.status).toBe("preview-only");
    expect(low.mesh!.positions.length).toBeLessThan(
      detailed.mesh!.positions.length,
    );
  }
  const unresolved = shape("Insulator", { ...string, N: "3", D: "16" });
  expect(compilePrimitive(unresolved)).toMatchObject({
    status: "none",
    diagnostics: [{ code: "unverified-layout" }],
  });
  expect(analyzePrimitive(unresolved).range.coverage).toBe("unknown");
});
it("B.28 keeps declared sag separate from fit geometry, diameter and endpoint tangents", () => {
  const p = shape("Wire", {
    D: "2",
    Sag: "3",
    StartCoord: "0,0,0",
    EndCoord: "10,0,0",
    StartVector: "1,-1,0",
    EndVector: "1,1,0",
    FitCoordArray: "0,0,0;5,-2,0;10,0,0",
  });
  expect(p.kind).toBe("Wire");
  if (p.kind !== "Wire") throw Error();
  const a = analyzePrimitive(p),
    line = curveCenterline(p);
  expect(a.curve).toMatchObject({
    diameter: 2,
    declaredSag: 3,
    fitPointCount: 3,
    maxFitDistanceFromChord: 2,
    sagReference: "unspecified",
  });
  expect(line).toContainEqual([5, -2, 0]);
  expect(line[0]).toEqual([0, 0, 0]);
  expect(line.at(-1)).toEqual([10, 0, 0]);
  expect(a.ports[0].direction[1]).toBeCloseTo(-1 / Math.sqrt(2));
  expect(a.ports[1].direction[1]).toBeCloseTo(1 / Math.sqrt(2));
  expect(compilePrimitive(p).status).toBe("preview-only");
  expect(read("Wire", { D: "2", FitCoordArray: "0,0,0;10,0,0" }).status).toBe(
    "invalid",
  );
});
it("G05 interprets line, virtual intersection and spline direction records separately", () => {
  const attrs = {
    D: "1",
    CurveTypeArray: "0,1,2",
    CurveControlCoordArray:
      "0,0,0;10,0,0|10,0,0;20,10,0;20,0,0|0,1,0;1,0,0;20,10,0;21,18,0;25,22,0|",
  };
  const p = shape("CurveCable", attrs);
  if (p.kind !== "CurveCable") throw Error();
  const mid = curveCenterline(p);
  expect(mid).toContainEqual([10, 0, 0]);
  expect(mid).not.toContainEqual([20, 0, 0]);
  expect(
    mid.some(
      (v) =>
        Math.abs(v[0] - (10 + 10 / Math.sqrt(2))) < 1e-9 &&
        Math.abs(v[1] - (10 - 10 / Math.sqrt(2))) < 1e-9,
    ),
  ).toBe(true);
  const a = analyzePrimitive(p);
  expect(a.ports[1].direction[0]).toBeCloseTo(1);
  expect(compilePrimitive(p).status).toBe("preview-only");
  expect(
    compilePrimitive(
      shape("CurveCable", {
        D: "2",
        CurveTypeArray: "0",
        CurveControlCoordArray: "1,2,3;4,5,6|",
      }),
    ).status,
  ).toBe("standard-derived");
  for (const s of [
    attrs.CurveControlCoordArray.replace("|", "||"),
    attrs.CurveControlCoordArray.replace("0,1,0;1,0,0", "0,0,0;1,0,0"),
    attrs.CurveControlCoordArray.replace("|10,0,0", "|11,0,0"),
  ]) {
    expect(
      read("CurveCable", { ...attrs, CurveControlCoordArray: s }).status,
    ).toBe("invalid");
  }
  expect(read("CurveCable", { ...attrs, CurveTypeArray: "0,1" }).status).toBe(
    "invalid",
  );
  const noArc = shape("CurveCable", {
    D: "2",
    CurveTypeArray: "1",
    CurveControlCoordArray: "0,0,0;12,10,0;12,0,0",
  });
  expect(compilePrimitive(noArc).diagnostics[0].code).toBe("unverified-arc");
});

it.each([9, 32, 128])(
  "refines a single B.29 spline with %i controls independently of control count",
  (count) => {
    const coordinates = Array.from({ length: count }, (_, i) =>
      [i * 300, 100 * Math.sin(i * 1.4), 0].join(","),
    );
    const p = shape("CurveCable", {
      D: "2",
      CurveTypeArray: "2",
      CurveControlCoordArray: ["1,0,0", "1,0,0", ...coordinates].join(";"),
    });
    let faces = 0;
    for (const lod of [0, 1, 2] as const) {
      const mesh = compilePrimitive(p, { lod }).mesh!;
      expect(mesh.curveSampling!.segments).toBeGreaterThan(count - 1);
      expect(mesh.indices!.length).toBeGreaterThan(faces);
      faces = mesh.indices!.length;
    }
  },
);
