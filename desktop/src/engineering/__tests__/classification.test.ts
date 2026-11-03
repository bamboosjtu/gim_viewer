import { expect,it } from 'vitest';
import { categoryFromName, interpretObject } from '../classify.js';
import { normalizeEngineeringModel } from '../normalize.js';
import { ENGINEERING_CATEGORIES, ENGINEERING_CATEGORY_LABELS } from '../catalogLabels.js';
import type { ObjectEvidence } from '../types.js';
import { toObjectEvidence } from '../../gim/engineering/sourceEvidence.js';

const value=(value:string)=>({value,evidenceId:`fixture:${value}`});
const row=(name:string,extra:Partial<ObjectEvidence>={}):ObjectEvidence=>({sourceId:'x',name,traits:{},designations:[],identityCodes:[],identityNames:[],phases:[],...extra});

it.each([
 ['CircuitBreaker','隔离开关','E06'],['SecondaryCabinet','主变压器测控柜','E16.control_cabinet'],
 ['OilFilledTransformer','站用变压器','E03'],['OilFilledTransformer','变压器','E-T'],
 ['CircuitBreaker','柜体','E06'],['PostInsulator','主变压器','M04'],
 ['E17','端子箱','E17'],['E01','站用变压器','E01'],
])('uses object type %s before conflicting name %s', (source_type,name,category)=>{
 const object=toObjectEvidence({id:'x',track:'dev',source:'x.dev',name,source_type,parent:'',properties:[],sources:['x.dev'],context:[],guid:''});
 expect(interpretObject(object).category).toBe(category);
 if(category==='E06'&&name==='隔离开关')expect(interpretObject(object).conflict).toBe('E06!=E07');
});

it('uses current-object attributes, detects conflicts, and never lets parent family naming promote a component',()=>{
 expect(interpretObject(row('主变压器',{propertyCategories:[value('E16')]}))).toMatchObject({category:'E16'});
 expect(interpretObject(row('未知',{typeCategory:'E-T',propertyCategories:[value('E03')]}))).toMatchObject({category:'E03',basis:'object_attribute'});
 expect(interpretObject(row('断路器',{typeCategory:'E06',propertyCategories:[value('E07')]}))).toMatchObject({category:'U-OBJECT',classificationStatus:'unresolved',unknownReason:'conflicting_object_attributes'});
 expect(normalizeEngineeringModel('p',[row('断路器',{typeCategory:'E06',propertyCategories:[value('E07')]})]).pending[0].reason).toBe('object_attributes_conflict');
 expect(interpretObject(row('在线监测仪',{identityNames:[value('主变压器')]})).meaning).toBe('part');
 expect(interpretObject(row('中性点套管',{typeCategory:'neutral_set'})).meaning).toBe('neutral_set');
 expect(interpretObject(row('土建接口',{typeCategory:'neutral_set'})).meaning).toBe('neutral_set');
 expect(interpretObject(row('模型01',{identityNames:[value('220kV中性点成套装置')]}))).toMatchObject({meaning:'neutral_set',subtype:'neutral_set',classificationStatus:'candidate'});
 expect(interpretObject(row('在线监测仪',{identityNames:[value('220kV中性点成套装置')]}))).toMatchObject({meaning:'part'});
 expect(interpretObject(row('测控柜',{typeCategory:'E16',identityNames:[value('220kV中性点成套装置')]}))).toMatchObject({meaning:'object',category:'E16.control_cabinet'});
});

it.each([
 ['导线','M01'],['母线','M02'],['均压环','M03'],['绝缘子串','M04'],['电缆','M05'],['接地极','M06'],['穿墙套管','M07'],['电缆桥架','M08'],['封堵','M09'],
 ['墙体','C-A1'],['楼板','C-A2'],['柱','C-A3'],['梁','C-A4'],['格栅板','C-A5'],['屋面','C-A6'],['门','C-A7'],['窗','C-A8'],['楼梯','C-A9'],['面层','C-A10'],
 ['母线支架','C-B1'],['主变基础','C-B2'],['承台','C-B3'],['基础','C-B4'],['型钢','C-B5'],['檩条','C-B6'],['避雷针','C-B7'],
 ['电缆沟盖板','C-C1'],['排水沟','C-C2'],['检查井','C-C3'],['围墙','C-C4'],['地坪','C-C5'],
 ['灯具','C-D1'],['灭火器箱','C-D2'],['摄像机','C-D3'],['风管','C-D4'],['喷淋头','C-D5'],['标识','C-D6'],
 ['电缆终端','E17'],['成套水泵','E19'],['绝缘子支架','C-B1'],['母线套管','M07'],['潜污泵','C-D5'],
 ['闸阀','E19'],['绝缘子基础','C-B2'],
])('classifies fallback noun %s as %s',(name,category)=>expect(categoryFromName(name)).toBe(category));

it.each([
 '喷淋头 - 闭式 - 边墙型:ZSTB-15A\u00a0',
 '喷淋头 - 闭式 - 边墙型:ZSTB-20 - 57�C:664791',
 '喷淋头 - 闭式 - 边墙型:ZSTB-15A&#xA0;',
 '侧墙型喷淋头',
])('does not classify sprinkler form factors as a wall: %s',name=>{
 expect(categoryFromName(name)).toBe('C-D5');
 expect(interpretObject(row(name))).toMatchObject({category:'C-D5',meaning:'object'});
});

