import { describe, expect, it } from 'vitest';
import { extractEngineeringSourceGraph } from '../../source/sourceGraph.js';
import { collectSourceGeometryOccurrences } from '../geometryOccurrences.js';
const matrix = (x: number, y: number, z = 0) => [1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1].join(',');
async function graph(raw: Record<string, string>) { return extractEngineeringSourceGraph({ paths: Object.keys(raw), readText: async path => raw[path] }); }
describe('physical occurrence placement independent of tree grain', () => {
  it('preserves two references to one CBM/template as separate instances and accumulates every source transform', async () => {
    const g = await graph({
      'project.cbm': `SUBSYSTEM0=left.cbm\nSUBSYSTEM1=right.cbm\nTRANSFORMMATRIX=${matrix(1000, 2000)}`,
      'left.cbm': `SUBSYSTEM0=shared.cbm\nTRANSFORMMATRIX=${matrix(100, 0)}`,
      'right.cbm': `SUBSYSTEM0=shared.cbm\nTRANSFORMMATRIX=${matrix(300, 0)}`,
      'shared.cbm': `ENTITYNAME=F2System\nOBJECTMODELPOINTER=models/device.dev\nTRANSFORMMATRIX=${matrix(0, 400)}`,
      'models/device.dev': 'SYMBOLNAME=断路器',
    });
    const catalog = collectSourceGeometryOccurrences(g);
    expect(catalog.diagnostics).toEqual([]); expect(new Set(catalog.occurrences.map(o => o.id)).size).toBe(2);
    expect(catalog.occurrences.map(o => o.devPath)).toEqual(['models/device.dev', 'models/device.dev']);
    expect(catalog.occurrences.map(o => o.placementMatrix.slice(12, 15))).toEqual([[1100, 2400, 0], [1300, 2400, 0]]);
  });
  it('keeps unmatched PARTINDEX evidence without inventing a physical root', async () => {
    const g = await graph({ 'project.cbm': 'OBJECTMODELPOINTER=root.dev\nSUBSYSTEM0=alias.cbm\nSUBSYSTEM1=independent.cbm',
      'root.dev': 'SYMBOLNAME=主变压器\nSUBDEVICE0=box.dev', 'box.dev': 'SYMBOLNAME=端子箱',
      'alias.cbm': 'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=box.dev',
      'independent.cbm': 'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=other.dev', 'other.dev': 'SYMBOLNAME=控制柜' });
    expect(g.aliases).toHaveLength(2);
    expect(g.aliases.find(a=>a.status==='unresolved')?.candidates).toEqual([]);
    expect(g.cbmOccurrences.some(n=>n.documentPath==='independent.cbm')).toBe(true);
    expect(collectSourceGeometryOccurrences(g).occurrences.map(o => o.devPath)).toEqual(['root.dev']);
  });
  it('multiplies a rotated ancestor and translated child in source column-major order', async () => {
    const rotation = [0,1,0,0,-1,0,0,0,0,0,1,0,0,0,0,1].join(',');
    const g = await graph({ 'project.cbm': `SUBSYSTEM0=child.cbm\nTRANSFORMMATRIX=${rotation}`,
      'child.cbm': `OBJECTMODELPOINTER=unit.dev\nTRANSFORMMATRIX=${matrix(1000, 0)}`, 'unit.dev': 'SYMBOLNAME=设备' });
    const placed = collectSourceGeometryOccurrences(g).occurrences[0].placementMatrix;
    expect(placed[12]).toBeCloseTo(0); expect(placed[13]).toBeCloseTo(1000);
    expect(placed).toEqual([0,1,0,0,-1,0,0,0,0,0,1,0,0,1000,0,1]);
  });
  it('does not discard independent children merely because an ancestor references the same template', async () => {
    const g = await graph({ 'project.cbm': 'OBJECTMODELPOINTER=same.dev\nSUBSYSTEM0=child.cbm', 'same.dev': 'SYMBOLNAME=设备',
      'child.cbm': 'ENTITYNAME=F3System\nOBJECTMODELPOINTER=same.dev' });
    expect(collectSourceGeometryOccurrences(g).occurrences).toHaveLength(2);
  });
  it('reports an invalid source transform and preserves the original text while matching browser identity fallback', async () => {
    const g = await graph({ 'project.cbm': 'OBJECTMODELPOINTER=unit.dev\nTRANSFORMMATRIX=invalid', 'unit.dev': 'SYMBOLNAME=设备' });
    const value = collectSourceGeometryOccurrences(g);
    expect(value.diagnostics[0].reason).toBe('invalid-source-matrix');
    expect(value.occurrences[0].placementMatrix).toEqual([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    expect(g.documents[0].rawLines).toContain('TRANSFORMMATRIX=invalid');
  });
});
