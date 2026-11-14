// @vitest-environment node
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {EngineeringSnapshot} from '../types.js';
import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {toObjectEvidence,type SourceRecord} from '../../gim/engineering/sourceEvidence.js';
import {normalizeEngineeringModel} from '../normalize.js';
const cases=JSON.parse(readFileSync(new URL('../../../../tools/gim_element/tests/recognition_cases.json',import.meta.url),'utf8')) as Array<{name:string;records:Array<{id:string;type:string;name?:string;parent?:string;props?:Record<string,string>;attributeOnly?:boolean;relations?:SourceRecord['relations']}>;groups:string[][];pending:number;expectedMember?:Record<string,unknown>}>;
it.each(cases)('agrees with the independently implemented tool on $name',fixture=>{
  const rows=fixture.records.map(r=>({attributeOnly:r.attributeOnly,relations:r.relations,id:r.id,name:r.name??r.id,source_type:r.type,parent:r.parent??'',source:r.id+'.dev',track:'dev',sources:[r.id+'.dev'],context:[],guid:'',properties:Object.entries(r.props??{}).map(([key,value],i)=>({keys:[key],value,path:'attributes.fam',line:i+1}))}) as SourceRecord);
  const model=normalizeEngineeringModel('scope',rows.map(toObjectEvidence));
  const python=spawnSync(process.env.PYTHON??'python',[fileURLToPath(new URL('../../../../tools/gim_element/recognition_contract.py',import.meta.url))],{input:JSON.stringify({scope:'scope',records:rows}),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},windowsHide:true});
  if(python.error)throw python.error;
  expect(python.status,python.stderr).toBe(0);
  const fields=(snapshot:EngineeringSnapshot)=>({members:snapshot.memberships.map(m=>({sourceId:m.sourceId,ownerId:m.ownerId??null,category:m.interpretation.category,categoryStatus:m.interpretation.categoryStatus,membershipStatus:m.interpretation.membershipStatus??null,pendingReason:snapshot.pending.find(p=>p.id===m.ownerId)?.reason??null})).sort((a,b)=>a.sourceId.localeCompare(b.sourceId)),diagnostics:snapshot.diagnostics.map(d=>({kind:d.kind,identity:d.identity,name:d.name})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
  expect(fields(JSON.parse(python.stdout) as EngineeringSnapshot)).toEqual(fields(model));
  if(fixture.expectedMember)expect(fields(model).members.find(m=>m.sourceId===fixture.expectedMember!.sourceId)).toMatchObject(fixture.expectedMember);
  expect(model.entities.map(e=>[...e.sourceIds].sort()).sort()).toEqual(fixture.groups.map(g=>[...g].sort()).sort());expect(model.pending).toHaveLength(fixture.pending);
  expect(normalizeEngineeringModel('scope',[...rows].reverse().map(toObjectEvidence))).toEqual(model);
});
