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
  const result = compileStl(bytes);
  expect(result).toMatchObject({
    status: "ok",
    format: "binary",
    triangleCount: 1,
  });
  expect(result.mesh!.positions[3]).toBe(27);
  expect(result.mesh!.indices).toBeUndefined();
  expect(queryStlBounds(bytes)).toMatchObject({
    bounds: { min: [0, 0, 0], max: [27, 0, 0] },
  });
  expect(queryStlBounds(bytes).mesh).toBeUndefined();
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
  expect(Array.from(result.mesh!.normals)).toEqual(Array(9).fill(0));
  expect(result.mesh!.positions.byteLength).toBe(36);
});
