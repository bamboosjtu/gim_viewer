import { describe, expect, it } from "vitest";
import {
  analyzePrimitive,
  compilePrimitive,
  curveCenterline,
  interpretXmlModPrimitive,
} from "../geometry.js";
import type { MeshData } from "../primitiveContracts.js";
import type { Point3 } from "../analysisGeometry.js";

function wire(points: Point3[], start: Point3, end: Point3, diameter: number) {
  const value = interpretXmlModPrimitive({
    sourceTag: "Wire",
    rawAttributes: {
      D: String(diameter),
      Sag: "1",
      StartCoord: points[0].join(","),
      EndCoord: points.at(-1)!.join(","),
      StartVector: start.join(","),
      EndVector: end.join(","),
      FitCoordArray: points.map((p) => p.join(",")).join(";"),
    },
    diagnostics: [],
  });
  if (value.canonical?.kind !== "Wire") throw Error("Invalid test source");
  return value.canonical;
}
const unit = (p: Point3) => p.map((x) => x / Math.hypot(...p));
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function checkSurface(mesh: MeshData) {
  const { positions: p, normals: n, indices } = mesh;
  const edges = new Map<string, number>();
  for (let i = 0; i < indices!.length; i += 3) {
    const [a, b, c] = Array.from(indices!.subarray(i, i + 3), (v) => 3 * v);
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]],
      v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const face = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    expect(
      dot(
        face,
        [0, 1, 2].map((k) => n[a + k] + n[b + k] + n[c + k]),
      ),
    ).toBeGreaterThan(0);
    // Weld coincident cap/side positions for the oriented manifold check.
    const vertex = (j: number) => p.subarray(j, j + 3).join(",");
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const x = vertex(from),
        y = vertex(to),
        key = x < y ? x + "/" + y : y + "/" + x;
      edges.set(key, (edges.get(key) ?? 0) + (x < y ? 1 : -1));
    }
  }
  expect([...edges.values()].every((v) => v === 0)).toBe(true);
}

describe("Wire terminal leads and swept section clearance", () => {
  const straight = Array.from({ length: 10 }, (_, i): Point3 => [i * 5, 0, 0]);
  const cases: {
    name: string;
    points: Point3[];
    start: Point3;
    end: Point3;
    diameter: number;
  }[] = [
    {
      name: "opposed terminal lead",
      points: straight,
      start: [1, 0, 0],
      end: [-1, 0, 0],
      diameter: 2,
    },
    {
      name: "close oblique end sections",
      points: straight,
      start: [0.1, 1, 0],
      end: [0.1, -1, 0],
      diameter: 10,
    },
    {
      name: "short interior bend",
      points: [
        [-30, 0, 0],
        [-20, 0, 0],
        [-10, 0, 0],
        [-5, 0, 1],
        [0, 0, 3],
        [3, 0, 6],
        [6, 0, 15],
        [7, 0, 27],
        [8, 0, 40],
        [9, 0, 54],
      ],
      start: [1, 0, 0],
      end: [1, 0, 14],
      diameter: 24,
    },
  ];
  it.each(cases)(
    "keeps an outward closed surface at $name",
    ({ points, start, end, diameter }) => {
      const source = wire(points, start, end, diameter),
        analysis = analyzePrimitive(source);
      expect(source.startVector).toEqual(start);
      expect(source.endVector).toEqual(end);

      expect(analysis.curve?.declaredSag).toBe(1);
      for (const lod of [0, 1, 2] as const) {
        const compiled = compilePrimitive(source, { lod });
        expect(compiled.status).toBe("preview-only");
        const mesh = compiled.mesh!;
        const line = curveCenterline(source, lod),
          sides = [6, 12, 16][lod];
        for (const p of points) expect(line).toContainEqual(p);
        checkSurface(mesh);
        expect(mesh.indices!.length / 3).toBe(line.length * 2 * sides);
        for (let ring = 0; ring < line.length; ring++)
          for (let j = 0; j < sides; j++) {
            const at = 3 * (ring * sides + j);
            expect(
              Math.hypot(
                ...line[ring].map((x, k) => x - mesh.positions[at + k]),
              ),
            ).toBeCloseTo(diameter / 2, 5);
          }
        for (const [port, lead, advance, at, sign] of [
          [
            0,
            start,
            points[1].map((x, k) => x - points[0][k]),
            mesh.positions.length - 3 * (sides + 2),
            -1,
          ],
          [
            1,
            end,
            points.at(-1)!.map((x, k) => x - points.at(-2)![k]),
            mesh.positions.length - 3,
            1,
          ],
        ] as const) {
          const raw = unit(lead);
          const travel = dot(raw, advance) < 0 ? raw.map((x) => -x) : raw;
          const tangent =
            port === 0
              ? analysis.curve!.travelTangents!.start
              : analysis.curve!.travelTangents!.end;
          expect(dot(analysis.ports[port].direction!, raw)).toBeCloseTo(1, 6);
          expect(dot(tangent, travel)).toBeCloseTo(1, 6);
          expect(
            dot(mesh.normals.subarray(at, at + 3), travel) * sign,
          ).toBeCloseTo(1, 6);
          expect(Array.from(mesh.positions.subarray(at, at + 3))).toEqual(
            port === 0 ? points[0] : points.at(-1),
          );
        }
      }
    },
  );
  it.each([9, 32, 128])(
    "bounds chord error and increases radial detail for %i fit points",
    (count) => {
      const points = Array.from({ length: count }, (_, i): Point3 => [
        i * 200,
        80 * Math.sin(i * 1.2),
        0,
      ]);
      const source = wire(points, [1, 0, 0], [1, 0, 0], 2);
      let previousFaces = 0,
        previousError = Infinity;
      for (const lod of [0, 1, 2] as const) {
        const result = compilePrimitive(source, { lod });
        const mesh = result.mesh!,
          sampling = mesh.curveSampling!;
        expect(sampling.segments).toBeGreaterThan(count - 1);
        expect(sampling.segments).toBeLessThanOrEqual(256);
        expect(sampling.maxChordErrorMm).toBeLessThanOrEqual(
          previousError + 1e-9,
        );
        expect(mesh.indices!.length).toBeGreaterThan(previousFaces);
        expect(
          result.diagnostics.some((d) => d.code === "curve-sampling-budget"),
        ).toBe(sampling.maxChordErrorMm > sampling.targetMm);
        previousFaces = mesh.indices!.length;
        previousError = sampling.maxChordErrorMm;
      }
    },
  );
  it("diagnoses an inseparable preview instead of emitting a folded side strip", () => {
    const p = wire(
      [
        [0, 0, 0],
        [5, 0, 0],
        [10, 0, 0],
      ],
      [0.1, 1, 0],
      [0.1, -1, 0],
      10,
    );
    expect(compilePrimitive(p)).toMatchObject({
      status: "none",
      diagnostics: [{ code: "unresolved-wire-sweep" }],
    });
    expect(analyzePrimitive(p).ports).toHaveLength(2);
  });
});