it('keeps real walls and specific type evidence intact when removing form-factor adjectives',()=>{
 expect(categoryFromName('边墙')).toBe('C-A1');expect(categoryFromName('墙体 - 常规')).toBe('C-A1');
 expect(interpretObject(row('喷淋头 - 闭式 - 边墙型',{typeCategory:'C-A1'}))).toMatchObject({category:'C-A1',conflict:'C-A1!=C-D5',classificationStatus:'candidate'});
 expect(categoryFromName('喷淋头支架')).toBe('C-B1');
});

it('retains readable material details, grain, unknown reasons and stable independent identities',()=>{
 const source=toObjectEvidence({id:'a',track:'dev',source:'a.dev',name:'未知',source_type:'PostInsulator',parent:'',properties:[],sources:['a.dev'],context:[],guid:''});
 expect(interpretObject(source)).toMatchObject({category:'M04',subtype:'post',subtypeLabel:'支柱绝缘子'});
 const model=normalizeEngineeringModel('p',[row('电缆桥架',{sourceId:'tray'}),row('未知物料',{sourceId:'unknown',traits:{materialType:true}})]);
 expect(model.entities.find(e=>e.category==='M08')).toMatchObject({grain:'segment',subtypeLabel:'电缆桥架'});
 expect(model.entities.find(e=>e.category==='M09')).toMatchObject({subtypeLabel:'未细分材料',unknownReason:'material_subtype_evidence_insufficient'});
 expect(interpretObject(row('主变引线套管'))).toMatchObject({category:'M07',unknownReason:'equipment_bushing_host_unresolved'});
 expect(ENGINEERING_CATEGORIES.filter(c=>/^M\d+$/.test(c.code))).toHaveLength(9);
 expect(ENGINEERING_CATEGORIES.filter(c=>/^C-/.test(c.code))).toHaveLength(28);
 expect(new Set(ENGINEERING_CATEGORIES.map(c=>c.code)).size).toBe(ENGINEERING_CATEGORIES.length);
 expect(ENGINEERING_CATEGORY_LABELS['C-B3']).toBe('建筑物基础');
});

it('uses real same-type assembly to keep lamp terminal boards and cabinet bodies internal',()=>{
 const lamp=normalizeEngineeringModel('p',[row('灯具',{sourceId:'lamp',typeCategory:'C-D1'}),row('灯具端子板',{sourceId:'board',typeCategory:'C-D1',assemblyParentId:'lamp'})]);
 expect(lamp.entities).toHaveLength(1);expect(lamp.entities[0].sourceIds).toEqual(['board','lamp']);
 const cabinet=normalizeEngineeringModel('p',[row('测控柜',{sourceId:'cabinet',typeCategory:'E16'}),row('柜体',{sourceId:'body',typeCategory:'E16',assemblyParentId:'cabinet'})]);
 expect(cabinet.entities).toHaveLength(1);expect(cabinet.entities[0].sourceIds).toEqual(['body','cabinet']);
});

it('does not merge four single-phase bodies or repeated phase labels, and retains standalone terminal boxes',()=>{
 const bodies=['A','B','C','D'].map((p,i)=>row('主变压器',{sourceId:`body${i}`,designations:[value('#2主变')],phases:[value('单相')],phaseLabels:[value(p)]}));
 const model=normalizeEngineeringModel('p',bodies);
 expect(model.entities).toHaveLength(0);expect(model.pending).toHaveLength(4);expect(model.diagnostics[0].kind).toBe('whole_identity_conflict');
 expect(normalizeEngineeringModel('p',bodies.slice(0,2).map(b=>({...b,phaseLabels:[value('A')]}))).pending).toHaveLength(2);
 const terminal=normalizeEngineeringModel('p',[row('主变端子箱',{sourceId:'box'})]);
 expect(terminal.entities[0].category).toBe('E16.terminal_box');
});

it('interprets structured purpose as this object usage, rather than the equipment it serves',()=>{
 const source=(source_type:string,name:string,properties:Array<{keys:string[];value:string}>)=>toObjectEvidence({id:'x',track:'dev',source:'x.dev',source_type,name,parent:'',properties,sources:['x.dev'],context:[],guid:''});
 expect(interpretObject(source('SecondaryCabinet','控制柜',[{keys:['设备用途'],value:'主变控制'}]))).toMatchObject({category:'E16.control_cabinet'});
 expect(interpretObject(source('OilFilledTransformer','设备',[{keys:['设备用途'],value:'站用变压器'}]))).toMatchObject({category:'E03',basis:'object_attribute'});
 const ifc=source('IFCPUMP','潜污泵',[]);
 expect(interpretObject(ifc)).toMatchObject({category:'C-D5'});
 const pile=source('IFCPILE','桩身',[]);
 expect(normalizeEngineeringModel('p',[pile]).entities).toHaveLength(0);
 expect(normalizeEngineeringModel('p',[pile]).pending[0].reason).toBe('component_whole_unresolved');
});
