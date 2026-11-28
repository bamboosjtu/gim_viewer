import { expect, it } from "vitest";
import { compileStl, queryStlBounds } from "../formats/stl.js";
const facet =
  "facet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet";
const ascii = (body: string) =>
  new TextEncoder().encode("solid unit\n" + body + "\nendsolid unit\n");
it("decodes byte views at a nonzero offset and never allocates indices", () => {
  const source = new Uint8Array(17 + 134 + 2),
    bytes = source.subarray(17, 17 + 134),
    v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.set(new TextEncoder().encode("solid binary"));
  v.setUint32(80, 1, true);
  v.setFloat32(108, 27, true);
  v.setFloat32(124, 1, true);
  const result = compileStl(bytes);
  expect(result).toMatchObject({
    status: "ok",
    format: "binary",
    triangleCount: 1,
  });
  expect(result.mesh!.positions[3]).toBe(27);
  expect(result.mesh!.indices).toBeUndefined();
  expect(queryStlBounds(bytes)).toMatchObject({
    bounds: { min: [0, 0, 0], max: [27, 1, 0] },
  });
  expect(queryStlBounds(bytes).mesh).toBeUndefined();
  const padded = source.subarray(17);
  for (const decode of [compileStl, queryStlBounds])
    expect(decode(padded)).toMatchObject({
      status: "ok",
      format: "binary",
      triangleCount: 1,
    });
  v.setFloat32(108, NaN, true);
  expect(compileStl(bytes).status).toBe("invalid");
});
it("distinguishes capacity, incomplete records and malformed facet structure", () => {
  const b = new ArrayBuffer(84),
    v = new DataView(b);
  v.setUint32(80, 5_000_001, true);
  expect(compileStl(b).status).toBe("capacity-exceeded");
  v.setUint32(80, 1, true);
  expect(compileStl(b).status).toBe("invalid");
  for (const s of [
    facet.replace("vertex 0 1 0", ""),
    facet.replace("0 1 0", "0 1garbage 0"),
    facet.replace("endfacet", ""),
    facet.replace("normal 0", "normal Infinity"),
  ]) {
    expect(compileStl(ascii(s))).toMatchObject({
      status: "invalid",
      format: "ascii",
    });
    expect(queryStlBounds(ascii(s)).bounds).toBeUndefined();
  }
  const result = compileStl(ascii(facet));
  expect(result.triangleCount).toBe(1);
  expect(Array.from(result.mesh!.normals)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  expect(
    compileStl(
      ascii(facet.replace("normal 0 0 0", "normal 0 4 0")),
    ).mesh?.normals.slice(0, 3),
  ).toEqual(new Float32Array([0, 1, 0]));
  for (const decode of [compileStl, queryStlBounds]) {
    expect(
      decode(ascii(facet.replace("vertex 0 1 0", "vertex 2 0 0"))),
    ).toMatchObject({
      status: "empty",
      triangleCount: 0,
      diagnostics: [{ code: "degenerate-stl-facet", severity: "warning" }],
    });
  }
  expect(result.mesh!.positions.byteLength).toBe(36);
});

it.each(["ascii", "binary"] as const)(
  "retains drawable facets around degenerate records in %s STL",
  (format) => {
    const rows = [
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [90, 90, 90, 91, 91, 91, 92, 92, 92],
      [0, 0, 1, 1, 0, 1, 0, 1, 1],
      [100, 0, 0, 100, 0, 0, 100, 0, 0],
    ];
    let input: Uint8Array;
    if (format === "ascii") {
      input = ascii(
        rows
          .map((v) =>
            [
              "facet normal 0 0 0",
              "outer loop",
              ...[0, 3, 6].map((i) => "vertex " + v.slice(i, i + 3).join(" ")),
              "endloop",
              "endfacet",
            ].join("\n"),
          )
          .join("\n"),
      );
    } else {
      input = new Uint8Array(84 + 50 * rows.length);
      const view = new DataView(input.buffer);
      view.setUint32(80, rows.length, true);
      rows.forEach((v, j) =>
        v.forEach((x, i) => view.setFloat32(96 + j * 50 + i * 4, x, true)),
      );
    }
    const decoded = compileStl(input),
      range = queryStlBounds(input);
    for (const result of [decoded, range]) {
      expect(result).toMatchObject({
        format,
        status: "ok",
        triangleCount: 2,
        diagnostics: [
          {
            code: "degenerate-stl-facet",
            severity: "warning",
            message: expect.stringContaining(
              "2 zero-area STL facets (first: 2)",
            ),
          },
        ],
      });
    }
    expect(Array.from(decoded.mesh!.positions)).toEqual([
      ...rows[0],
      ...rows[2],
    ]);
    expect(Array.from(decoded.mesh!.normals)).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
    expect(range.bounds).toMatchObject({ min: [0, 0, 0], max: [1, 1, 1] });
  },
);
