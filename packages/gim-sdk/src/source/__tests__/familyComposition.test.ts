import {expect,it} from 'vitest';
import {extractEngineeringSourceGraph} from '../sourceGraph.js';
import {toObjectEvidence} from '../../adapters/recognizeSource.js';
import {normalizeEngineeringModel} from '../../semantic/normalize.js';
import {projectInventoryTemplate} from '../../projection/inventoryTemplate.js';

it('uses each real CBM family, retaining empty-family children without borrowing host attributes',async()=>{
 const entries:Record<string,string>={
  'project.cbm':'OBJECTMODELPOINTER=host.dev\nBASEFAMILY=host.fam\nSUBDEVICE0=part.cbm\nSUBDEVICE1=empty.cbm',
  'host.dev':'TYPE=OilImmersedTransformer\nSUBDEVICE0=part.dev\nSUBDEVICE1=empty.dev',
  'host.fam':'[设计参数]\n模型分类名称=模型分类名称=油浸式变压器\n工程中名称=PROJECTNAME=host-designation',
  'part.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=part.dev\nBASEFAMILYPOINTER=part.fam',
  'part.dev':'TYPE=OTHERS\nSYMBOLNAME=arbitrary-part',
  'part.fam':'[设计参数]\n类型=类型=散热器',
  'empty.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=empty.dev\nBASEFAMILY=empty.fam',
  'empty.dev':'TYPE=OTHERS\nSYMBOLNAME=arbitrary-unknown',
  'empty.fam':'[设计参数]\n',
 };
 const reads=new Map<string,number>();
 const graph=await extractEngineeringSourceGraph({paths:Object.keys(entries),readText:async path=>{reads.set(path,(reads.get(path)??0)+1);return entries[path];}});
 const model=normalizeEngineeringModel('scope',graph.records.map(toObjectEvidence),graph.aliases);
 expect(model.entities).toHaveLength(1);expect(model.entities[0].sourceIds).toHaveLength(3);
 expect(model.pending).toHaveLength(0);
 const part=graph.records.find(r=>r.source==='part.dev')!,empty=graph.records.find(r=>r.source==='empty.dev')!;
 expect(part.properties).toContainEqual(expect.objectContaining({path:'part.fam',line:2,keys:['类型'],value:'散热器'}));
 expect(empty.properties.some(p=>p.path==='host.fam')).toBe(false);
 expect(model.memberships.find(m=>m.sourceId===part.id)?.interpretation).toMatchObject({meaning:'part',componentType:{id:'radiator',status:'confirmed'},membershipStatus:'confirmed'});
 expect(model.memberships.find(m=>m.sourceId===empty.id)?.interpretation).toMatchObject({meaning:'part',membershipStatus:'candidate'});
 expect([...reads.values()].every(count=>count===1)).toBe(true);
});

it('groups a cabinet by confirmed protection-device family and actual ownership independently of display words',async()=>{
 const entries:Record<string,string>={
  'project.cbm':'OBJECTMODELPOINTER=cabinet.dev\nBASEFAMILY=cabinet.fam\nSUBDEVICE0=protection.cbm',
  'cabinet.dev':'TYPE=SecondaryCabinet\nSYMBOLNAME=arbitrary-cabinet\nSUBDEVICE0=protection.dev',
  'cabinet.fam':'[设计参数]\n模型分类名称=模型分类名称=二次屏柜',
  'protection.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=protection.dev\nBASEFAMILY=protection.fam',
  'protection.dev':'TYPE=OTHERS\nSYMBOLNAME=unrelated-display',
  'protection.fam':'[设计参数]\n装置名称=装置名称=变压器保护装置',
 };
 const graph=await extractEngineeringSourceGraph({paths:Object.keys(entries),readText:async path=>entries[path]});
 const model=normalizeEngineeringModel('scope',graph.records.map(toObjectEvidence),graph.aliases);
 expect(model.entities).toHaveLength(1);
 expect(model.entities[0]).toMatchObject({category:'E17',subtype:'main_transformer_protection_cabinet',subtypeLabel:'主变压器保护柜',subtypeStatus:'confirmed'});
 expect(model.entities[0].subtypeEvidence).toEqual(expect.arrayContaining([expect.stringContaining('protection.fam')]));
 const inventory=projectInventoryTemplate(model);
 const row=inventory.nodes.get(inventory.rowsByEntity.get(model.entities[0].id)![0])!;
 const ancestors:string[]=[];for(let key=row.parent;key;key=inventory.nodes.get(key)?.parent)ancestors.push(inventory.nodes.get(key)!.title);
 expect(ancestors).toEqual(expect.arrayContaining(['二次屏柜']));
 expect(ancestors).not.toContain('主变压器保护柜');
 expect(ancestors).not.toContain('变压器');
 expect(ancestors).not.toContain('类型待确认');
});
