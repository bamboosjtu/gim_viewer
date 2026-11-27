import { expect, it } from 'vitest';
import * as THREE from 'three';
import { MessageChannel } from 'node:worker_threads';
import { readXmlMod } from '../../../../packages/gim-sdk/node-xml-mod-consumer.mjs';
import { parseXmlMod, readDomXmlMod } from '../../gim/geometry/xmlModParser.js';
import { parseWorkerXmlMod, readWorkerXmlMod } from '../../gim/geometry/xmlModWorkerParser.js';
import { projectXmlMod } from '../../gim/geometry/xmlModDocument.js';
import { collectBakedGeometriesByMaterial, geometryFromMeshData } from '../xmlModGeometry.js';
import {
  applyPlacementTransformToSceneUnits,
  loadXmlModFromFiles,
  XML_MOD_GEOMETRY_DIAGNOSTICS_KEY,
} from '../xmlModLoader.js';

const path = 'MOD/mixed.mod';
const wrap = (rows: string) => '<Device><Entities>' + rows + '</Entities></Device>';
const entity = (id: number, body: string, visible = true) =>
  `<ENTITY ID="${id}" VISIBLE="${visible}">${body}</ENTITY>`;
const m = (values: string) => `<TRANSFORMMATRIX VALUE="${values}"/>`;
const box = '<CUBOID L="300" W="300" H="300"/>';
const ctx = { sourcePath: path, matrixLayout: 'a3-21-example' } as const;

it('G08 keeps declarations, operand scope and stable diagnostics across Node, Worker and DOM', () => {
  const raw = wrap(
    entity(1, box, false) +
      entity(2, '<SPHERE R="200"/>', false) +
      entity(3, '<RING R="300" DR="20" RAD="3" Rad="1"/>') +
      entity(4, '<BOOLEAN TYPE="INTERSECTION" ENTITY1="1" ENTITY2="2"/>'),
  );
  const expected = readXmlMod(raw, ctx);
  expect(expected.entities.filter((e) => e.visible).map((e) => e.id)).toEqual([3, 4]);
  expect(expected.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'conflicting-field', ordinal: 3 }),
  );
  for (const read of [readDomXmlMod, readWorkerXmlMod]) {
    expect(read(raw, path, ctx.matrixLayout)).toEqual(expected);
    expect(() => read('<Device><', path, ctx.matrixLayout)).toThrowError(
      expect.objectContaining({ code: 'invalid-xml' }),
    );
  }
  expect(() => readXmlMod('<Device><', ctx)).toThrowError(
    expect.objectContaining({ code: 'invalid-xml' }),
  );
});

it('G01 carries a known local point through both serializations, Entity baking, parent placement and mm to m', () => {
  for (const [layout, values] of [
    ['a3-21-example', '0,-1,0,1000,1,0,0,200,0,0,1,30,0,0,0,1'],
    ['project-column-major', '0,1,0,0,-1,0,0,0,0,0,1,0,1000,200,30,1'],
  ] as const) {
    const doc = projectXmlMod(
      readDomXmlMod(wrap(entity(1, '<CUBOID L="20" W="10" H="6"/>' + m(values))), path, layout),
    );
    const baked = collectBakedGeometriesByMaterial(doc, 2);
    const geometry = [...baked.values()][0][0],
      group = new THREE.Group();
    group.add(new THREE.Mesh(geometry));
    applyPlacementTransformToSceneUnits(
      group,
      new THREE.Matrix4().makeRotationZ(Math.PI / 2).toArray(),
    );
    // Midpoint of bottom edge from (+10,-5,0) to (+10,+5,0), in source mm.
    const positions = geometry.getAttribute('position');
    const point = new THREE.Vector3()
      .fromBufferAttribute(positions, 2)
      .lerp(new THREE.Vector3().fromBufferAttribute(positions, 3), 0.5);
    for (const [i, v] of point.toArray().entries()) expect(v).toBeCloseTo([-0.21, 1, 0.03][i], 6);
  }
});

it.each([true, false])(
  'G01 mirrored baking uses inverse transpose and preserves template buffers (indexed=%s)',
  (indexed) => {
    const a = 1 / Math.sqrt(2);
    const source = {
      positions: new Float32Array([0, 0, 0, 1, -1, 0, 0, 0, -1]),
      normals: new Float32Array([a, a, 0, a, a, 0, a, a, 0]),
      indices: indexed ? new Uint16Array([0, 1, 2]) : undefined,
    };
    const template = geometryFromMeshData(source),
      instance = template.clone(),
      group = new THREE.Group();
    group.add(new THREE.Mesh(instance));
    applyPlacementTransformToSceneUnits(group, new THREE.Matrix4().makeScale(-2, 1, 1).toArray());
    const get = (n: number) =>
      new THREE.Vector3().fromBufferAttribute(
        instance.getAttribute('position'),
        instance.index?.getX(n) ?? n,
      );
    const face = get(1)
      .sub(get(0))
      .cross(get(2).sub(get(0)))
      .normalize();
    const normal = new THREE.Vector3().fromBufferAttribute(instance.getAttribute('normal'), 0);
    expect(normal.x).toBeCloseTo(-1 / Math.sqrt(5));
    expect(normal.y).toBeCloseTo(2 / Math.sqrt(5));
    expect(face.dot(normal)).toBeCloseTo(1);
    expect(Array.from(source.positions)).toEqual([0, 0, 0, 1, -1, 0, 0, 0, -1]);
    if (indexed) expect(Array.from(source.indices!)).toEqual([0, 1, 2]);
  },
);

