import { expect,it } from 'vitest';
import { extractEngineeringSourceGraph } from '../engineering/sourceGraph.js';
import { buildEngineeringSources } from '../engineering/buildSources.js';
import { projectEngineeringNavigation } from '../engineering/navigation.js';
import { projectEngineeringSource } from '../engineering/sourceProjection.js';
import { projectEngineeringInventory } from '../engineering/inventory.js';
import { projectEngineeringComposition } from '../../engineering/composition.js';

it('groups catalog subtypes while preserving distinct instances, internal members, and source-only rows',async()=>{
 const raw:Record<string,string>={'project.cbm':'SUBSYSTEM0=box.cbm\nSUBSYSTEM1=box.cbm\nSUBSYSTEM2=text.cbm',
  'box.cbm':'SYSTEMNAME1=10kV系统\nSYSTEMNAME2=36S\nOBJECTMODELPOINTER=box.dev',
  'box.dev':'TYPE=TerminalBox\nSYMBOLNAME=端子箱\nSUBDEVICE0=bolt.dev',
  'bolt.dev':'SYMBOLNAME=螺栓','text.cbm':'OBJECTMODELPOINTER=text.dev','text.dev':'SYMBOLNAME=模型文字'};
 const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]});
 const built=buildEngineeringSources('p',graph,[],[]),before=JSON.stringify(built.snapshot),view=projectEngineeringNavigation(built.sources,built.snapshot),inventory=view.inventory!;
 expect(built.snapshot.entities).toHaveLength(2);
 const subtypes=[...inventory.nodes.values()].filter(n=>n.kind==='group'&&n.title==='端子箱');
 expect(subtypes).toHaveLength(1);expect(subtypes[0].entityCount).toBe(2);expect(subtypes[0].children).toHaveLength(2);
 expect(inventory.rowsBySource.size).toBe(5);expect(inventory.nodes.get(inventory.rootKey)?.entityCount).toBe(2);
 expect(inventory.nodes.get(inventory.rootKey)!.children.map(key=>inventory.nodes.get(key)!.title)).toEqual(['设备','装置性材料','构件','其他']);
 expect([...inventory.nodes.values()].some(n=>n.title==='仅来源（不计整体）')).toBe(true);
 expect(view.compositionSearch.every(r=>r.subtitle.includes('36S'))).toBe(true);
 expect(view.inventorySearch!.every(r=>!r.subtitle.includes('36S')&&r.subtitle.includes('二次设备 / 端子箱'))).toBe(true);
 view.composition=projectEngineeringComposition(built.snapshot,built.snapshot.entities.map(e=>({entityId:e.id,paths:[[{key:'custom',title:'另一业务路径',kind:'system'}]],evidence:[]})),'另一个工程模板');
 expect(projectEngineeringInventory(built.snapshot,graph.records)).toEqual(inventory);
 const source=projectEngineeringSource(built.sources);expect(source.sourceNodes).toEqual(view.sourceNodes);
 expect(JSON.stringify(built.snapshot)).toBe(before);
 expect(new Set(Object.values(view.projectionVersions!)).size).toBe(3);
});

it('shows known and host-unresolved neutral sets as transformer attachments without inventing device identities',async()=>{
 const raw:Record<string,string>={'project.cbm':'SUBSYSTEM0=body.cbm\nSUBSYSTEM1=neutral.cbm',
  'body.cbm':'OBJECTMODELPOINTER=body.dev','body.dev':'TYPE=OilFilledTransformer\nSYMBOLNAME=主变压器',
  'neutral.cbm':'OBJECTMODELPOINTER=neutral.dev','neutral.dev':'TYPE=OpenGroundingEquipment/NeutralPointEquipment\nSYMBOLNAME=220kV中性点成套装置\nSUBDEVICE0=box.dev',
  'box.dev':'SYMBOLNAME=端子箱'};
 const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]});
 const built=buildEngineeringSources('p',graph,[],[]),view=projectEngineeringNavigation(built.sources,built.snapshot),inventory=view.inventory!;
 const neutral=built.snapshot.memberships.find(m=>m.interpretation.meaning==='neutral_set')!;
 expect(neutral.interpretation).toMatchObject({category:'E01',subtype:'neutral_set',subtypeLabel:'中性点成套装置',classificationStatus:'confirmed'});
 expect(built.snapshot.entities).toHaveLength(1);expect(built.snapshot.pending).toHaveLength(1);
 const pending=inventory.nodes.get(inventory.rowsByEntity.get(neutral.ownerId!)![0])!;
 const titles:string[]=[];for(let cursor:string|undefined=pending.key;cursor;cursor=inventory.nodes.get(cursor)?.parent)titles.unshift(inventory.nodes.get(cursor)!.title);
 expect(titles.slice(1,5)).toEqual(['设备','主变压器','附件（并入本体）','中性点成套装置']);
 expect(pending.boundaryStatus).toBe('unresolved');expect(inventory.nodes.get(inventory.rootKey)).toMatchObject({entityCount:1,attachmentCount:1});
 expect(built.snapshot.entities[0].sourceIds).not.toContain(neutral.sourceId);
 const internal:Record<string,string>={...raw,'project.cbm':'SUBSYSTEM0=body.cbm','body.cbm':'OBJECTMODELPOINTER=body.dev\nSUBSYSTEM0=neutral.cbm','body.dev':raw['body.dev']+'\nSUBDEVICE0=neutral.dev'};
 const nestedGraph=await extractEngineeringSourceGraph({paths:Object.keys(internal),readText:async p=>internal[p]});
 const nested=buildEngineeringSources('p',nestedGraph,[],[]),nestedView=projectEngineeringNavigation(nested.sources,nested.snapshot);
 expect(nested.snapshot.entities).toHaveLength(1);expect(nested.snapshot.pending).toHaveLength(0);
 expect(nestedView.inventory!.nodes.get(nestedView.inventory!.rootKey)).toMatchObject({entityCount:1,attachmentCount:1});
});

it('projects generic secondary equipment directly under E16 without changing its unresolved subtype facts',async()=>{
 const raw:Record<string,string>={'project.cbm':'OBJECTMODELPOINTER=generic.dev','generic.dev':'TYPE=SecondaryCabinet\nSYMBOLNAME=二次单元'};
 const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]}),built=buildEngineeringSources('p',graph,[],[]);
 const before=JSON.stringify(built.snapshot),view=projectEngineeringNavigation(built.sources,built.snapshot),inventory=view.inventory!;
 const entity=built.snapshot.entities[0],node=inventory.nodes.get(inventory.rowsByEntity.get(entity.id)![0])!;
 expect(entity).toMatchObject({category:'E16',subtype:'unresolved'});
 expect(inventory.nodes.get(node.parent!)!.title).toBe('二次设备');
 expect([...inventory.nodes.values()].some(n=>n.kind==='group'&&n.title==='具体类型待确认')).toBe(false);
 expect(JSON.stringify(built.snapshot)).toBe(before);
 expect(view.inventorySearch![0].subtitle).toBe('设备材料清册 / 设备 / 二次设备');
});
