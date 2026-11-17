import {it,expect} from 'vitest';
import {engineeringQuery} from '../query.js';
import {normalizeEngineeringModel} from '../semantic.js';
import {declaredObject} from './evidenceFixtures.js';
const member=(id:string,parent:string,independent=false)=>declaredObject(id,'断路器',{
  composition:[{kind:'semantic_composition',parentSourceIds:[parent],status:'confirmed',evidence:[`edge:${id}`]}],
  ...(independent?{objectRoles:[{value:'independent',evidenceId:`role:${id}`}]}:{}),
});
it('derives a member forest with direct parents without crossing an independent whole boundary',()=>{
 const snapshot=normalizeEngineeringModel('p',[declaredObject('whole','断路器'),member('part','whole'),member('leaf','part'),member('other','whole',true),member('other-part','other')]);
 const query=engineeringQuery(snapshot),whole=query.memberships.get('whole')!.ownerId!,other=query.memberships.get('other')!.ownerId!;
 expect(query.members(whole).map(m=>m.sourceId)).toEqual(['leaf','part','whole']);
 expect(query.tree(whole).roots).toEqual(['whole']);
 expect(query.tree(whole).nodes.get('part')?.children).toEqual(['leaf']);
 expect(query.tree(other).roots).toEqual(['other']);
 expect(query.tree(whole).nodes.has('other')).toBe(false);
 expect(query.tree('missing')).toEqual({roots:[],nodes:new Map()});
 expect(engineeringQuery(snapshot)).toBe(query);expect(query.tree(whole)).toBe(query.tree(whole));
 const next=structuredClone(snapshot);next.evidenceBinding.sourceRevision++;
 expect(engineeringQuery(next)).not.toBe(query);
});
