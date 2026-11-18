import {expect,it} from 'vitest';
import {interpretObject} from '../../../engineering/classify.js';
import {normalizeEngineeringModel} from '../../../engineering/normalize.js';
import {STANDARD_CATALOG} from '../../../engineering/standardCatalog.js';
import {toObjectEvidence,type SourceRecord} from '../../../engineering/recognizeSource.js';
const record=(id:string,type:string,props:Record<string,string>={},parent='',name='unknown'):SourceRecord=>({id,source:id+'.dev',source_type:type,track:'dev',name,parent,sources:[],context:[],guid:'',properties:Object.entries(props).map(([key,value],i)=>({keys:[key],value,path:'a.fam',line:i+1}))});
const build=(rows:SourceRecord[])=>normalizeEngineeringModel('scope',rows.map(toObjectEvidence));
it.each(STANDARD_CATALOG.filter(item=>item.kind==='equipment'))('allows equipment $term to contain a declared component',item=>{
 const result=build([record('host',item.term),record('part','Body',{},'host')]);
 const host=result.memberships.find(m=>m.sourceId==='host')!,part=result.memberships.find(m=>m.sourceId==='part')!;
 expect(part.ownerId).toBe(host.ownerId);expect(part.interpretation.meaning).toBe('part');
});
it.each([['Counter','计数器'],['OnlineMonitor','在线检测仪']])('indexes slash-separated component names like separate rows: %s / %s',(english,chinese)=>{
 for(const word of [english,chinese])expect(interpretObject(toObjectEvidence(record('p',word)))).toMatchObject({componentType:{id:'counter_online_monitor',status:'confirmed'}});
});
it.each(['GIS','OilImmersedTransformer','ACPorcelainCircuitBreaker','PrefabricatedCabin'])('uses actual %s assembly membership to resolve TerminalBox',host=>{
 const result=build([record('host',host),record('box','TerminalBox',{},'host')]);
 expect(result.entities).toHaveLength(1);expect(result.entities[0].sourceIds).toEqual(['box','host']);
 expect(result.memberships[0].interpretation).toMatchObject({meaning:'part',componentType:{id:'terminal_box'},membershipStatus:'confirmed'});
});
it('retains standalone terminal boxes as materials and explicit independence inside equipment',()=>{
 expect(build([record('box','TerminalBox')]).entities[0].category).toBe('M04');
 const result=build([record('host','GIS'),record('box','TerminalBox',{OBJECTROLE:'independent'},'host')]);
 expect(result.entities).toHaveLength(2);expect(result.entities.find(e=>e.sourceIds.includes('box'))?.category).toBe('M04');
});
it('keeps equipment context across wrappers and pending equipment hosts without using names',()=>{
 const pending=build([record('host','NeutralPointEquipment'),record('box','TerminalBox',{},'host')]);
 expect(pending.memberships.find(m=>m.sourceId==='box')?.interpretation.meaning).toBe('part');
 const wrapped=build([record('host','GIS'),record('wrapper','IFCELEMENTASSEMBLY',{},'host'),record('box','OTHERS',{'设备类型':'TerminalBox'},'wrapper')]);
 expect(wrapped.entities).toHaveLength(1);expect(wrapped.entities[0].sourceIds).toEqual(['box','host','wrapper']);
 const unknown=build([record('host','OTHERS',{},'','油浸式变压器'),record('box','TerminalBox',{},'host')]);
 expect(unknown.entities).toHaveLength(2);
});
it('resolves ground resistance by device/material role and actual assembly, preserving raw source facts',()=>{
 expect(build([record('r','GroundResistance')]).entities[0].category).toBe('E09');
 const material=build([record('r','OTHERS',{MATERIALTYPE:'GroundResistance'})]);
 expect(material.entities[0].category).toBe('M06');expect(material.memberships[0].interpretation.classificationEvidence?.[0]).toContain('MATERIALTYPE');
 const rows=[record('host','GIS'),record('r','GroundResistance',{},'host')],result=build(rows);
 expect(result.entities).toHaveLength(1);expect(result.memberships.find(m=>m.sourceId==='r')?.interpretation).toMatchObject({category:'M06',meaning:'part'});
 expect(rows[1].parent).toBe('host');expect(rows[1].source_type).toBe('GroundResistance');
 expect(build([record('r','接地电阻')]).entities[0].category).toBe('E09');
 expect(build([record('r','GroundResistance',{},'','接地电阻')]).entities[0].category).toBe('M06');
 const independentMaterial=build([record('r','GroundResistance',{MATERIALTYPE:'GroundResistance',OBJECTROLE:'independent'})]);
 expect(independentMaterial.entities[0].category).toBe('M06');expect(independentMaterial.memberships[0].interpretation.meaning).toBe('object');
});
it('prefers exact Chinese classification fields and uses Chinese names only to disambiguate an existing type',()=>{
 expect(interpretObject(toObjectEvidence(record('x','GIS',{EQUIPMENTTYPE:'油浸式变压器'})))).toMatchObject({category:'E01',equipmentType:{id:'oil_immersed_transformer'}});
 expect(interpretObject(toObjectEvidence(record('x','ControlCabinet',{},'','汇控柜')))).toMatchObject({meaning:'part',componentType:{id:'control_cabinet'}});
 expect(interpretObject(toObjectEvidence(record('x','ControlCabinet',{},'','控制柜')))).toMatchObject({category:'E17',equipmentType:{id:'control_cabinet'}});
 expect(interpretObject(toObjectEvidence(record('x','GIS',{},'','油浸式变压器')))).toMatchObject({category:'E05',equipmentType:{id:'gis'}});
 expect(interpretObject(toObjectEvidence(record('x','OTHERS',{DEVICENAME:'组合电器 GIS'},'','OilImmersedTransformer')))).toMatchObject({category:'E05',categoryStatus:'candidate'});
 const declared=interpretObject(toObjectEvidence(record('x','OTHERS',{TYPE:'CircuitBreaker'},'','散热器')));
 expect(declared).toMatchObject({category:'E06',categoryStatus:'confirmed'});expect(declared.componentType).toBeUndefined();
 expect(interpretObject(toObjectEvidence(record('x','Counter',{},'','本体端子箱')))).toMatchObject({componentType:{id:'counter_online_monitor',status:'confirmed'},conflict:''});
});
it.each([['ControlCabinet','控制柜'],['ControlPanel','控制屏'],['MeasurementAndControlCabinet','测控柜'],['ProtectionPanel','保护屏'],['ProtectionCabinet','保护柜'],['RelayProtectionCabinet','继电保护柜']])('recognizes the bilingual cabinet term %s / %s', (term,label)=>{
 for(const value of [term,label])expect(interpretObject(toObjectEvidence(record('x','OTHERS',{EQUIPMENTTYPE:value})))).toMatchObject({category:'E17',standardClass:{label}});
});
it('uses the confirmed defaults while retaining their underlying dictionary evidence',()=>{
 const shielding=interpretObject(toObjectEvidence(record('x','OTHERS',{SYSCLASSIFYNAME:'均压屏蔽装置'})));
 expect(shielding).toMatchObject({category:'M03',categoryStatus:'confirmed'});
 expect(JSON.parse(shielding.vocabularyObservations![0].dictionaryEvidence!)).toHaveLength(2);
 expect(interpretObject(toObjectEvidence(record('p','ProtectionEquipment')))).toMatchObject({componentType:{id:'protective_device',status:'confirmed'}});
 expect(interpretObject(toObjectEvidence(record('p','ProtectionEquipment',{},'','线路保护装置')))).toMatchObject({componentType:{id:'line_protection_device'}});
 expect(interpretObject(toObjectEvidence(record('p','ProtectionEquipment',{PARTNAME:'变压器保护装置'})))).toMatchObject({componentType:{id:'transformer_protection_device'}});
});
