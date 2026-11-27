import assert from "node:assert/strict";
import { compileStl, queryStlBounds } from "@gim/gim-sdk/geometry";

const triangle =
  "facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 100 0 0\nvertex 0 100 0\nendloop\nendfacet\n";
const ascii = new TextEncoder().encode(
  "solid test\n" + triangle + triangle + "endsolid test\n",
);
const binary = new Uint8Array(184),
  view = new DataView(binary.buffer);
binary.set(new TextEncoder().encode("solid"));
view.setUint32(80, 2, true);
for (const start of [84, 134])
  for (const [i, n] of [0, 0, 1, 0, 0, 0, 100, 0, 0, 0, 100, 0].entries())
    view.setFloat32(start + 4 * i, n, true);
for (const [input, format] of [
  [ascii, "ascii"],
  [binary, "binary"],
]) {
  const result = compileStl(input);
  assert.equal(result.format, format);
  assert.equal(result.triangleCount, 2);
  assert.equal(result.status, "ok");
  assert.equal(result.mesh.positions.buffer.byteLength, 72);
  assert.equal(result.mesh.normals.buffer.byteLength, 72);
  assert.equal(result.mesh.indices, undefined);
  assert.deepEqual(
    Array.from(result.mesh.positions.slice(0, 9)),
    [0, 0, 0, 100, 0, 0, 0, 100, 0],
  );
  assert.deepEqual(
    Array.from(result.mesh.normals.slice(0, 9)),
    [0, 0, 1, 0, 0, 1, 0, 0, 1],
  );
  assert.deepEqual(queryStlBounds(input).bounds.max, [100, 100, 0]);
}
console.log(
  "G07 Node STL passed: binary/ASCII, 72+72 bytes, zero index bytes.",
);
