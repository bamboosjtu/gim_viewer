import { expect, it, vi } from 'vitest';
import type { IfcAPI } from 'web-ifc';
import { navigationCatalog } from '../ifcNavigationSource.js';
import type { RegionalIndex } from '../../ifcRegionalData.js';
it('keeps the IFC express identity, isolates unlocated products and releases the native ID vector', () => {
  const del = vi.fn();
  const ids = [7, 9, 11];
  const api = {
    GetLineIDsWithType: () => ({ size: () => ids.length, get: (i: number) => ids[i], delete: del }),
    GetLine: (_: number, id: number) => ({
      type: id,
      GlobalId: { value: id === 9 ? '' : 'slab' },
      Representation: { value: 1 },
      Name: { value: 'floor' },
    }),
    GetNameFromTypeCode: (id: number) => (id === 11 ? 'IFCSPACE' : 'IFCSLAB'),
  } as unknown as IfcAPI;
  const index = {
    unitScale: 0.001,
    objects: [7, 9].map((expressId) => ({ expressId, bounds: [1, 2, 3, 4, 5, 6] })),
  } as RegionalIndex;
  const result = navigationCatalog(api, 0, index);
  expect(result.products).toMatchObject([
    { expressId: 7, globalId: 'slab', bounds: [1, 2, 3, 4, 5, 6] },
  ]);
  expect(result.unknown).toEqual(['9']);
  expect(del).toHaveBeenCalledOnce();
});
