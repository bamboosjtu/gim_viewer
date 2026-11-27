import {it,expect} from 'vitest';
import {engineeringQuery} from '../query.js';
import {normalizeEngineeringModel} from '../../semantic/semantic.js';
import {declaredObject} from '../../../tests/support/evidenceFixtures.js';
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

it('keeps every member reachable when imported direct parents contain a cycle or a self edge',()=>{
 const snapshot=normalizeEngineeringModel('p',[declaredObject('whole','断路器'),member('a','whole'),member('b','a'),member('c','whole')]);
 const owner=snapshot.entities[0].id;
 snapshot.memberships.find(row=>row.sourceId==='a')!.parentPartId='b';
 snapshot.memberships.find(row=>row.sourceId==='c')!.parentPartId='c';
 const tree=engineeringQuery(snapshot).tree(owner);
 expect(tree.cyclicParentSourceIds).toEqual(['a','c']);
 expect(tree.roots).toEqual(['a','c','whole']);
 expect(tree.nodes.get('a')?.children).toEqual(['b']);
});
