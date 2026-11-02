import { describe, expect, it } from 'vitest';
import { projectEngineeringComposition } from '../composition.js';
import { normalizeEngineeringModel } from '../normalize.js';
import type { ObjectEvidence } from '../types.js';
const evidence = (sourceId: string, name: string, assemblyParentId?: string): ObjectEvidence => ({ sourceId, name, assemblyParentId,
  traits: {}, designations: [], identityCodes: [], identityNames: [], phases: [] });
describe('whole-only composition projection', () => {
  it('keeps an independently identified cabinet out of the main transformer while hiding its radiator design part', () => {
    const snapshot = normalizeEngineeringModel('package', [evidence('body', '主变压器'), evidence('radiator', '散热器', 'body'), evidence('box', '端子箱', 'body')], []);
    const view = projectEngineeringComposition(snapshot, [], '工程');
    expect([...view.nodes.values()].filter(n => n.kind === 'entity').map(n => n.title).sort()).toEqual(['主变压器', '端子箱']);
    expect(view.nodes.get(view.rootKey)?.entityCount).toBe(2);
    expect(snapshot.memberships.find(m => m.sourceId === 'radiator')?.ownerId).toBe(snapshot.memberships.find(m => m.sourceId === 'body')?.ownerId);
  });
  it('deduplicates entity counts across multiple contextual references without assigning a business parent to the entity', () => {
    const snapshot = normalizeEngineeringModel('package', [evidence('beam', '钢梁')], []), entity = snapshot.entities[0];
    const view = projectEngineeringComposition(snapshot, [{ entityId: entity.id, evidence: ['declared-space'], paths: [
      [{ key: 'A', title: '楼 A', kind: 'building' }], [{ key: 'B', title: '楼 B', kind: 'building' }],
    ] }], '工程');
    expect(view.rowsByEntity.get(entity.id)).toHaveLength(2);
    expect(view.nodes.get(view.rootKey)?.entityCount).toBe(1);
    expect(entity).not.toHaveProperty('parentId');
  });
});
