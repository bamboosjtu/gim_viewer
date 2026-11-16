import {expect,it} from 'vitest';
import {interpretObject,categoryFromName} from '../../../engineering/classify.js';
import {toObjectEvidence,type SourceRecord} from '../sourceEvidence.js';
const record=(type:string,name='unknown',props:Record<string,string>={}):SourceRecord=>({id:'x',track:'dev',source:'x.dev',source_type:type,name,parent:'',properties:Object.entries(props).map(([key,value])=>({keys:[key],value,path:'x.fam'})),sources:[],context:[],guid:''});
it.each([['MetalFence','M09'],['DryTypeReactor','E02'],['PowerBox','M05'],['LightingBox','M05'],['MaintenanceBox','M05']])('gives exact standard %s priority over source compatibility in every structured field',(term,category)=>{
 for(const field of ['TYPE','DEVICETYPE','MATERIALTYPE','EQUIPMENTTYPE','SYSCLASSIFYNAME','PARTNAME']){
  const result=interpretObject(toObjectEvidence(record('OTHERS','unknown',{[field]:term})));
  expect(result.category,field).toBe(category);expect(result.categoryStatus).toBe('confirmed');
 }
});
it.each(['TerminalBox','GroundResistance'])('keeps unqualified model/component collision %s unresolved',term=>{
 for(const props of [{},{TYPE:term}] as Record<string,string>[]){
  const result=interpretObject(toObjectEvidence(record(Object.keys(props).length?'OTHERS':term,'unknown',props)));
  expect(result).toMatchObject({category:'U-OBJECT',categoryStatus:'unresolved',basis:'vocabulary_namespace_ambiguous'});
  expect(result.componentType).toBeUndefined();expect(result.equipmentType).toBeUndefined();
 }
});
it.each([['TerminalBox','M04','terminal_box'],['GroundResistance','E09','ground_resistance']])('disambiguates %s with explicit model or component context',(term,category,part)=>{
 const model=interpretObject(toObjectEvidence(record(term,'unknown',{OBJECTROLE:'independent'})));
 expect(model.category).toBe(category);expect(model.componentType).toBeUndefined();
 const component=interpretObject(toObjectEvidence(record(term,'unknown',{OBJECTROLE:'part'})));
 expect(component).toMatchObject({meaning:'part',componentType:{id:part,status:'confirmed'}});expect(component.standardClass).toBeUndefined();expect(component.equipmentType).toBeUndefined();
});
it('retains both original locations for an ambiguous standard declaration',()=>{
 const result=interpretObject(toObjectEvidence(record('OTHERS','unknown',{SYSCLASSIFYNAME:'均压屏蔽装置'})));
 expect(result.categoryStatus).toBe('unresolved');
 const observed=result.vocabularyObservations!.find(row=>row.field==='SYSCLASSIFYNAME')!;
 expect(observed).toMatchObject({status:'ambiguous',verification:'ambiguous'});
 const evidence=JSON.parse(observed.dictionaryEvidence!) as string[];expect(evidence).toHaveLength(2);expect(evidence[0]).not.toBe(evidence[1]);
});
it('keeps property names and free model strings from becoming category facts',()=>{
 const result=interpretObject(toObjectEvidence(record('OTHERS','unknown',{TYPE:'220kV断路器模型01',MODEL:'OilImmersedTransformer_unknown'})));
 expect(result.categoryStatus).toBe('unresolved');
});
it('uses names only after current-object structured evidence and does not change roles from names',()=>{
 expect(interpretObject(toObjectEvidence(record('ACPorcelainCircuitBreaker','油浸式变压器')))).toMatchObject({category:'E06',categoryStatus:'confirmed',meaning:'object'});
 expect(interpretObject(toObjectEvidence(record('OTHERS','油浸式变压器')))).toMatchObject({category:'E01',categoryStatus:'candidate'});
 for(const name of ['散热器','模型文字','土建接口','本体端子箱'])expect(interpretObject(toObjectEvidence(record('OTHERS',name))).meaning).toBe('object');
 expect(categoryFromName('unknown')).toBe('U-OBJECT');
});
it('retains genuinely contradictory declarations and independent purpose',()=>{
 expect(interpretObject(toObjectEvidence(record('GIS','unknown',{EQUIPMENTTYPE:'HGIS'})))).toMatchObject({category:'U-OBJECT',categoryStatus:'unresolved'});
 expect(interpretObject(toObjectEvidence(record('OilImmersedTransformer','unknown',{PURPOSE:'站用'})))).toMatchObject({category:'E01',purpose:{id:'station_service_transformer',status:'confirmed'}});
});

it('gives current-object FAM standard declarations priority over generic source enums',()=>{
 expect(interpretObject(toObjectEvidence(record('CircuitBreaker','油浸式变压器',{EQUIPMENTTYPE:'ACIsolatingSwitch'})))).toMatchObject({category:'E07',categoryStatus:'confirmed'});
});
it.each(['所属设备编码','宿主设备编码','HOSTEQUIPMENTID','HOSTEQUIPMENTCODE','PARENTEQUIPMENTID','所属设备名称','所属设备工程中名称','宿主设备名称','HOSTEQUIPMENTNAME','PARENTEQUIPMENTNAME'])('disambiguates a component from explicit host dialect %s',field=>{
 const result=interpretObject(toObjectEvidence(record('TerminalBox','unknown',{[field]:'host'})));
 expect(result.componentType).toMatchObject({id:'terminal_box',status:'confirmed'});expect(result.standardClass).toBeUndefined();
});
