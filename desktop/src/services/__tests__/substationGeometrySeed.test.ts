import { describe, expect, it } from 'vitest';
import type { CbmNode } from '../../gim/types.js';
import {
  collectCbmDeviceInstances,
  isGeometryAutoLoadSeed,
} from '../modAutoLoadService.js';
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

describe('substation geometry seed selection', () => {
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

    expect(isGeometryAutoLoadSeed(root)).toBe(true);
    expect(isGeometryAutoLoadSeed(partIndex)).toBe(false);
    expect(isGeometryAutoLoadSeed(virtualChild)).toBe(false);
    expect(collectCbmDeviceInstances(root).map((item) => item.devPath))
      .toEqual(['root.dev', 'independent.dev']);
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
