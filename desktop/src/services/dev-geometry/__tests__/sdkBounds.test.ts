import { expect, it, vi } from 'vitest';
import { BufferGeometry } from 'three';
import { parseWorkerXmlMod } from '../../../gim/geometry/xmlModWorkerParser.js';
import { buildDevSourceBounds, documentBounds, tupleBox } from '../devSpatialCatalog.js';
import {
  deviceTemplateCacheKey,
  DEV_SHAPE_POLICY,
} from '../../../infrastructure/cache/devLodIdentity.js';

it('G11 keeps the high box in local metres through both directory paths and a cache round trip', async () => {
  const file = (path: string, text: string) =>
    ({ name: path, size: text.length, text: async () => text }) as File;
  const xml =
    '<Device><Entities><Entity ID="1"><Cuboid L="20" W="10" H="900"/><TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,10,0,0,1"/></Entity></Entities></Device>';
  const files = new Map([
    ['a.dev', file('a.dev', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=a.phm')],
    ['a.phm', file('a.phm', 'SOLIDMODELS.NUM=1\nSOLIDMODEL0=a.mod')],
    ['a.mod', file('a.mod', xml)],
  ]);
  const mesh = vi.spyOn(BufferGeometry.prototype, 'setAttribute');
  try {
    const cold = await buildDevSourceBounds('a.dev', files, parseWorkerXmlMod);
    const patrol = await buildDevSourceBounds('a.dev', files, parseWorkerXmlMod, {}, true);
    expect(cold).toMatchObject({
      sourceBounds: [0, -0.005, 0, 0.02, 0.005, 0.9],
      boundsQuality: 'conservative',
    });
    expect(patrol).toEqual(cold);
    expect(JSON.parse(JSON.stringify(cold))).toEqual(cold);
    const key = deviceTemplateCacheKey('sha', 'a.dev', 0);
    expect(key).toContain(DEV_SHAPE_POLICY);
    expect(key).not.toContain('project-column-major-v1:a.dev');
    const mixed = xml.replace('</Entities>', '<Entity ID="2"><Unknown/></Entity></Entities>');
    const range = documentBounds(parseWorkerXmlMod(mixed, 'a.mod'));
    expect(range.unknown).toBe(true);
    expect(tupleBox(range.box)).toEqual([0, -5, 0, 20, 5, 900]);
    expect(mesh).not.toHaveBeenCalled();
  } finally {
    mesh.mockRestore();
  }
});
