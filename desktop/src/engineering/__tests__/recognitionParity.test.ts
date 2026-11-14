// @vitest-environment node
import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {toObjectEvidence,type SourceRecord} from '../../gim/engineering/sourceEvidence.js';
import {normalizeEngineeringModel} from '../normalize.js';
const cases=JSON.parse(readFileSync(new URL('../../../../tools/gim_element/tests/recognition_cases.json',import.meta.url),'utf8')) as Array<{name:string;records:Array<{id:string;type:string;name?:string;parent?:string;props?:Record<string,string>}>;groups:string[][];pending:number}>;
it.each(cases)('agrees with the independently implemented tool on $name',fixture=>{
  const rows=fixture.records.map(r=>({id:r.id,name:r.name??r.id,source_type:r.type,parent:r.parent??'',source:r.id+'.dev',track:'dev',sources:[r.id+'.dev'],context:[],guid:'',properties:Object.entries(r.props??{}).map(([key,value],i)=>({keys:[key],value,path:'attributes.fam',line:i+1}))}) as SourceRecord);
  const model=normalizeEngineeringModel('scope',rows.map(toObjectEvidence));
  expect(model.entities.map(e=>[...e.sourceIds].sort()).sort()).toEqual(fixture.groups.map(g=>[...g].sort()).sort());expect(model.pending).toHaveLength(fixture.pending);
  expect(normalizeEngineeringModel('scope',[...rows].reverse().map(toObjectEvidence))).toEqual(model);
});
