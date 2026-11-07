import { describe, expect, it } from 'vitest';
import { projectEngineeringComposition, finalizeEngineeringComposition } from '../composition.js';
import { normalizeEngineeringModel } from '../normalize.js';
import type { ObjectEvidence } from '../types.js';
const evidence = (sourceId: string, name: string, assemblyParentId?: string): ObjectEvidence => ({ sourceId, name, assemblyParentId,
  traits: {}, designations: [], identityCodes: [], identityNames: [], phases: [] });
describe('whole-only composition projection', () => {
  it('keeps an independently identified cabinet out of the main transformer while hiding its radiator design part', () => {
    const snapshot = normalizeEngineeringModel('package', [evidence('body', '主变压器'), evidence('radiator', '散热器', 'body'), evidence('box', '测控柜', 'body')], []);
    const view = projectEngineeringComposition(snapshot, [], '工程');
    expect([...view.nodes.values()].filter(n => n.kind === 'entity').map(n => n.title).sort()).toEqual(['主变压器', '测控柜']);
    expect(view.nodes.get(view.rootKey)?.entityCount).toBe(2);
    expect(snapshot.memberships.find(m => m.sourceId === 'radiator')?.ownerId).toBe(snapshot.memberships.find(m => m.sourceId === 'body')?.ownerId);
  });
  it('deduplicates entity counts across multiple contextual references without assigning a business parent to the entity', () => {
    const snapshot = normalizeEngineeringModel('package', [evidence('beam', '钢梁')], []), entity = snapshot.entities[0];
    const view = projectEngineeringComposition(snapshot, [{ entityId: entity.id, paths: [
      [{ key: 'A', title: '楼 A', kind: 'building' }], [{ key: 'B', title: '楼 B', kind: 'building' }],
    ] }], '工程');
    expect(view.rowsByEntity.get(entity.id)).toHaveLength(2);
    expect(view.nodes.get(view.rootKey)?.entityCount).toBe(1);
    expect(entity).not.toHaveProperty('parentId');
  });
});

it('orders buildings and outdoor areas and hides empty declarations only in the final view',()=>{
 const snapshot=normalizeEngineeringModel('p',[evidence('wall','墙')]),entity=snapshot.entities[0];
 const groups=[
  {key:'building:aux',title:'辅助用房',kind:'building' as const},
  {key:'area:distribution:10',title:'10千伏配电装置区域',kind:'area' as const},
  {key:'building:110',title:'110千伏配电装置楼',kind:'building' as const},
  {key:'area:main',title:'主变区域',kind:'area' as const},
  {key:'building:control',title:'主控通信楼',kind:'building' as const},
  {key:'area:distribution:220',title:'220千伏配电装置区域',kind:'area' as const},
  {key:'building:220',title:'220千伏配电装置楼',kind:'building' as const},
 ];
 const view=projectEngineeringComposition(snapshot,[{entityId:entity.id,paths:groups.map(g=>[g])}],'工程',[{path:[{key:'empty',title:'空声明楼',kind:'building'}],sourceContextIds:['context']}]);
 expect([...view.nodes.values()].some(n=>n.title==='空声明楼')).toBe(true);
 finalizeEngineeringComposition(view);
 expect(view.nodes.get(view.rootKey)!.children.map(k=>view.nodes.get(k)!.title)).toEqual(['主控通信楼','220千伏配电装置楼','110千伏配电装置楼','辅助用房','主变区域','220千伏配电装置区域','10千伏配电装置区域']);
 expect(view.rowsByEntity.get(entity.id)).toHaveLength(7);
});