it.each([parseXmlMod, parseWorkerXmlMod])(
  'G10 keeps the independent visible root and changes the bore only in detailed LOD',
  async (parse) => {
    for (const missing of [false, true]) {
      const text = wrap(
        entity(1, '<SPHERE R="200"/>', false) +
          entity(2, '<CYLINDER R="60" H="500"/>' + m('1,0,0,0,0,1,0,0,0,0,1,0,0,0,-250,1'), false) +
          entity(3, `<BOOLEAN TYPE="DIFFERENCE" ENTITY1="1" ENTITY2="${missing ? 9 : 2}"/>`) +
          entity(4, box + m('1,0,0,0,0,1,0,0,0,0,1,0,800,0,0,1')),
      );
      const files = new Map([[path, { text: async () => text } as File]]);
      for (const lod of [0, 1, 2] as const) {
        const group = await loadXmlModFromFiles(path, files, undefined, undefined, {
          parseXml: parse,
          lod,
          strict: true,
        });
        const data = group!.userData[XML_MOD_GEOMETRY_DIAGNOSTICS_KEY];
        expect(data.status).toBe(missing ? 'partial' : 'renderable');
        group!.updateMatrixWorld(true);
        const hits = (x: number) =>
          new THREE.Raycaster(
            new THREE.Vector3(x, 0.013, 1),
            new THREE.Vector3(0, 0, -1),
          ).intersectObject(group!, true).length;
        expect(hits(0.8)).toBeGreaterThan(0);
        if (!missing) {
          expect(hits(0.012) > 0).toBe(lod !== 2);
          expect(hits(0.12)).toBeGreaterThan(0);
        } else
          expect(data.failedVisibleRoots).toContainEqual(expect.objectContaining({ rootId: 3 }));
      }
    }
  },
);

it('transfers an owned copy and leaves the shared template drawable', async () => {
  const template = geometryFromMeshData({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  });
  const owned = template.clone().getAttribute('position').array as Float32Array<ArrayBuffer>;
  const { port1, port2 } = new MessageChannel();
  try {
    const received = new Promise<Float32Array>((resolve) => port2.once('message', resolve));
    port1.postMessage(owned, [owned.buffer]);
    expect(owned.byteLength).toBe(0);
    expect(Array.from(await received)).toEqual(Array.from(template.getAttribute('position').array));
    expect(template.getAttribute('position').array.byteLength).toBe(36);
  } finally {
    port1.close();
    port2.close();
    template.dispose();
  }
});

it('G04 renders a through-hole, the surrounding metal and both B.25 bevels in production coordinates', async()=>{
  const plate=wrap(entity(1,'<TerminalBlock L="200" W="60" T="8" CL="8" BL="20" CS="20" RS="30" CN="2" RN="3" R="3"/>'));
  const files=new Map([[path,{text:async()=>plate} as File]]);
  for(const lod of [0,1,2] as const){
    const group=await loadXmlModFromFiles(path,files,undefined,undefined,{parseXml:parseWorkerXmlMod,lod,strict:true});
    group!.updateMatrixWorld(true);
    const hits=(x:number,z:number)=>new THREE.Raycaster(new THREE.Vector3(x,-1,z),new THREE.Vector3(0,1,0)).intersectObject(group!,true).length;
    expect(hits(.01,.02)).toBe(0);
    expect(hits(.0015,.024)).toBeGreaterThan(0);
    expect(hits(.029,.199)).toBe(0);
    expect(hits(-.029,.199)).toBe(0);
  }
});

it('retains the circular plate small-part threshold in outline LODs',()=>{
  const doc=parseXmlMod(wrap(entity(1,box)+entity(2,'<CircularFixedPlate L="80" W="80" T="5" CS="20" N="3" MH="0" D="4"/>')),path);
  for(const lod of [0,1,2] as const){
    const bucket=collectBakedGeometriesByMaterial(doc,lod);
    expect(bucket.omittedSmallParts).toBe(lod<2?1:0);
    for(const pieces of bucket.values())for(const geometry of pieces)geometry.dispose();
  }
});
