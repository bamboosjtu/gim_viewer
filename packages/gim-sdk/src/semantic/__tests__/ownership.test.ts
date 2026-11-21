import {it,expect} from 'vitest';
import {normalizeEngineeringModel} from '../semantic.js';
import {declaredObject} from './evidenceFixtures.js';
import type {ObjectEvidence} from '../types.js';
const child=(id:string,parent:string,extra:Partial<ObjectEvidence>={})=>declaredObject(id,'断路器',{
  composition:[{kind:'semantic_composition',parentSourceIds:[parent],evidence:[`source:${parent}->${id}`],status:'confirmed'}],...extra});
const host=()=>declaredObject('whole','断路器');

it('retains the whole across nested equipment-typed members and keeps direct part parents',()=>{
 const input=[host(),child('device-part','whole'),child('leaf','device-part')];
 const result=normalizeEngineeringModel('scope',input);
 expect(result.entities).toHaveLength(1);
 expect(result.entities[0].sourceIds).toEqual(['device-part','leaf','whole']);
 expect(result.memberships.find(m=>m.sourceId==='leaf')).toMatchObject({parentPartId:'device-part',ownerId:result.entities[0].id});
 expect(result.memberships.find(m=>m.sourceId==='device-part')?.interpretation).toMatchObject({meaning:'part',membershipStatus:'confirmed'});
 expect(normalizeEngineeringModel('scope',[...input].reverse())).toEqual(result);
 expect(input[1].assemblyParentId).toBeUndefined();
});
it('switches to an explicit independent whole and assigns its descendants to that boundary',()=>{
 const result=normalizeEngineeringModel('scope',[host(),child('independent','whole',{objectRoles:[{value:'independent',evidenceId:'role:independent'}]}),child('leaf','independent')]);
 expect(result.entities).toHaveLength(2);
 const separate=result.entities.find(e=>e.sourceIds.includes('independent'))!;
 expect(separate.sourceIds).toEqual(['independent','leaf']);
 expect(result.relationships).toContainEqual(expect.objectContaining({from:separate.id,kind:'associated_with'}));
});
it('does not absorb known equipment below an unknown or declared packaging container',()=>{
 for(const extra of [{},{objectRoles:[{value:'container',evidenceId:'role:container'}]}]) {
  const result=normalizeEngineeringModel('scope',[declaredObject('wrapper','未知包装',extra),child('device','wrapper')]);
  expect(result.entities.some(e=>e.sourceIds.length===1&&e.sourceIds[0]==='device')).toBe(true);
 }
});
it('retains ambiguous semantic parents as pending without choosing the first source',()=>{
 const member=child('part','whole',{composition:[{kind:'semantic_composition',parentSourceIds:['whole','other'],status:'ambiguous',evidence:['source:ambiguous']}]});
 const result=normalizeEngineeringModel('scope',[host(),declaredObject('other','断路器'),member]);
 expect(result.pending).toEqual([expect.objectContaining({reason:'composition_parent_unresolved',sourceIds:['part']})]);
 expect(result.entities).toHaveLength(2);
});
it('does not apply equipment composition inheritance to IFC object decomposition',()=>{
 const result=normalizeEngineeringModel('scope',[host(),child('device','whole',{assemblyParentId:'whole',composition:[{kind:'object_decomposition',parentSourceIds:['whole'],status:'confirmed',evidence:['ifc:aggregate']}]})]);
 expect(result.entities).toHaveLength(2);
});
it('retains conflicting explicit hosts and composition as pending instead of silently moving members',()=>{
 const result=normalizeEngineeringModel('scope',[host(),declaredObject('other','断路器',{identityCodes:[{value:'other-code',evidenceId:'code:other'}]}),
  child('part','whole',{hostCodes:[{value:'other-code',evidenceId:'host:other'}]}),child('leaf','part')]);
 expect(result.pending).toEqual([expect.objectContaining({reason:'composition_host_conflict',sourceIds:['leaf','part']})]);
 expect(result.diagnostics).toContainEqual(expect.objectContaining({kind:'composition_host_conflict',identity:'part'}));
});
it('does not promote an object whose declared composition parent is missing',()=>{
 const result=normalizeEngineeringModel('scope',[child('part','missing')]);
 expect(result.entities).toHaveLength(0);expect(result.pending[0].reason).toBe('composition_parent_missing');
});
it('does not pregroup single-phase device members into a competing transformer whole',()=>{
 const rows=['a','b'].map(id=>child(id,'whole',{typeCategory:'E01',designations:[{value:'1号主变',evidenceId:`name:${id}`}],
   phases:[{value:'单相',evidenceId:`phase:${id}`}]}));
 const result=normalizeEngineeringModel('scope',[host(),...rows]);
 expect(result.entities).toHaveLength(1);expect(result.entities[0].sourceIds).toEqual(['a','b','whole']);
});

