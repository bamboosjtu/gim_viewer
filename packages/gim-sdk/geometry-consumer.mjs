/** End-to-end assertions executed against the installed ESM bundle. */
import assert from "node:assert/strict";
import { profiles, bodies } from "./tests/profileAssemblyFixtures.mjs";
import { compileXmlModDocument } from "@gim/gim-sdk/geometry";
import { readXmlMod } from "./node-xml-mod-consumer.mjs";

const project = {
  sourcePath: "MOD/unit.mod",
  matrixLayout: "project-column-major",
};
const standard = { ...project, matrixLayout: "a3-21-example" };
const wrap = (...declarations) =>
  "<Device><Entities>" + declarations.join("") + "</Entities></Device>";
const row = (id, body) => `<Entity ID="${id}">${body}</Entity>`;
const box = '<Cuboid L="20" W="10" H="6"/>';
const cylinder = '<Cylinder R="4" H="9"/>';
const matrix = (value) => `<TransformMatrix Value="${value}"/>`;
const compile = (xml, options) =>
  compileXmlModDocument(readXmlMod(xml, project), options);
function meshOf(result, i) {
  const entry = result.entities[i];
  assert.equal(entry.interpretation.status, "standard");
  const template = result.templates.get(entry.templateKey);
  assert.equal(template?.status, "standard-derived");
  return template.mesh;
}
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const minus = (a, b) => a.map((n, i) => n - b[i]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const vec = (array, index) =>
  Array.from(array.subarray(3 * index, 3 * index + 3));
const near = (a, b) =>
  assert.ok(Math.abs(a - b) < 1e-5, `expected ${a} ≈ ${b}`);
function checkTriangles(mesh, check) {
  const { positions, normals, indices } = mesh;
  assert.ok(
    positions instanceof Float32Array && normals instanceof Float32Array,
  );
  assert.ok(indices instanceof Uint16Array || indices instanceof Uint32Array);
  assert.equal(positions.length, normals.length);
  assert.equal(indices.length % 3, 0);
  for (let i = 0; i < indices.length; i += 3) {
    const ids = Array.from(indices.slice(i, i + 3));
    const [a, b, c] = ids.map((id) => vec(positions, id));
    const face = cross(minus(b, a), minus(c, a));
    for (const id of ids) {
      assert.ok(id * 3 < positions.length);
      const normal = vec(normals, id);
      near(Math.hypot(...normal), 1);
      assert.ok(
        dot(face, normal) > 0,
        "outward winding agrees with the vertex normal",
      );
      check(vec(positions, id), normal, face);
    }
  }
}
const basics = wrap(row(1, box), row(2, cylinder));
for (const [lod, segments] of [6, 12, 16].entries()) {
  const result = compile(basics, { lod });
  const cuboid = meshOf(result, 0),
    tube = meshOf(result, 1);
  assert.equal(cuboid.indices.length / 3, 12);
  for (const [axis, range] of [
    [0, [-10, 10]],
    [1, [-5, 5]],
    [2, [0, 6]],
  ]) {
    const coordinates = cuboid.positions.filter(
      (_, index) => index % 3 === axis,
    );
    assert.deepEqual(
      [Math.min(...coordinates), Math.max(...coordinates)],
      range,
    );
  }
  checkTriangles(cuboid, (point, normal) => {
    assert.deepEqual(
      [Math.abs(point[0]), Math.abs(point[1]), Math.abs(point[2] - 3)],
      [10, 5, 3],
    );
    assert.ok(dot(minus(point, [0, 0, 3]), normal) > 0);
  });
  const capArea = [0, 0];
  let sides = 0;
  checkTriangles(tube, ([x, y, z], normal, face) => {
    assert.ok(z === 0 || z === 9);
    if (normal[2] === 0) {
      near(Math.hypot(x, y), 4);
      near(dot(normal, [x, y, 0]), 4);
      sides++;
    } else {
      const cap = z === 0 ? 0 : 1;
      assert.deepEqual(normal, [0, 0, cap === 0 ? -1 : 1]);
      if (x || y) near(Math.hypot(x, y), 4);
      capArea[cap] += Math.abs(face[2]) / 6; // each triangle visited at three vertices
    }
  });
  assert.equal(sides / 3, 2 * segments);
  assert.equal(tube.indices.length / 3, 4 * segments);
  for (const area of capArea)
    near(area, segments * 8 * Math.sin((2 * Math.PI) / segments));
}

// G08: A.3.21 declarations inside the supported document wrapper.
const tm =
  '<TRANSFORMMATRIX VALUE="0,0,-114,5699.9999,0,1,0,0,1,0,0,0,0,0,0,1"/>';
const example = wrap(
  '<ENTITY ID="1" TYPE="SIMPLE" VISIBLE="FALSE"><CUBOID L="100" W="200" H="300"/>' +
    tm +
    "</ENTITY>",
  '<ENTITY ID="2" TYPE="SIMPLE" VISIBLE="FALSE"><SPHERE R="300"/>' +
    tm +
    "</ENTITY>",
  '<ENTITY ID="3" TYPE="SIMPLE" VISIBLE="TRUE"><RING R="300" DR="30" RAD="3.1416"/><COLOR R="0" G="100" B="255" A="0"/>' +
    tm +
    "</ENTITY>",
  '<ENTITY ID="4" TYPE="BOOLEAN" VISIBLE="TRUE"><BOOLEAN TYPE="INTERSECTION" ENTITY1="1" ENTITY2="2"/>' +
    tm +
    "</ENTITY>",
);
const raw = readXmlMod(example, standard);
assert.equal(raw.declaredEntityCount, 4);
assert.deepEqual(raw.diagnostics, []);
assert.deepEqual(
  raw.entities.filter((e) => e.visible).map((e) => e.id),
  [3, 4],
);
assert.deepEqual(
  raw.entities[3].operandIds.map((id) => raw.entitiesById.get(id).id),
  [1, 2],
);
assert.equal(raw.entities[2].primitive.rawAttributes.RAD, "3.1416");
assert.equal(raw.entities[2].color.B, "255");
assert.ok(raw.entities[0].rawTransformMatrix.includes("5699.9999"));
assert.equal(raw.entities[0].transformMatrix[12], 5699.9999);
assert.deepEqual(
  compileXmlModDocument(raw).entities.map((e) => e.interpretation.status),
  ["standard", "standard", "standard", "unsupported"],
);
const conflict = compileXmlModDocument(
  readXmlMod(example.replace('RAD="3.1416"', 'RAD="3.1416" Rad="1"'), standard),
);
assert.equal(conflict.entities[2].interpretation.status, "ambiguous");
assert.equal(conflict.entities[2].source.primitive.rawAttributes.Rad, "1");
assert.ok(
  conflict.entities[2].diagnostics.some(
    (d) => d.code === "conflicting-field" && d.location.ordinal === 3,
  ),
);
assert.throws(() => readXmlMod(basics, { sourcePath: project.sourcePath }), {
  code: "matrix-layout-required",
});
assert.throws(() => readXmlMod("<Device>", project), { code: "invalid-xml" });
assert.throws(() => readXmlMod(basics), { code: "matrix-layout-required" });

// G01: the two strings and both expected points are independent fixture values.
const layouts = [
  [standard, "0,-1,0,1000,1,0,0,200,0,0,1,30,0,0,0,1"],
  [project, "0,1,0,0,-1,0,0,0,0,0,1,0,1000,200,30,1"],
];
for (const [context, text] of layouts) {
  const document = readXmlMod(wrap(row(1, box + matrix(text))), context);
  const result = compileXmlModDocument(document);
  const entity = result.entities[0].source;
  assert.equal(document.matrixLayout, context.matrixLayout);
  assert.equal(entity.rawTransformMatrix, text);
  assert.deepEqual(document.diagnostics, []);
  const m = entity.transformMatrix;
  const [x, y, z] = [0, 1, 2].map((i) => 10 * m[i] + m[12 + i]);
  assert.deepEqual([x, y, z], [1000, 210, 30]);
  assert.deepEqual([-y / 1000, x / 1000, z / 1000], [-0.21, 1, 0.03]);
  assert.deepEqual(vec(meshOf(result, 0).positions, 0), [-10, -5, 0]);
}
// PR-0B will check these placement expectations at the Desktop adapter.
const fine = meshOf(compile(basics), 1);
const [nx, ny] = vec(fine.normals, 6); // segment 6/16 faces (+X,+Y)
const length = Math.hypot(nx / 2, ny);
near(nx / 2 / length, 1 / Math.sqrt(5));
near(ny / length, 2 / Math.sqrt(5));
near(dot([nx / 2 / length, ny / length], [2, -1]), 0);
// Mirror the prototype's +Z cap along X. Record independent expected
// triangle data for both adapter layouts, without changing the template.
const prototype = meshOf(compile(basics), 0);
const capIds = prototype.indices.slice(6, 9);
const mirrored = Array.from(capIds, (id) => {
  const [x, y, z] = vec(prototype.positions, id);
  return [-x, y, z];
});
function signedNormalZ([a, b, c]) {
  return cross(minus(b, a), minus(c, a))[2];
}
assert.equal(signedNormalZ(mirrored), -200);
const reversed = Uint16Array.of(0, 2, 1);
const unindexed = Float32Array.of(10, -5, 6, -10, 5, 6, -10, -5, 6);
const indexedTriangle = Array.from(reversed, (id) => mirrored[id]);
assert.deepEqual(indexedTriangle.flat(), Array.from(unindexed));
assert.equal(signedNormalZ(indexedTriangle), 200);
assert.deepEqual(prototype.indices.slice(6, 9), capIds);

// G09: document-local template identity, independent declarations and placements.
const pair = compile(
  wrap(
    row(8, cylinder + matrix("1,0,0,0,0,1,0,0,0,0,1,0,15,0,0,1")),
    row(
      12,
      '<CYLINDER R="4.0" H="9"/>' + matrix("1,0,0,0,0,1,0,0,0,0,1,0,30,0,0,1"),
    ),
  ),
);
assert.equal(pair.templates.size, 1);
assert.strictEqual(meshOf(pair, 0), meshOf(pair, 1));
assert.deepEqual(
  pair.entities.map((e) => [
    e.source.id,
    e.source.transformMatrix[12],
    e.source.primitive.rawAttributes.R,
  ]),
  [
    [8, 15, "4"],
    [12, 30, "4.0"],
  ],
);

// G13: 24 vertices fit the box exactly; a six-segment cylinder needs 26.
const partial = compile(basics, { lod: 0, limits: { maxVertices: 24 } });
meshOf(partial, 0);
assert.equal(partial.templates.size, 1);
assert.equal(partial.entities[1].templateKey, undefined);
const issue = partial.entities[1].diagnostics.find(
  (d) => d.code === "capacity-exceeded",
);
assert.deepEqual(issue.limit, {
  name: "maxVertices",
  requested: 26,
  allowed: 24,
});
assert.equal(issue.location.path, project.sourcePath);
assert.equal(issue.location.entityId, 2);
assert.equal(issue.location.ordinal, 2);
console.log(
  "MOD Node consumer passed: B.3/B.6 at all LODs, G01, G08, G09 and G13 vertex isolation.",
);

const basicFamily = compile(
  wrap(
    row(1, '<SPHERE R="10"/>'),
    row(
      2,
      '<OFFSETRECTANGULARTABLE LL="12" LW="8" TL="5" TW="3" H="9" XOFF="-2" YOFF="1"/>',
    ),
    row(3, '<TRUNCATEDCONE BR="10" TR="0.5" H="20"/>'),
    row(
      4,
      '<ECCENTRICTRUNCATEDCONE BR="10" TR="0.5" H="20" TOPXOFF="2" TOPYOFF="-1"/>',
    ),
    row(
      5,
      '<STRETCHEDBODY L="5" Normal="0,0,2" Array="0,0,0;10,0,0;10,6,0;0,6,0"/>',
    ),
  ),
);
for (let i = 0; i < 5; i++)
  assert.ok(meshOf(basicFamily, i).positions.length > 0);
assert.equal(basicFamily.entities[2].interpretation.canonical.topRadius, 0.5);
console.log("Basic solids Node consumer passed: B.1/B.5/B.8/B.9/B.16.");
const plates = compile(
  wrap(
    row(
      1,
      '<TerminalBlock L="200" W="60" T="8" CL="4" BL="20" CS="20" RS="30" CN="2" RN="3" R="3"/>',
    ),
    row(
      2,
      '<RectangularFixedPlate L="120" W="100" T="8" CS="20" RS="30" CN="2" RN="3" D="6" MH="1"/>',
    ),
    row(
      3,
      '<CircularFixedPlate L="100" W="100" T="8" CS="30" N="4" D="8" MH="0"/>',
    ),
  ),
);
for (let i = 0; i < 3; i++) assert.ok(meshOf(plates, i).indices.length > 36);
console.log("Perforated plates Node consumer passed: B.25/B.26/B.27.");
const profileDoc = compile(wrap(...profiles.map((p, i) => row(i + 1, p))));
for (const [i, e] of profileDoc.entities.entries()) {
  const result = profileDoc.templates.get(e.templateKey);
  assert.ok(result?.mesh?.indices.length);
  assert.equal(result.status, i === 1 ? "preview-only" : "standard-derived");
}
console.log("PR-4 Node consumer passed: 12 profile, sweep and section types.");
for (const lod of [0, 1, 2]) {
  const result = compile(wrap(...bodies.map((p, i) => row(i + 1, p))), { lod });
  assert.equal(result.templates.size, 7);
  for (const t of result.templates.values()) {
    assert.equal(t.status, "preview-only");
    assert.ok(t.mesh.indices.length);
    assert.ok(t.mesh.positions.every(Number.isFinite));
    assert.ok(t.mesh.normals.every(Number.isFinite));
  }
}
console.log(
  "PR-5 Node consumer passed: seven complex types at three LODs, including explicit preview evidence.",
);
