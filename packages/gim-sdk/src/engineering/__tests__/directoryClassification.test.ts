import {expect,it} from 'vitest';
import {toObjectEvidence,type SourceRecord} from '../recognizeSource.js';
import {interpretObject} from '../classify.js';
import {normalizeEngineeringModel} from '../normalize.js';
import {catalogLocation,MODEL_CATALOG_CATEGORIES} from '../catalogLabels.js';
const record=(id:string,type:string,name=type,parent='',props:Record<string,string>={}):SourceRecord=>({id,track:'dev',source:id+'.dev',source_type:type,name,parent,properties:Object.entries(props).map(([key,value],line)=>({keys:[key],value,line,path:id+'.fam'})),sources:[],context:[],guid:''});
it.each([
  ['OilImmersedTransformer','E01','变压器'],['OilImmersedReactor','E02','电抗器'],['ElectromagneticTa','E03','电流互感器'],['ElectromagneticTv','E04','电压互感器'],
  ['控制柜','E17','二次屏柜'],['ACPillarInsulator','E15','支柱绝缘子'],['DCWallBushing','E16','穿墙套管'],['Lamps','M05','照明及动力'],
])('publishes workbook family %s → %s', (type,category,label)=>{
  const result=interpretObject(toObjectEvidence(record('x',type)));
  expect(result.category).toBe(category);expect(catalogLocation(result).category).toBe(label);
});
it('does not confuse transformer family with purpose or engineering boundary',()=>{
  const result=interpretObject(toObjectEvidence(record('x','OilImmersedTransformer')));
  expect(result).toMatchObject({category:'E01',categoryStatus:'confirmed',purpose:{status:'unresolved'},equipmentType:{id:'oil_immersed_transformer',status:'confirmed'}});
});
it('finds a named lamp inside a generic IFC terminal, in the material directory',()=>{
  const result=interpretObject(toObjectEvidence(record('x','IFCFLOWTERMINAL','三防泛光灯-立杆式古典吊灯-2.2:2264570')));
  expect(result).toMatchObject({category:'M05',categoryStatus:'candidate',standardClass:{id:'material:lamps'}});
});
it('keeps conflicting physical and declared protective-device hosts unresolved',()=>{
  const rows=[record('cab','SecondaryCabinet','线路保护柜','',{HOSTEQUIPMENTID:'unused',GRIDIDENTIFICATIONSYSTEMCODE:'cab-1'}),record('gis','GIS'),record('part','ProtectionDevice','线路保护装置','gis',{HOSTEQUIPMENTCODE:'cab-1'})];
  const model=normalizeEngineeringModel('scope',rows.map(toObjectEvidence));
  const member=model.memberships.find(m=>m.sourceId==='part')!;
  expect(member.interpretation).toMatchObject({meaning:'part',componentType:{id:'devices'},membershipStatus:'unresolved'});
  expect(model.pending.find(p=>p.id===member.ownerId)?.reason).toBe('composition_host_conflict');
  const unresolved=normalizeEngineeringModel('scope',rows.slice(1).map(toObjectEvidence));
  expect(unresolved.entities.some(e=>e.sourceIds.includes('part'))).toBe(false);
});
it('keeps directory and model ordering independent of recognition roles and counts',()=>{
  expect(MODEL_CATALOG_CATEGORIES.filter(c=>c.kind==='equipment').map(c=>c.code)).toEqual(Array.from({length:22},(_,i)=>'E'+String(i+1).padStart(2,'0')));
  expect(MODEL_CATALOG_CATEGORIES.find(c=>c.code==='M05')!.label).toBe('照明及动力');
});
