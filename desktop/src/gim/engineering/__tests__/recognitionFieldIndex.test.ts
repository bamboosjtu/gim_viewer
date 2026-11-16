import {it,expect} from 'vitest';
import {toObjectEvidence,type SourceRecord} from '../sourceEvidence.js';
it.each(['OilImmersedTransformer','TerminalBox','GroundResistance'])('scans raw attributes once even when a contextual variant is built for %s',sourceType=>{
  let reads=0;
  const hostValue=sourceType==='OilImmersedTransformer'?'unit-2':'-';
  const unrelated=Array.from({length:2000},(_,i)=>({get keys(){reads++;return [`UNRELATED_${i}`];},value:'raw'}));
  const properties=[...unrelated,{keys:['PROJECTNAME'],value:'1号主变',path:'a.fam',line:3001},
    {keys:['设备编码'],value:'unit-1'},{keys:['PHASECOUNT'],value:'1'},{keys:['HOSTEQUIPMENTCODE'],value:hostValue}];
  const row:SourceRecord={id:'t',track:'dev',source:'a.dev',name:'变压器',source_type:sourceType,parent:'',sources:['a.dev'],context:[],guid:'',properties};
  const evidence=toObjectEvidence(row);
  expect(reads).toBe(2000);expect(evidence.designations[0].value).toBe('1号主变');expect(evidence.designations[0].evidenceId).toContain('3001');
  expect(evidence.identityCodes[0].value).toBe('unit-1');expect(evidence.phases[0].value).toBe('单相');
  if(hostValue==='unit-2')expect(evidence.hostCodes?.[0].value).toBe('unit-2');else expect(evidence.equipmentMemberVariant).toBeDefined();
  expect(row.properties).toBe(properties);expect(row.properties).toHaveLength(2004);
});