it('keeps unresolved composition pending even when a declared host is otherwise unique',()=>{
 const whole=declaredObject('whole','断路器',{identityCodes:[{value:'whole-code',evidenceId:'code'}]});
 const member=declaredObject('part','散热器',{
   hostCodes:[{value:'whole-code',evidenceId:'host-code'}],
   composition:[{kind:'semantic_composition',parentSourceIds:['whole','other'],status:'ambiguous',evidence:['ambiguous-edge']}],
 });
 const snapshot=normalizeEngineeringModel('scope',[whole,member]);
 const result=snapshot.memberships.find(row=>row.sourceId==='part')!;
 expect(snapshot.pending.find(row=>row.id===result.ownerId)?.reason).toBe('composition_parent_unresolved');
 expect(result.interpretation.membershipStatus).toBe('unresolved');
 expect(result.compositionCandidates).toEqual(member.composition);
});

it('preserves uncertain semantic candidates alongside independent physical ownership',()=>{
 const uncertain={kind:'semantic_composition',status:'ambiguous',parentSourceIds:['whole','other'],evidence:['ambiguous-edge']} as const;
 const member=declaredObject('part','断路器',{assemblyParentId:'whole',composition:[
   {kind:'physical_assembly',status:'confirmed',parentSourceIds:['whole'],evidence:['physical-edge']},uncertain,
 ]});
 const snapshot=normalizeEngineeringModel('scope',[host(),member]);
 expect(snapshot.memberships.find(row=>row.sourceId==='part')).toMatchObject({disposition:'whole_member',parentPartId:'whole',compositionCandidates:[uncertain]});
 expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({kind:'composition_parent_unresolved',identity:'part'}));
});

it('preserves an explicit independent boundary through category conflict but keeps conflicting roles pending',()=>{
 const independent=declaredObject('independent','冲突对象',{
  typeCategory:'E06',typeEvidenceId:'type:circuit-breaker',
  propertyCategories:[{value:'E07',evidenceId:'fam:switch'}],
  objectRoles:[{value:'independent',evidenceId:'role:independent'}],
 });
 const ambiguous=declaredObject('ambiguous','角色冲突',{...independent,sourceId:'ambiguous',
  objectRoles:[{value:'independent',evidenceId:'role:independent'},{value:'part',evidenceId:'role:part'}],
 });
 const rows=[host(),independent,ambiguous];
 const snapshot=normalizeEngineeringModel('scope',rows);
 const entity=snapshot.entities.find(row=>row.sourceIds.includes('independent'))!;
 expect(entity).toMatchObject({id:'entity:["scope","independent"]',category:'U-OBJECT',boundaryStatus:'confirmed',classificationStatus:'unresolved'});
 const member=snapshot.memberships.find(row=>row.sourceId==='independent')!;
 expect(member).toMatchObject({ownerId:entity.id,disposition:'whole_member',interpretation:{independent:true,objectRole:{status:'confirmed',evidence:['role:independent']}}});
 expect(member.interpretation.classificationEvidence).toEqual(expect.arrayContaining(['type:circuit-breaker','fam:switch']));
 expect(snapshot.pending).toContainEqual(expect.objectContaining({reason:'object_attributes_conflict',sourceIds:['ambiguous']}));
 expect(snapshot.entities.find(row=>row.sourceIds.includes('whole'))?.category).toBe('E06');
 expect(normalizeEngineeringModel('scope',[...rows].reverse())).toEqual(snapshot);
});
