import {it,expect} from 'vitest';
import {STANDARD_CATALOG,standardTerms} from '../standardCatalog.js';
import {interpretObject} from '../classify.js';
import {normalizeEngineeringModel} from '../normalize.js';
import {projectEngineeringComposition} from '../composition.js';
import {projectInventoryTemplate} from '../inventoryTemplate.js';
import {toObjectEvidence,type SourceRecord} from '../../gim/engineering/sourceEvidence.js';
const field=(key:string,value:string)=>({keys:[key],value,path:'attributes.fam'});
const source=(id:string,type:string,patch:Partial<SourceRecord>={}):SourceRecord=>({id,track:'dev',source:`${id}.dev`,name:id,source_type:type,parent:'',properties:[],sources:[`${id}.dev`],context:[],guid:'',...patch});
const host=(id='host',name='1号主变',code='unit-1')=>source(id,'OilImmersedTransformer',{name,properties:[field('PROJECTNAME',name),field('GRIDIDENTIFICATIONSYSTEMCODE',code)]});
const build=(rows:SourceRecord[])=>normalizeEngineeringModel('scope',rows.map(toObjectEvidence));

it('covers every verified index row, excluding the repeated material header and joining split English cells',()=>{
  expect(STANDARD_CATALOG.filter(i=>i.kind==='equipment')).toHaveLength(52);
  expect(STANDARD_CATALOG.filter(i=>i.kind==='material')).toHaveLength(39);
  expect(STANDARD_CATALOG.filter(i=>i.kind==='construction')).toHaveLength(30);
  expect(standardTerms('MetalFence')[0].evidence.termCells).toEqual(['D41','E41']);
  expect(standardTerms('Airduct')[0].evidence.pdfPage).toBe(13);
  expect(standardTerms('均压屏蔽装置')).toHaveLength(2);
});
it.each(STANDARD_CATALOG.flatMap(item=>[item.term,item.label].map(name=>({item,name}))))('recognizes $name from structured source declarations',({item,name})=>{
  const result=interpretObject(toObjectEvidence(source('x',name)));
  expect(result.category.startsWith(item.kind==='equipment'?'E':item.kind==='material'?'M':'C')).toBe(true);
  if(standardTerms(name).length===1)expect(result.standardClass).toMatchObject({id:item.id,kind:item.kind,status:'confirmed'});
  expect(result.classificationEvidence?.length||result.standardClass?.evidence.length).toBeGreaterThan(0);
});
it.each([['IFCCABLESEGMENT','M05'],['IFCLIGHTFIXTURE','M11'],['IFCOUTLET','M13'],['IFCTRANSFORMER','E-T'],['IFCRAMPFLIGHT','C-A9'],['IFCREINFORCINGBAR','C-B5'],['IFCCHILLER','E19']])('maps common outward IFC type %s', (type,category)=>{
  expect(interpretObject(toObjectEvidence(source('x',type,{track:'ifc'}))).category).toBe(category);
});
it('uses IFC predefined type without guessing porcelain, AC/DC or an internal IFC resource',()=>{
  const result=interpretObject(toObjectEvidence(source('x','IFCPROTECTIVEDEVICE',{track:'ifc',properties:[field('IFC.PredefinedType','CIRCUITBREAKER')]})));
  expect(result.category).toBe('E06');expect(result.equipmentType).toBeUndefined();expect(result.standardClass).toBeUndefined();
});
it('recovers a part under the declared equipment despite an incorrect source parent, preserving the physical source edge',()=>{
  const rows=[host(),host('wrong','2号主变','unit-2'),source('radiator','Radiator',{name:'散热器',parent:'wrong',properties:[field('HOSTEQUIPMENTCODE','unit-1')]})];
  const result=build(rows),owner=result.entities.find(e=>e.sourceIds.includes('host'))!;
  expect(owner.sourceIds).toEqual(['host','radiator']);expect(rows[2].parent).toBe('wrong');
  const member=result.memberships.find(m=>m.sourceId==='radiator')!;
  expect(member.interpretation).toMatchObject({meaning:'part',membershipStatus:'confirmed'});expect(member.interpretation.membershipEvidence?.[0]).toContain('HOSTEQUIPMENTCODE');
  const view=projectEngineeringComposition(result,[],'project'),entity=view.nodes.get(view.rowsByEntity.get(owner.id)![0])!;
  expect(entity.children.map(key=>view.nodes.get(key)?.sourceId)).toContain('radiator');expect(entity.entityCount).toBe(1);
  const inventory=projectInventoryTemplate(result,rows.map(r=>({id:r.id,parent:r.parent,title:r.name,documentPath:r.source,sourceType:r.source_type})));
  expect(inventory.nodes.get(inventory.rowsBySource.get('radiator')!)?.parent).toBe(inventory.rowsByEntity.get(owner.id)![0]);
  expect(build([...rows].reverse())).toEqual(result);
});
it('supports numbered name fallback with a confirmed component term, while retaining host ambiguity',()=>{
  const part=source('body','Body',{name:'1号主变_本体'});
  expect(build([host(),part]).entities[0].sourceIds).toEqual(['body','host']);
  const ambiguous=build([host(),host('duplicate'),part]);
  expect(ambiguous.entities).toHaveLength(2);expect(ambiguous.pending[0].reason).toBe('component_host_ambiguous');
});
it('keeps unlabelled components pending and creates only declared numbered candidate hosts',()=>{
  expect(build([source('x','Body',{name:'本体'})]).pending[0].reason).toBe('component_whole_unresolved');
  expect(build([source('x','Body',{name:'1号主变_本体'})]).entities).toHaveLength(0);
  const result=build([source('body','Body',{properties:[field('HOSTEQUIPMENTNAME','3号主变')]}),source('radiator','Radiator',{properties:[field('HOSTEQUIPMENTNAME','3号主变')]})]);
  expect(result.entities).toHaveLength(1);expect(result.entities[0]).toMatchObject({category:'E01',boundaryStatus:'candidate',sourceIds:['body','radiator']});
});
it('does not absorb an explicitly independent controller or silently choose a conflicting host declaration',()=>{
  const result=build([host(),host('other','2号主变','unit-2'),source('control','ControlCabinet',{name:'控制柜',properties:[field('OBJECTROLE','independent'),field('HOSTEQUIPMENTCODE','unit-1')]}),source('body','Body',{properties:[field('HOSTEQUIPMENTCODE','unit-1'),field('HOSTEQUIPMENTNAME','2号主变')]})]);
  expect(result.entities.some(e=>e.sourceIds.length===1&&e.sourceIds[0]==='control')).toBe(true);expect(result.pending[0].reason).toBe('component_host_ambiguous');
});
