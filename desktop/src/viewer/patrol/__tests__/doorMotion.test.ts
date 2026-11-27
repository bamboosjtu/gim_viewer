import { expect, it } from 'vitest';
import type { IfcAPI } from 'web-ifc';
import { Vector3 } from 'three';
import { doorTransform, readDoorMotion } from '../doorMotion.js';

it('requires a separate documented leaf and an oriented source sweep, including a rotation centre', () => {
  const types = [
    'IFCDOOR',
    'IFCPRODUCTDEFINITIONSHAPE',
    'IFCSHAPEREPRESENTATION',
    'IFCTRIMMEDCURVE',
    'IFCCIRCLE',
    'IFCCARTESIANPOINT',
    'IFCAXIS2PLACEMENT2D',
    'IFCEXTRUDEDAREASOLID',
    'IFCRECTANGLEPROFILEDEF',
    'IFCLOCALPLACEMENT','IFCAXIS2PLACEMENT3D','IFCDIRECTION',
  ];
  const ref = (value: number) => ({ value });
  const xyz = (x: number, y: number) => [ref(x), ref(y)];
  const rows = new Map<number, Record<string, unknown>>();
  const row = (id: number, type: string, data: Record<string, unknown>) =>
    rows.set(id, { expressID: id, type: types.indexOf(type), ...data });
  row(1, 'IFCDOOR', { Representation: ref(2) });
  row(2, 'IFCPRODUCTDEFINITIONSHAPE', { Representations: [ref(3), ref(4)] });
  row(3, 'IFCSHAPEREPRESENTATION', {
    RepresentationIdentifier: { value: 'Body' },
    Items: [ref(20)],
  });
  row(20, 'IFCEXTRUDEDAREASOLID', { SweptArea: ref(21) });
  row(21, 'IFCRECTANGLEPROFILEDEF', {});
  row(4, 'IFCSHAPEREPRESENTATION', {
    RepresentationIdentifier: { value: 'FootPrint' },
    Items: [ref(5)],
  });
  row(5, 'IFCTRIMMEDCURVE', {
    BasisCurve: ref(6),
    Trim1: [ref(7)],
    Trim2: [ref(8)],
    SenseAgreement: { value: true },
  });
  row(6, 'IFCCIRCLE', { Position: ref(9), Radius: ref(900) });
  row(7, 'IFCCARTESIANPOINT', { Coordinates: xyz(1900, 0) });
  row(8, 'IFCCARTESIANPOINT', { Coordinates: xyz(1000, 900) });
  row(9, 'IFCAXIS2PLACEMENT2D', { Location: ref(10) });
  row(10, 'IFCCARTESIANPOINT', { Coordinates: xyz(1000, 0) });
  const api = {
    GetLine: (_: number, id: number) => rows.get(id),
    GetNameFromTypeCode: (i: number) => types[i],
  } as unknown as IfcAPI;
  const d = readDoorMotion(api, 0, 1, 'IFCDOOR', '建筑门扇', 0.001)!;
  expect(d.hingePosition).toEqual([1, 0, 0]);
  expect(
    new Vector3(...d.closedTip)
      .applyMatrix4(doorTransform(d, d.openAngle))
      .distanceTo(new Vector3(1, 0.9, 0)),
  ).toBeLessThan(1e-7);
  expect(readDoorMotion(api, 0, 1, 'IFCDOOR', '门框', 0.001)).toBeUndefined();
  row(1,'IFCDOOR',{Representation:ref(2),ObjectPlacement:ref(30)});
  row(30,'IFCLOCALPLACEMENT',{RelativePlacement:ref(31)});
  row(31,'IFCAXIS2PLACEMENT3D',{Location:ref(32),RefDirection:ref(33)});
  row(32,'IFCCARTESIANPOINT',{Coordinates:[ref(10000),ref(20000),ref(3000)]});
  row(33,'IFCDIRECTION',{DirectionRatios:[ref(0),ref(1),ref(0)]});
  const placed=readDoorMotion(api,0,1,'IFCDOOR','建筑门扇',0.001)!;
  expect(placed.hingePosition).toEqual([10,21,3]);
  expect(placed.closedTip).toEqual([10,21.9,3]);
  expect(placed.hingeAxis).toEqual([0,0,1]);
  expect(new Vector3(...placed.closedTip).applyMatrix4(doorTransform(placed,placed.openAngle)).distanceTo(new Vector3(9.1,21,3))).toBeLessThan(1e-7);
  rows.delete(5);
  expect(readDoorMotion(api, 0, 1, 'IFCDOOR', '建筑门扇', 0.001)).toBeUndefined();
});
