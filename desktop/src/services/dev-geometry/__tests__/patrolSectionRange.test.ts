import { expect, it } from 'vitest';
import * as THREE from 'three';
import { parseWorkerXmlMod } from '../../../gim/geometry/xmlModWorkerParser.js';
import { documentBounds } from '../devSpatialCatalog.js';

it('uses the browser profile envelope consistently for patrol and visible sections', () => {
  const bounds = (tag: string, model: string, patrol = true) => {
    const xml =
      '<Device><Entities><Entity ID="1" Visible="true"><' +
      tag +
      ' Length="1600" Model="' +
      model +
      '"/></Entity></Entities></Device>';
    return documentBounds(parseWorkerXmlMod(xml, 'section.mod'), patrol);
  };
  expect(bounds('BeamChannel', '[10').unknown).toBe(false);
  expect(bounds('BeamChannel', '[10').box.max.x).toBeCloseTo(24);
  expect(bounds('H', '[10').box.max.toArray()).toEqual([50, 800, 50]);
  expect(bounds('LightBeamChannel', '[10').box.max.toArray()).toEqual([24, 800, 50]);
  expect(bounds('BeamChannel', 'C10').box.max.toArray()).toEqual([24, 800, 50]);
  expect(bounds('BeamChannel', '[10', false).unknown).toBe(false);
});

it('includes the real curved tube between fit points and localizes only explicitly dimensioned plate gaps', () => {
  const bounds = (tag: string) =>
    documentBounds(
      parseWorkerXmlMod(
        '<Device><Entities><Entity ID="1" Visible="true">' + tag + '</Entity></Entities></Device>',
        'MOD/range.mod',
      ),
      true,
    );
  expect(bounds('<Table LL1="450" LL2="300" H="150"/>').unknown).toBe(true);
  expect(bounds('<Table LL1="450" LL2="300" TL1="225" TL2="150" H="150"/>').box.max.toArray()).toEqual([225,150,150]);
  const plate = bounds('<RectangularFixedPlate L="108" W="83" T="20"/>');
  expect(plate.unknown).toBe(true);
  const fullPlate=bounds('<RectangularFixedPlate L="108" W="83" T="20" CN="2" RN="2" CS="30" RS="25" MH="0" D="4"/>');
  expect(fullPlate.unknown).toBe(false);
  expect(fullPlate.box.min.x).toBe(-54);
  expect(bounds('<RectangularFixedPlate L="108" T="20"/>').unknown).toBe(true);
  expect(bounds('<TableGasket OR="139" TR="136" IR="134" H="20"/>').box.max.toArray()).toEqual([
    139, 139, 20,
  ]);
  expect(bounds('<TableGasket OR="100" TR="110" IR="90" H="20"/>').box.max.toArray()).toEqual([110,110,20]);
  const points = [
    new THREE.Vector3(-20, 0, 1),
    new THREE.Vector3(0, 10, 5),
    new THREE.Vector3(20, 10, 5),
    new THREE.Vector3(40, 0, 1),
  ];
  const tube = bounds(
    '<Wire D="4" FitCoordArray="' + points.map((p) => p.toArray().join(',')).join(';') + '"/>',
  );
  const curve = new THREE.CatmullRomCurve3(points);
  for (const p of curve.getPoints(80)) {
    expect(tube.box.containsPoint(p.clone().addScalar(2))).toBe(true);
    expect(tube.box.containsPoint(p.clone().subScalar(2))).toBe(true);
  }
});

it('tracks representation quality of reachable leaves, including hidden Boolean operands', () => {
  const rows = [
    '<Entity ID="1" Visible="false"><Wire D="2" Sag="1" StartCoord="0,0,0" EndCoord="30,0,0" StartVector="1,0,0" EndVector="1,0,0" FitCoordArray="0,0,0;15,0,0;30,0,0"/></Entity>',
    '<Entity ID="2"><Table LL1="10" LL2="8" TL1="5" TL2="4" H="9"/></Entity>',
    '<Entity ID="3"><RectangularFixedPlate L="108" W="83" T="20" CN="2" RN="2" CS="30" RS="25" MH="0" D="4"/></Entity>',
  ];
  const bounds = (extra: string) => documentBounds(parseWorkerXmlMod('<Device><Entities>' + rows.join('') + extra + '</Entities></Device>', 'MOD/quality.mod'));
  expect(bounds('')).toMatchObject({estimatedGeometryCount: 0, unknown: false});
  const used = bounds('<Entity ID="4"><Boolean Type="Union" Entity1="1" Entity2="2"/></Entity>');
  expect(used.estimatedGeometryCount).toBe(1);
  expect(used.reasons.join(' ')).toMatch(/Wire.*preview-only/);
});
