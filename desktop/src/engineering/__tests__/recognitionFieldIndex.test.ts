import {it,expect} from 'vitest';
import {toObjectEvidence,type SourceRecord} from '../../gim/engineering/sourceEvidence.js';
it('scans unrelated raw attributes once and preserves object identity, phase, host and evidence addresses',()=>{
  let reads=0;
  const unrelated=Array.from({length:2000},(_,i)=>({get keys(){reads++;return [`UNRELATED_${i}`];},value:'raw'}));
  const properties=[...unrelated,{keys:['PROJECTNAME'],value:'1号主变',path:'a.fam',line:3001},
    {keys:['设备编码'],value:'unit-1'},{keys:['PHASECOUNT'],value:'1'},{keys:['HOSTEQUIPMENTCODE'],value:'unit-2'}];
  const row:SourceRecord={id:'t',track:'dev',source:'a.dev',name:'变压器',source_type:'OilImmersedTransformer',parent:'',sources:['a.dev'],context:[],guid:'',properties};
  const evidence=toObjectEvidence(row);
  expect(reads).toBe(2000);expect(evidence.designations[0].value).toBe('1号主变');expect(evidence.designations[0].evidenceId).toContain('3001');
  expect(evidence.identityCodes[0].value).toBe('unit-1');expect(evidence.phases[0].value).toBe('单相');expect(evidence.hostCodes?.[0].value).toBe('unit-2');
  expect(row.properties).toBe(properties);expect(row.properties).toHaveLength(2004);
});
