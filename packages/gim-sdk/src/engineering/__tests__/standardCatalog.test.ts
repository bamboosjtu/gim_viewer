import {it,expect} from 'vitest';
import {STANDARD_CATALOG,standardTerms} from '../standardCatalog.js';
import {interpretObject} from '../classify.js';
import {normalizeEngineeringModel} from '../normalize.js';
import {projectInventoryTemplate} from '../inventoryTemplate.js';
import {toObjectEvidence,type SourceRecord} from '../recognizeSource.js';
const field=(key:string,value:string)=>({keys:[key],value,path:'attributes.fam'});
const source=(id:string,type:string,patch:Partial<SourceRecord>={}):SourceRecord=>({id,track:'dev',source:`${id}.dev`,name:id,source_type:type,parent:'',properties:[],sources:[`${id}.dev`],context:[],guid:'',...patch});
const host=(id='host',name='1号主变',code='unit-1')=>source(id,'OilImmersedTransformer',{name,properties:[field('PROJECTNAME',name),field('GRIDIDENTIFICATIONSYSTEMCODE',code)]});
const build=(rows:SourceRecord[])=>normalizeEngineeringModel('scope',rows.map(toObjectEvidence));

it('covers every verified index row, using the maintained workbook hierarchy and highlighted additions',()=>{
  expect(STANDARD_CATALOG.filter(i=>i.kind==='equipment')).toHaveLength(60);
  expect(STANDARD_CATALOG.filter(i=>i.kind==='material')).toHaveLength(43);
  expect(STANDARD_CATALOG.filter(i=>i.kind==='construction')).toHaveLength(40);
  expect(standardTerms('MetalFence')[0].evidence.termCells).toEqual(['D41']);
  expect(standardTerms('Airduct')[0].evidence.sheet).toBe('材料模型索引表');
  expect(STANDARD_CATALOG.filter(i=>i.label==='均压屏蔽装置')).toHaveLength(2);
});
it.each(STANDARD_CATALOG.flatMap(item=>[item.term,item.label].map(name=>({item,name}))))('recognizes $name from structured source declarations',({item,name})=>{
  const result=interpretObject(toObjectEvidence(source('x','OTHERS',{properties:[field(item.kind==='equipment'?'EQUIPMENTTYPE':item.kind==='material'?'MATERIALTYPE':'构件类型',name)]})));
  const expected=standardTerms(name).length>1?undefined:item.id==='material:groundresistance'?item:standardTerms(name)[0];
  if(expected)expect(result.category).toBe(expected.category);
  else expect(result.category).toBe('U-OBJECT');
  if(expected)expect(result.standardClass).toMatchObject({id:expected.id,kind:item.kind,status:'confirmed'});
  expect(result.classificationEvidence?.length||result.standardClass?.evidence.length).toBeGreaterThan(0);
});
it.each([['IFCCABLESEGMENT','M07'],['IFCLIGHTFIXTURE','M05'],['IFCOUTLET','M05'],['IFCTRANSFORMER','E01'],['IFCRAMPFLIGHT','C02'],['IFCREINFORCINGBAR','C02'],['IFCCHILLER','C02']])('maps common outward IFC type %s', (type,category)=>{
  expect(interpretObject(toObjectEvidence(source('x',type,{track:'ifc'}))).category).toBe(category);
});
it('uses IFC predefined type without guessing porcelain, AC/DC or an internal IFC resource',()=>{
  const result=interpretObject(toObjectEvidence(source('x','IFCPROTECTIVEDEVICE',{track:'ifc',properties:[field('IFC.PredefinedType','CIRCUITBREAKER')]})));
  expect(result.category).toBe('E06');expect(result.equipmentType).toBeUndefined();expect(result.standardClass).toBeUndefined();
});
it('retains conflicting declared and source hosts without editing the physical edge',()=>{
  const rows=[host(),host('wrong','2号主变','unit-2'),source('radiator','Radiator',{name:'散热器',parent:'wrong',properties:[field('HOSTEQUIPMENTCODE','unit-1')]})];
  const result=build(rows);
  expect(rows[2].parent).toBe('wrong');
  expect(result.entities.every(e=>!e.sourceIds.includes('radiator'))).toBe(true);
  const member=result.memberships.find(m=>m.sourceId==='radiator')!;
  expect(member).toMatchObject({parentPartId:'wrong',disposition:'pending_whole_member'});
  expect(member.interpretation).toMatchObject({meaning:'part',membershipStatus:'unresolved',conflict:'composition_host_conflict'});
  expect(result.pending[0]).toMatchObject({reason:'composition_host_conflict',sourceIds:['radiator']});
  expect(projectInventoryTemplate(result).rowsBySource.has('radiator')).toBe(false);
  expect(build([...rows].reverse())).toEqual(result);
});
it('does not use numbered names or own designations as host declarations',()=>{
  const part=source('body','Body',{name:'1号主变_本体'});
  const result=build([host(),part]);expect(result.entities[0].sourceIds).toEqual(['host']);expect(result.pending[0].sourceIds).toEqual(['body']);
});
it('keeps unlabelled components pending and creates only declared numbered candidate hosts',()=>{
  expect(build([source('x','Body',{name:'本体'})]).pending[0].reason).toBe('component_whole_unresolved');
  expect(build([source('x','Body',{name:'1号主变_本体'})]).entities).toHaveLength(0);
  const result=build([source('body','Body',{properties:[field('HOSTEQUIPMENTNAME','3号主变')]}),source('radiator','Radiator',{properties:[field('HOSTEQUIPMENTNAME','3号主变')]})]);
  expect(result.entities).toHaveLength(1);expect(result.entities[0]).toMatchObject({category:'E01',boundaryStatus:'candidate',sourceIds:['body','radiator']});
});
it('does not absorb an explicitly independent controller or silently choose a conflicting host declaration',()=>{
  const result=build([host(),host('other','2号主变','unit-2'),source('control','ControlCabinet',{name:'控制柜',properties:[field('OBJECTROLE','independent'),field('HOSTEQUIPMENTCODE','unit-1')]}),source('body','Body',{properties:[field('HOSTEQUIPMENTCODE','unit-1'),field('HOSTEQUIPMENTNAME','2号主变')]})]);
  expect(result.entities.some(e=>e.sourceIds.length===1&&e.sourceIds[0]==='control')).toBe(true);expect(result.pending[0].reason).toBe('component_host_conflict');
});
