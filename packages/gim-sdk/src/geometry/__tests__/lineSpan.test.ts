import { it, expect } from "vitest";
import { compileLineSpan, type WireEnd } from "../formats/line-span.js";
const end = (x: number, y = 0, z = 0): WireEnd => ({
  position: [x, y, z],
  reference: String(x),
  quality: "source-derived",
});
const base = {
  variantKey: "engineering-frame",
  sourcePath: "w.cbm",
  sourceVersion: "sha",
  outsideDiameterMm: 20,
  splitCount: 1,
  sourceLengthMm: 99,
};
it("keeps distinct terminals of a jumper, physical diameter and polyline lengths across all LODs", () => {
  const counts: number[] = [];
  for (const lod of [0, 1, 2] as const) {
    const out = compileLineSpan(
      {
        ...base,
        lanes: [
          {
            start: end(1000),
            end: end(1060, 80),
            viaMm: [[1030, 40, -30]],
            pathKind: "source-polyline",
          },
        ],
      },
      lod,
    );
    const t = [...out.source.templates.values()][0];
    expect(t.kind).toBe("mesh");
    if (t.kind === "mesh") {
      counts.push(t.mesh.indices!.length);
      expect(Math.hypot(...t.mesh.positions.slice(0, 3))).toBeCloseTo(10, 5);
    }
    expect(out.lengths[0].chordMm).toBe(100);
    expect(out.lengths[0].polylineMm).toBeCloseTo(2 * Math.hypot(50, 30));
    expect(out.sourceLengthMm).toBe(99);
    expect(out.source.objects[0].ports[1].position).toEqual([60, 80, 0]);
    expect(out.lengths[0].radialErrorMm).toBeCloseTo(
      10 * (1 - Math.cos(Math.PI / [6, 12, 24][lod])),
    );
  }
  expect(counts[0]).toBeLessThan(counts[1]);
  expect(counts[1]).toBeLessThan(counts[2]);
});
it("preserves missing ends and incomplete bundle layout, qualifying a chord independently of diameter", () => {
  const missing = compileLineSpan({
    ...base,
    lanes: [{ start: end(0) }],
  }).source;
  expect(missing.objects[0].availability).toBe("partial");
  expect(missing.templates.size).toBe(0);
  expect(missing.objects[0].ports).toHaveLength(1);
  const split = compileLineSpan({
    ...base,
    splitCount: 4,
    lanes: [{ start: end(0), end: end(100) }],
  }).source;
  expect([...split.templates.values()][0].kind).toBe("line-segments");
  expect(split.objects[0].geometry?.quality).toBe("preview-only");
  expect(split.diagnostics[0].code).toBe("incomplete-bundle");
  const lanes = [0, 100, 200, 300].map((y) => ({
    start: end(0, y),
    end: end(100, y),
  }));
  const full = compileLineSpan({ ...base, splitCount: 4, lanes }).source;
  expect(full.templates.size).toBe(4);
  expect(full.diagnostics).toHaveLength(0);
});

it("uses the explicit survey datum and origin, including height and antimeridian", async () => {
  const { localSurveyPoint } = await import("../formats/line-frame.js");
  const origin = { latitudeDeg: 0, longitudeDeg: 180, heightM: 100 };
  for (const ellipsoid of ["CGCS2000", "WGS84"] as const) {
    const frame = { origin, ellipsoid };
    expect(Math.hypot(...localSurveyPoint(frame, origin))).toBe(0);
    const up = localSurveyPoint(frame, { ...origin, heightM: 102 });
    expect(up[2]).toBeCloseTo(2000);
    const east = localSurveyPoint(frame, { ...origin, longitudeDeg: -179.999 });
    expect(east[0]).toBeCloseTo(
      (6378137 + 100) * Math.sin((0.001 * Math.PI) / 180) * 1000,
      3,
    );
    expect(east[1]).toBeCloseTo(0);
  }
});
