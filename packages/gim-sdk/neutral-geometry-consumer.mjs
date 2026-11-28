import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import {
  compileGeometrySource,
  placeGeometrySource,
  geometryTransferList,
  queryGeometryRange,
} from "@gim/gim-sdk/geometry";
import { readXmlMod } from "./node-xml-mod-consumer.mjs";

assert.equal(globalThis.window, undefined);
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const a = {
  rootOccurrence: "CBM/A",
  assemblyPath: "solid:0",
  localToParent: translate(100, 0, 0),
};
const b = {
  rootOccurrence: "CBM/B",
  assemblyPath: "solid:0",
  localToParent: translate(0, 200, 0),
};
const context = {
  sourcePath: "MOD/box.mod",
  matrixLayout: "project-column-major",
};
const xml =
  '<Device><Entities><Entity ID="17"><Cuboid L="20" W="10" H="6"/><TransformMatrix Value="' +
  translate(2, 3, 4).join(",") +
  '"/></Entity></Entities></Device>';
const mod = {
  format: "xml-mod",
  document: readXmlMod(xml, context),
  sourceVersion: "example-v1",
};
const facet =
  "facet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet";
const ascii = new TextEncoder().encode("solid a\n" + facet + "\nendsolid a\n");
const binary = new Uint8Array(134),
  view = new DataView(binary.buffer);
view.setUint32(80, 1, true);
view.setFloat32(108, 10, true);
view.setFloat32(124, 10, true);

async function send(batch, ownership) {
  const worker = new Worker(
    `
    const {parentPort}=require("node:worker_threads");
    parentPort.once("message",batch=>{
      const parts=batch.objects.map(o=>o.parts[0]);
      const meshes=parts.map(p=>batch.templates.get(p.templateKey).mesh);
      const first=meshes[0].positions[0];
      meshes[1].positions[0]=321;
      parentPort.postMessage({first,shared:meshes[0].positions[0]===321,ids:parts.map(p=>p.instanceId),bytes:meshes[0].positions.byteLength});
    });
  `,
    { eval: true },
  );
  try {
    const list = geometryTransferList(batch, ownership);
    assert.equal(new Set(list).size, list.length);
    const received = once(worker, "message");
    worker.postMessage(batch, list);
    return (await received)[0];
  } finally {
    await worker.terminate();
  }
}

for (const [input, min, max] of [
  [mod, [-8, -2, 4], [12, 8, 10]],
  ...[ascii, binary].map((bytes) => [
    {
      format: "stl",
      bytes,
      sourcePath: "MOD/plate.stl",
      sourceVersion: "example-v1",
    },
    [0, 0, 0],
    [10, 10, 0],
  ]),
]) {
  const range = queryGeometryRange(input, { purpose: "analytical" });
  assert.deepEqual(range.bounds.min, min);
  assert.deepEqual(range.bounds.max, max);
  const compiled = compileGeometrySource(input, { lod: 2 });
  const batch = placeGeometrySource(compiled, [a, b]);
  assert.equal(batch.templates.size, 1);
  const [A, B] = batch.objects.map((o) => o.parts[0]);
  assert.notEqual(A.instanceId, B.instanceId);
  assert.equal(A.address.rootOccurrence, a.rootOccurrence);
  assert.equal(B.address.rootOccurrence, b.rootOccurrence);
  assert.equal(A.templateKey, B.templateKey);
  assert.deepEqual(
    A.localToParent.slice(12, 15),
    input.format === "stl" ? [100, 0, 0] : [102, 3, 4],
  );
  assert.deepEqual(
    B.localToParent.slice(12, 15),
    input.format === "stl" ? [0, 200, 0] : [2, 203, 4],
  );
  const mesh = compiled.templates.get(A.templateKey).mesh;
  assert.equal(!!mesh.indices, input.format === "xml-mod");
  const first = mesh.positions[0],
    bytes = mesh.positions.byteLength;
  const expected = {
    first,
    bytes,
    shared: true,
    ids: [A.instanceId, B.instanceId],
  };
  assert.deepEqual(await send(batch, "retain"), expected);
  assert.equal(mesh.positions[0], first);
  const again = placeGeometrySource(compiled, [
    a,
    { ...b, localToParent: translate(300, 0, 0) },
  ]);
  assert.equal(again.templates, batch.templates);
  assert.deepEqual(again.objects[0].parts[0].localToParent, A.localToParent);
  assert.notDeepEqual(again.objects[1].parts[0].localToParent, B.localToParent);
  assert.deepEqual(await send(again, "move"), expected);
  assert.equal(mesh.positions.byteLength, 0);
  assert.equal(mesh.normals.byteLength, 0);
  if (mesh.indices) assert.equal(mesh.indices.byteLength, 0);
}
console.log(
  "G0 installed ESM: XML MOD, ASCII/binary STL, two placed instances, range queries and real Worker retain/move passed.",
);
