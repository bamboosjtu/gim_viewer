import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Evaluator } from 'three-bvh-csg';
import {
  compileGeometrySource,
  placeGeometrySource,
  queryGeometryRange,
  type GeometryInput,
} from '@gim/gim-sdk/geometry';
import { readDomXmlMod, parseXmlMod } from '../../gim/geometry/xmlModParser.js';
import { geometryBatchToGroup } from '../geometryBatch.js';
import { collectBakedGeometriesByMaterial } from '../xmlModGeometry.js';
import { documentBounds, stlBounds } from '../../services/dev-geometry/devSpatialCatalog.js';
const xml =
  '<Device><Entities><Entity ID="9"><Cuboid L="4" W="6" H="8"/><TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,10,0,0,1"/></Entity></Entities></Device>';
const path = 'MOD/box.mod';
const input: GeometryInput = {
  format: 'xml-mod',
  sourceVersion: 'sha',
  document: readDomXmlMod(xml, path, 'project-column-major'),
};
const ascii = new TextEncoder().encode(
  'solid t\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n',
);
it.each([
  input,
  {
    format: 'stl',
    sourceVersion: 'sha',
    sourcePath: 'MOD/t.stl',
    bytes: ascii,
  } satisfies GeometryInput,
])('maps $format into two independent placed meshes sharing one BufferGeometry', (source) => {
  const compiled = compileGeometrySource(source);
  const outer = new THREE.Matrix4().set(-2, 0.5, 0, 500, 0, 3, 0, 600, 0, 0, 1, 700, 0, 0, 0, 1);
  const batch = placeGeometrySource(compiled, [
    { rootOccurrence: 'A', assemblyPath: 'solid:0', localToParent: new THREE.Matrix4().toArray() },
    { rootOccurrence: 'B', assemblyPath: 'solid:0', localToParent: outer.toArray() },
  ]);
  const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
  const group = geometryBatchToGroup(
    batch,
    (part) => materials[part.address.rootOccurrence === 'A' ? 0 : 1],
  );
  group.updateMatrixWorld(true);
  const [a, b] = group.children as THREE.Mesh[];
  expect(a.geometry).toBe(b.geometry);
  expect(a.material).not.toBe(b.material);
  expect(a.userData.geometryInstanceId).not.toBe(b.userData.geometryInstanceId);
  expect(b.userData.geometrySourceAddress).toMatchObject({
    format: source.format,
    rootOccurrence: 'B',
    sourceVersion: 'sha',
  });
  const template = compiled.templates.get(batch.objects[0].parts[0].templateKey)!;
  if (template.kind !== 'mesh') throw Error('Expected a mesh template');
  expect(a.geometry.getAttribute('position').array).toBe(template.mesh.positions);
  expect(a.geometry.index?.array).toBe(template.mesh.indices);
  const local = new THREE.Vector3().fromBufferAttribute(a.geometry.getAttribute('position'), 0);
  const x = local.x + (source.format === 'xml-mod' ? 10 : 0);
  const expected = new THREE.Vector3(
    (-2 * x + 0.5 * local.y + 500) * 0.001,
    (3 * local.y + 600) * 0.001,
    (local.z + 700) * 0.001,
  );
  expect(local.clone().applyMatrix4(b.matrixWorld).distanceTo(expected)).toBeLessThan(1e-10);
  b.matrix.identity();
  group.updateMatrixWorld(true);
  expect(
    local
      .clone()
      .applyMatrix4(a.matrixWorld)
      .distanceTo(new THREE.Vector3(x, local.y, local.z).multiplyScalar(0.001)),
  ).toBeLessThan(1e-10);
  a.geometry.dispose();
  materials.forEach((m) => m.dispose());
});
it('uses range-only SDK and Desktop paths on a visible Boolean with hidden operands', () => {
  const csg = vi.spyOn(Evaluator.prototype, 'evaluate'),
    buffer = vi.spyOn(THREE.BufferGeometry.prototype, 'setAttribute');
  const tree =
    '<Device><Entities><Entity ID="1" Visible="false"><Cuboid L="4" W="6" H="8"/></Entity><Entity ID="2" Visible="false"><Cuboid L="2" W="2" H="2"/></Entity><Entity ID="3"><Boolean Type="Difference" Entity1="1" Entity2="2"/></Entity></Entities></Device>';
  const d = parseXmlMod(tree, path);
  try {
    expect(
      queryGeometryRange(
        {
          ...input,
          format: 'xml-mod',
          document: readDomXmlMod(tree, path, 'project-column-major'),
        },
        { purpose: 'display' },
      ),
    ).toMatchObject({ coverage: 'conservative', bounds: { max: [2, 3, 8] } });
    expect(documentBounds(d).box.max.toArray()).toEqual([2, 3, 8]);
    expect(stlBounds(ascii.buffer)!.max.toArray()).toEqual([10, 10, 0]);
    expect(csg).not.toHaveBeenCalled();
    expect(buffer).not.toHaveBeenCalled();
    // Positive control: the detailed production entry does reach the same evaluator.
    const baked = collectBakedGeometriesByMaterial(d, 2);
    expect(csg).toHaveBeenCalledTimes(1);
    for (const meshes of baked.values()) meshes.forEach((m) => m.dispose());
  } finally {
    buffer.mockRestore();
    csg.mockRestore();
  }
});
