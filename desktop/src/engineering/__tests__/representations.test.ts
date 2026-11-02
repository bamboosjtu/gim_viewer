import { describe, expect, it } from 'vitest';
import { normalizeEngineeringModel } from '../normalize.js';
import { EngineeringRepresentationIndex } from '../representations.js';
import type { ObjectEvidence } from '../types.js';

const source = (sourceId: string, name: string, assemblyParentId?: string): ObjectEvidence => ({ sourceId, name, assemblyParentId,
  traits: {}, designations: [], identityCodes: [], identityNames: [], phases: [] });
function fixture() {
  const snapshot = normalizeEngineeringModel('package', [source('body', '主变压器'), source('box', '本体端子箱', 'body'), source('radiator', '散热器', 'body')]);
  const index = new EngineeringRepresentationIndex(snapshot, [
    { kind: 'dev', sourceId: 'body', rootOccurrence: 'physical', assemblyPath: '', devPath: 'body.dev' },
    { kind: 'dev', sourceId: 'box', rootOccurrence: 'physical', assemblyPath: 'sub:0', devPath: 'box.dev' },
    { kind: 'dev', sourceId: 'radiator', rootOccurrence: 'physical', assemblyPath: 'sub:1', devPath: 'radiator.dev' },
  ]);
  return { snapshot, index };
}

describe('engineering representation membership', () => {
  it('excludes an independent nested cabinet from the body selection', () => {
    const { index, snapshot } = fixture();
    const main = snapshot.entities.find(e => e.category === 'E01')!;
    const selected = index.sourcesForOwners(new Set([main.id]));
    expect([...selected]).toEqual(['body', 'radiator']);
    expect(index.includesDev('physical', { assemblyPath: '' }, selected)).toBe(true);
    expect(index.includesDev('physical', { assemblyPath: 'sub:1/sub:2' }, selected)).toBe(true);
    expect(index.includesDev('physical', { assemblyPath: 'sub:0' }, selected)).toBe(false);
    expect(index.resolveDev('physical', { assemblyPath: 'sub:0' }).ownerIds).toEqual([snapshot.entities.find(e => e.category === 'E16.terminal_box')!.id]);
  });
  it('keeps an unseparated mixed representation ambiguous', () => {
    const { index, snapshot } = fixture();
    const body = index.sourcesForOwners(new Set([snapshot.entities.find(e => e.category === 'E01')!.id]));
    expect(index.resolveDev('physical').status).toBe('ambiguous');
    expect(index.includesDev('physical', {}, body)).toBe(false);
  });
  it('resolves fine ambiguity when every candidate belongs to the same whole', () => {
    const snapshot = normalizeEngineeringModel('p', [source('root', '绝缘子串'), source('a', '金具球', 'root'), source('b', '金具球', 'root')]);
    const index = new EngineeringRepresentationIndex(snapshot, ['root', 'a', 'b'].map(sourceId => ({ kind: 'dev', sourceId, rootOccurrence: 'r', assemblyPath: '', devPath: 'same.dev' })));
    expect(index.resolveDev('r').status).toBe('bound');
    expect(index.resolveDev('r').sourceIds).toHaveLength(3);
  });
  it('keeps repeated IFC GUIDs distinct using model plus express identity', () => {
    const snapshot = normalizeEngineeringModel('p', [source('a', '梁'), source('b', '梁')]);
    const index = new EngineeringRepresentationIndex(snapshot, [
      { kind: 'ifc', sourceId: 'a', modelId: 'm', expressId: 1, globalId: 'duplicate' },
      { kind: 'ifc', sourceId: 'b', modelId: 'm', expressId: 2, globalId: 'duplicate' },
    ]);
    expect(index.resolveIfc('m', 1).sourceIds).toEqual(['a']);
    expect(index.resolveIfc('m', 2).sourceIds).toEqual(['b']);
    expect(index.resolveIfc('other', 1).status).toBe('unassociated');
  });
  it('uses path segment boundaries, the nearest ancestor and all same-address candidates', () => {
    const snapshot = normalizeEngineeringModel('p', [source('root', '主变压器'), source('a', '端子箱'), source('b', '端子箱'), source('other', '端子箱')]);
    const index = new EngineeringRepresentationIndex(snapshot, [
      { kind: 'dev', sourceId: 'root', rootOccurrence: 'r', assemblyPath: '', devPath: 'body.dev' },
      { kind: 'dev', sourceId: 'a', rootOccurrence: 'r', assemblyPath: 'sub:2', devPath: 'Custom/Box.DEV' },
      { kind: 'dev', sourceId: 'b', rootOccurrence: 'r', assemblyPath: 'sub:2', devPath: 'Custom/Box.DEV' },
      { kind: 'dev', sourceId: 'other', rootOccurrence: 'r2', assemblyPath: 'sub:2', devPath: 'Custom/Box.DEV' },
    ]);
    expect(index.resolveDev('r', { assemblyPath: 'sub:2/phm:0/mod:3' })).toMatchObject({ status: 'ambiguous', sourceIds: ['a', 'b'] });
    expect(index.resolveDev('r', { assemblyPath: 'sub:20/phm:0' }).sourceIds).toEqual(['root']);
    expect(index.resolveDev('r2', { assemblyPath: 'sub:20' }).status).toBe('unassociated');
    expect(index.resolveDev('r', { devPath: 'custom\\box.dev' }).sourceIds).toEqual(['a', 'b']);
    expect(index.resolveDev('r', { devPath: 'missing.dev' }).sourceIds).toEqual(['a', 'b', 'root']);
    expect(index.resolveDev('r2', { assemblyPath: 'sub:2/sub:9' }).sourceIds).toEqual(['other']);
  });
});
