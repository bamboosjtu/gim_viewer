import { describe, expect, it } from 'vitest';
import type { CbmNode } from '../../gim/types.js';
import { collectEquipmentGeometryOccurrences } from '../../gim/equipmentGeometryOccurrences.js';
import { isSubstationGeometryRoot } from '../../gim/substationEvidence.js';
import { resolveGeometryLoadNode } from '../nodeInteractionService.js';

function node(overrides: Partial<CbmNode>): CbmNode {
  return {
    path: 'CBM/node.cbm',
    name: 'node',
    entityName: 'F4System',
    children: [],
    famPath: '',
    devPath: '',
    ifcFile: '',
    ifcGuid: '',
    classifyName: '',
    transformMatrix: '',
    systemNames: [],
    devSymbolName: '',
    devType: '',
    devExpanded: false,
    ...overrides,
  };
}

describe('standalone equipment assembly seed adapter', () => {
  it('does not use PARTINDEX or DEV_SUBDEVICE aliases as full-load seeds', () => {
    const partIndex = node({
      path: 'CBM/root.cbm/part.cbm',
      entityName: 'PARTINDEX',
      devPath: 'child.dev',
    });
    const virtualChild = node({
      path: 'CBM/root.cbm#dev:0:child.dev',
      entityName: 'DEV_SUBDEVICE',
      devPath: 'child.dev',
    });
    const independentRoot = node({
      path: 'CBM/independent.cbm',
      devPath: 'independent.dev',
    });
    const root = node({
      path: 'CBM/root.cbm',
      devPath: 'root.dev',
      children: [partIndex, virtualChild, independentRoot],
    });

    expect(isSubstationGeometryRoot(root)).toBe(true);
    expect(isSubstationGeometryRoot(partIndex)).toBe(false);
    expect(isSubstationGeometryRoot(virtualChild)).toBe(false);
    expect(collectEquipmentGeometryOccurrences(root).map((item) => item.devPath))
      .toEqual(['root.dev', 'independent.dev']);
  });

  it('treats virtual/alias entity names case-insensitively', () => {
    expect(isSubstationGeometryRoot(node({ entityName: 'partIndex', devPath: 'child.dev' }))).toBe(false);
    expect(isSubstationGeometryRoot(node({ entityName: 'dev_subDevice', devPath: 'child.dev' }))).toBe(false);
    expect(isSubstationGeometryRoot(node({ entityName: 'f4system', devPath: 'device.dev' }))).toBe(true);
  });

  it('resolves a PARTINDEX click to its nearest device ancestor', () => {
    const partIndex = node({
      path: 'CBM/root.cbm/part.cbm',
      entityName: 'PARTINDEX',
      devPath: 'child.dev',
    });
    const root = node({
      path: 'CBM/root.cbm',
      devPath: 'root.dev',
      children: [partIndex],
    });

    expect(resolveGeometryLoadNode(root, partIndex)).toBe(root);
  });
});
