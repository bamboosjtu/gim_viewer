import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  classifyRegionalOpenings,
  queryRegionalObjects,
  RegionalIndexCollector,
} from '../ifcRegionalData.js';
it('streamed index undoes the engine origin once and includes omitted fasteners without rereading shared vertices', () => {
  const placed = (id: number, x: number) => ({
    expressID: id,
    geometries: {
      size: () => 1,
      get: () => ({
        geometryExpressID: 100,
        flatTransformation: new THREE.Matrix4().makeTranslation(x, 3, 4)
          .elements,
      }),
    },
  });
  const first = placed(1, 2),
    fastener = placed(2, 5);
  const vertices = vi.fn(
    () => new Float32Array([0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0])
  );
  const api: any = {
    GetLine: (_model: number, id: number) => ({
      GlobalId: { value: String(id) },
      Name: { value: 'part' },
      type: id === 2 ? 'IFCMECHANICALFASTENER' : 'IFCMEMBER',
    }),
    GetNameFromTypeCode: (v: string) => v,
    GetCoordinationMatrix: () =>
      new THREE.Matrix4().makeTranslation(-10, -20, -30).elements,
    GetGeometry: () => ({
      GetVertexData: () => 0,
      GetVertexDataSize: () => 12,
      delete: vi.fn(),
    }),
    GetVertexArray: vertices,
    StreamAllMeshes: (_model: number, callback: any) => {
      callback(first);
      callback(fastener);
    },
  };
  const collector = new RegionalIndexCollector(api, 0, true);
  collector.observe(first as any);
  const index = collector.finish({ unitScale: 1, openingRelations: [] });
  expect(index.objects.map((o) => o.bounds)).toEqual([
    [12, 23, 34, 13, 24, 35],
    [15, 23, 34, 16, 24, 35],
  ]);
  expect(index.objects[1].ifcType).toBe('IFCMECHANICALFASTENER');
  expect(vertices).toHaveBeenCalledOnce();
});
it('near policy skips small cross-sections, retains medium/unknown cutters, independent of cutter depth', () => {
  const lines: any = {
    1: { RelatedOpeningElement: { value: 11 } },
    2: { RelatedOpeningElement: { value: 12 } },
    3: { RelatedOpeningElement: { value: 13 } },
    11: { Representation: 21 },
    12: { Representation: 22 },
    13: { Representation: 23 },
    21: { Representations: [31] },
    22: { Representations: [32] },
    23: { Representations: [33] },
    31: { RepresentationIdentifier: { value: 'Body' }, Items: [41] },
    32: { RepresentationIdentifier: { value: 'Body' }, Items: [42] },
    33: { RepresentationIdentifier: { value: 'Body' }, Items: [43] },
    41: {
      type: 'IFCEXTRUDEDAREASOLID',
      SweptArea: 51,
      Depth: { value: 20000 },
    },
    42: { type: 'IFCEXTRUDEDAREASOLID', SweptArea: 52 },
    43: { type: 'IFCMAPPEDITEM' },
    51: {
      type: 'IFCRECTANGLEPROFILEDEF',
      XDim: { value: 16 },
      YDim: { value: 22 },
    },
    52: {
      type: 'IFCRECTANGLEPROFILEDEF',
      XDim: { value: 390 },
      YDim: { value: 20 },
    },
  };
  const api: any = {
    GetLine: (_model: number, id: number) => lines[id],
    GetNameFromTypeCode: (type: string) => type,
    GetLineIDsWithType: () => ({
      size: () => 3,
      get: (i: number) => i + 1,
      delete: vi.fn(),
    }),
  };
  const result = classifyRegionalOpenings(
    api,
    0,
    {
      objects: [],
      unitScale: 0.001,
      openingRelations: [
        { id: 1, host: 101, opening: 11 },
        { id: 2, host: 102, opening: 12 },
        { id: 3, host: 103, opening: 13 },
      ],
    },
    new Set([101, 102, 103])
  );
  expect(result.small).toEqual([1]);
  expect(result.unknown).toBe(1);
});
it('region uses camera distance plus frustum and includes intersecting long members', () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  camera.lookAt(0, 0, -1);
  camera.updateProjectionMatrix();
  const make = (expressId: number, bounds: number[]) => ({
    expressId,
    globalId: String(expressId),
    ifcType: 'IFCMEMBER',
    name: '',
    bounds,
  });
  const objects = [
    make(1, [-1, -1, -5, 1, 1, -4]),
    make(2, [-1, -1, -40, 1, 1, -39]),
    make(3, [-1, -1, 2, 1, 1, 3]),
    make(4, [-1, -1, -80, 1, 1, -20]),
  ];
  expect(
    queryRegionalObjects(objects, new THREE.Matrix4(), camera).map(
      (o) => o.expressId
    )
  ).toEqual([1, 4]);
});

it('BRep arrays classify per connected prism rather than their overall spacing', () => {
  const lines: any = {},
    faces: number[] = [];
  let next = 100;
  const row = (data: any) => {
    const id = next++;
    lines[id] = data;
    return id;
  };
  for (const center of [-175, 175]) {
    const caps = [0, 1].map((end) =>
      Array.from({ length: 8 }, (_, i) =>
        row({
          Coordinates: [
            11 * Math.cos((i * Math.PI) / 4),
            center + 11 * Math.sin((i * Math.PI) / 4),
            end * 10,
          ],
        })
      )
    );
    const polygons = [
      caps[0],
      caps[1],
      ...Array.from({ length: 8 }, (_, i) => [
        caps[0][i],
        caps[0][(i + 1) % 8],
        caps[1][(i + 1) % 8],
        caps[1][i],
      ]),
    ];
    for (const Polygon of polygons) {
      const loop = row({ Polygon }),
        bound = row({ Bound: loop });
      faces.push(row({ Bounds: [bound] }));
    }
  }
  const shell = row({ CfsFaces: faces }),
    solid = row({ type: 'IFCFACETEDBREP', Outer: shell }),
    rep = row({ RepresentationIdentifier: 'Body', Items: [solid] }),
    shape = row({ Representations: [rep] }),
    opening = row({ Representation: shape });
  const api: any = {
    GetLine: (_m: number, id: number) => lines[id],
    GetNameFromTypeCode: (t: string) => t,
  };
  const result = classifyRegionalOpenings(
    api,
    0,
    {
      objects: [],
      unitScale: 0.001,
      openingRelations: [{ id: 1, host: 10, opening }],
    },
    new Set([10])
  );
  expect(result.small).toEqual([1]);
});
