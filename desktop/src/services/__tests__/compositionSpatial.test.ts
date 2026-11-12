import {expect,it} from 'vitest';
import {normalizeEngineeringModel} from '../../engineering/normalize.js';
import {type CompositionSpatialDiagnostics,fromIfcYUpBounds,projectSpatialComposition} from '../projections/compositionSpatial.js';
import type {CompositionAssignment} from '../../engineering/composition.js';
import type {ObjectEvidence} from '../../engineering/types.js';

interface CompositionParityMismatch {entityId:string;sourceIds:string[];expectedPaths:string[];actualPaths:string[];}
function compareCompositionAssignments(
  expected: readonly CompositionAssignment[],
  actual: readonly CompositionAssignment[],
  sourceIdsByEntity: ReadonlyMap<string, readonly string[]> = new Map(),
): { missing: string[]; extra: string[]; mismatches: CompositionParityMismatch[] } {
  const key = (rows: readonly CompositionAssignment[]) => new Map(rows.map(row => [row.entityId, row]));
  const left = key(expected), right = key(actual), missing: string[] = [], extra: string[] = [], mismatches: CompositionParityMismatch[] = [];
  for (const [entityId, row] of left) {
    const other = right.get(entityId);
    if (!other) { missing.push(entityId); continue; }
    const paths = (value: CompositionAssignment) => value.paths.map(path => path.map(group => `${group.kind}:${group.key}`).join('/')).sort();
    const expectedPaths = paths(row), actualPaths = paths(other);
    if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) mismatches.push({
      entityId, sourceIds: [...(sourceIdsByEntity.get(entityId) ?? [])], expectedPaths, actualPaths,
    });
  }
  for (const entityId of right.keys()) if (!left.has(entityId)) extra.push(entityId);
  return { missing, extra, mismatches };
}
const object=(sourceId:string,name:string):ObjectEvidence=>({sourceId,name,traits:{},designations:[],identityCodes:[],identityNames:[],phases:[]});
it('uses named storeys in a placeholder building and projects other architectural files into its footprint without merging wholes',()=>{
 const snapshot=normalizeEngineeringModel('p',[object('a','墙'),object('b','板'),object('c','柱'),object('d','梁')]),before=JSON.stringify(snapshot);
 const facts=snapshot.entities.map(e=>({entityId:e.id,hostEntityIds:[],declarations:[],sourceHints:['建筑.ifc'],spaces:[{building:{value:'IFCBUILDING #111',evidenceId:'b'},storeys:[{value:e.sourceIds[0]==='a'?'4.8m标高层（110配电楼）':'0m',evidenceId:'floor'}]}]}));
 const boxes=[[0,0,0,10,1,4],[0,0,3,10,10,3.2],[9,0,0,10,10,4],[2,2,0,3,3,1]];
 const result=projectSpatialComposition(snapshot,facts,snapshot.entities.map((e,i)=>({entityId:e.id,bounds:boxes[i],evidence:'actual-shape'})));
 expect(result.every(a=>a.paths[0].some(g=>g.title==='110千伏配电装置楼'))).toBe(true);
 expect(JSON.stringify(snapshot)).toBe(before);
 expect(result.every(row => !('evidence' in row))).toBe(true);
});
it('converts runtime Y-up bounds to the source Z-up frame exactly once',()=>{
 expect(fromIfcYUpBounds([1,2,3,4,5,6])).toEqual([1,-6,2,4,-3,5]);
 expect(fromIfcYUpBounds([0,0,0,1,1,NaN])).toBeUndefined();
 expect(fromIfcYUpBounds([0,0,0,1,1])).toBeUndefined();
});
it('compares static and runtime projections by entity and reports path mismatches with source IDs',()=>{
 const snapshot=normalizeEngineeringModel('p',[object('a','墙'),object('b','板'),object('c','柱')]);
 const facts=snapshot.entities.map(e=>({entityId:e.id,hostEntityIds:[],declarations:[],sourceHints:['建筑.ifc'],spaces:[]}));
 const sourceBounds=snapshot.entities.map((e,i)=>({entityId:e.id,bounds:i<2?[0,0,0,10,10,4]:[20,0,0,30,10,4],evidence:e.id}));
 const expected=projectSpatialComposition(snapshot,facts,sourceBounds);
 const yUp=sourceBounds.map(row=>({...row,bounds:[row.bounds[0],row.bounds[2],-row.bounds[4],row.bounds[3],row.bounds[5],-row.bounds[1]]}));
 const actual=projectSpatialComposition(snapshot,facts,yUp.flatMap(row=>{const bounds=fromIfcYUpBounds(row.bounds);return bounds?[{...row,bounds}]:[];}));
 expect(compareCompositionAssignments(expected,actual,new Map(snapshot.entities.map(e=>[e.id,e.sourceIds])))).toEqual({missing:[],extra:[],mismatches:[]});
 const changed=actual.map(row=>row.entityId===snapshot.entities[0].id?{...row,paths:[row.paths[0].slice(0,-1)]}:row);
 const diff=compareCompositionAssignments(expected,changed,new Map([[snapshot.entities[0].id,['a']]]));
 expect(diff.mismatches).toHaveLength(1);
 expect(diff.mismatches[0]).toMatchObject({entityId:snapshot.entities[0].id,sourceIds:['a']});
});
it('places a room-only delivery under a containing building footprint',()=>{
 const entities=['w1','w2','w3','room'].map((id,i)=>({id,name:id,category:i===3?'E01':'C-A1',sourceIds:[id],kind:'whole',boundaryEvidence:'x',classificationState:'identified',classificationConflicts:0}));
 const snapshot={scope:'p',rulesVersion:'r',entities,memberships:[],pending:[],aliases:[],relationships:[],diagnostics:[]} as never;
 const facts=entities.map((entity,index)=>({entityId:entity.id,hostEntityIds:[],declarations:[],sourceHints:[index===3?'35kV配电室通风.ifc':'建筑.ifc'],
   spaces:[{building:{value:index===3?'配电室':'配电楼',evidenceId:`b${index}`},storeys:[]}]}));
 const bounds=entities.map((entity,index)=>({entityId:entity.id,bounds:index===3?[2,2,0,3,3,3]:[0,0,0,10,10,4],evidence:entity.id}));
 const result=projectSpatialComposition(snapshot,facts,bounds);
 const room=result.find(row=>row.entityId==='room')!;
 expect(room.paths[0].map(group=>group.title)).toEqual(['建筑工程','配电楼','配电室']);
});

it('keeps a shared footprint ambiguous when explicit building names disagree',()=>{
 const snapshot=normalizeEngineeringModel('p',[object('a','墙'),object('b','板'),object('c','柱')]);
 const facts=snapshot.entities.map((e,i)=>({entityId:e.id,hostEntityIds:[],declarations:[],sourceHints:['建筑.ifc'],spaces:[{building:{value:i===0?'综合楼':'主控楼',evidenceId:'building'},storeys:[]}]}));
 const result=projectSpatialComposition(snapshot,facts,snapshot.entities.map(e=>({entityId:e.id,bounds:[0,0,0,10,10,4],evidence:'shape'})));
 expect(result.map(a=>a.paths[0][1].title)).toEqual(['综合楼','主控楼','主控楼']);
 expect(result.every(a=>!a.inferred)).toBe(true);
});

it('keeps separate buildings separate and rejects invalid or oversized source bounds',()=>{
 const snapshot=normalizeEngineeringModel('p',Array.from({length:6},(_,i)=>object(String(i),'墙'))),before=JSON.stringify(snapshot);
 const facts=snapshot.entities.map(e=>({entityId:e.id,hostEntityIds:[],declarations:[],sourceHints:['建筑.ifc'],spaces:[]}));
 const bounds=snapshot.entities.map((e,i)=>({entityId:e.id,bounds:i<3?[0,0,0,10,10,4]:[20,0,0,30,10,4],evidence:e.id}));
 const assigned=projectSpatialComposition(snapshot,facts,bounds);
 expect(new Set(assigned.map(a=>a.paths[0][1].key)).size).toBe(2);
 expect(assigned.every(a=>a.inferred)).toBe(true);
 for(const box of [[0,0,0,600,10,4],[0,0,0,1,1,1],[0,0,0,NaN,10,4]]){
   expect(projectSpatialComposition(snapshot,facts,bounds.map(b=>({...b,bounds:box}))).every(a=>!a.inferred)).toBe(true);
 }
 expect(JSON.stringify(snapshot)).toBe(before);

});
it('projects an outdoor main-transformer footprint as an area, not an anonymous building',()=>{
 const snapshot=normalizeEngineeringModel('p',[object('a','墙'),object('b','柱'),object('c','梁'),object('m1','主变压器'),object('m2','主变压器')]);
 const facts=snapshot.entities.map(e=>({entityId:e.id,hostEntityIds:[],declarations:[],spaces:[],sourceHints:['建筑.ifc'],positions:e.sourceIds[0]==='m1'?[[3,3,0]]:e.sourceIds[0]==='m2'?[[7,3,0]]:[]}));
 const bounds=snapshot.entities.slice(0,3).map(e=>({entityId:e.id,bounds:[0,0,0,10,10,5],evidence:'shape'}));
 const before=JSON.stringify(snapshot),rows=projectSpatialComposition(snapshot,facts,bounds);
 expect(rows.slice(0,3).every(r=>r.paths[0][1].title==='主变区域'&&r.inferred)).toBe(true);
 expect(JSON.stringify(snapshot)).toBe(before);

});
it('keeps equidistant outdoor structures unassigned and accepts a unique nearby system',()=>{
 const snapshot=normalizeEngineeringModel('p',[object('s','设备支架'),object('a','主变压器'),object('b','断路器')]);
 const facts=snapshot.entities.map(e=>({entityId:e.id,hostEntityIds:[],spaces:[],declarations:e.sourceIds[0]==='b'?[{names:[{value:'110kV系统',evidenceId:'decl'}]}]:[],positions:e.sourceIds[0]==='a'?[[0,0,0]]:e.sourceIds[0]==='b'?[[10,0,0]]:[]}));
 const support=snapshot.entities.find(e=>e.sourceIds[0]==='s')!;
 const bounds=[{entityId:support.id,bounds:[4,-1,0,6,1,3],evidence:'shape'}];
 expect(projectSpatialComposition(snapshot,facts,bounds).find(r=>r.entityId===support.id)!.paths[0][0].title).toBe('未分类');
 bounds[0].bounds=[0,-1,0,1,1,3];
 expect(projectSpatialComposition(snapshot,facts,bounds).find(r=>r.entityId===support.id)!.paths[0].map(g=>g.title)).toEqual(['建筑工程','主变区域','支架']);
});
it('does not bind two physical footprints to the same declared distribution room',()=>{
 const snapshot=normalizeEngineeringModel('p',Array.from({length:6},(_,i)=>object(`wall${i}`,'墙')).concat(Array.from({length:4},(_,i)=>object(`switch${i}`,'开关柜'))));
 const facts=snapshot.entities.map(e=>({entityId:e.id,hostEntityIds:[],spaces:[],sourceHints:['建筑.ifc'],
  declarations:e.sourceIds[0].startsWith('switch')?[{names:[{value:'10kV系统',evidenceId:'system'}]}]:[],
  positions:e.sourceIds[0].startsWith('switch')?[[Number(e.sourceIds[0].slice(-1))<2?5:25,5,0]]:[]}));
 const bounds=snapshot.entities.filter(e=>e.sourceIds[0].startsWith('wall')).map(e=>({entityId:e.id,bounds:Number(e.sourceIds[0].slice(-1))<3?[0,0,0,10,10,4]:[20,0,0,30,10,4],evidence:'shape'}));
 const rows=projectSpatialComposition(snapshot,facts,bounds,undefined,[{path:[{key:'building:配电室01',title:'配电室01',kind:'building'}],sourceContextIds:['room']}]);
 expect(rows.every(r=>r.paths.every(p=>p.every(g=>g.title!=='配电室01')))).toBe(true);
});
it('keeps indoor supports in their containing building even with an area delivery hint',()=>{
 const snapshot=normalizeEngineeringModel('p',[object('a','墙'),object('b','楼板'),object('c','柱'),object('support','设备支架')]);
 const facts=snapshot.entities.map(e=>({entityId:e.id,hostEntityIds:[],declarations:[],spaces:e.sourceIds[0]==='support'?[]:[{building:{value:'220千伏配电楼',evidenceId:'building'},storeys:[]}],sourceHints:['建筑.ifc'],deliveryAreaNames:e.sourceIds[0]==='support'?[{value:'主变区域',evidenceId:'file'}]:[]}));
 const bounds=snapshot.entities.map(e=>({entityId:e.id,bounds:e.sourceIds[0]==='support'?[2,2,0,3,3,2]:[0,0,0,10,10,5],evidence:'shape'}));
 const row=projectSpatialComposition(snapshot,facts,bounds).find(r=>r.entityId===snapshot.entities.find(e=>e.sourceIds[0]==='support')!.id)!;
 expect(row.paths[0].some(g=>g.kind==='building')).toBe(true);expect(row.paths[0].some(g=>g.kind==='area')).toBe(false);
});
it('keeps a named firewall inside its actual building footprint',()=>{
 const snapshot=normalizeEngineeringModel('p',[object('a','墙'),object('b','楼板'),object('c','柱'),object('firewall','防火墙')]);
 const facts=snapshot.entities.map(e=>({entityId:e.id,hostEntityIds:[],declarations:[],spaces:e.sourceIds[0]==='firewall'?[]:[{building:{value:'配电楼',evidenceId:'building'},storeys:[]}],sourceHints:['建筑.ifc'],deliveryAreaNames:e.sourceIds[0]==='firewall'?[{value:'主变区域',evidenceId:'area'}]:[]}));
 const bounds=snapshot.entities.map(e=>({entityId:e.id,bounds:e.sourceIds[0]==='firewall'?[2,2,0,3,3,3]:[0,0,0,10,10,4],evidence:'shape'}));
 const row=projectSpatialComposition(snapshot,facts,bounds).find(r=>r.entityId===snapshot.entities.find(e=>e.sourceIds[0]==='firewall')!.id)!;
 expect(row.paths[0].some(g=>g.title==='配电楼')).toBe(true);
 expect(row.paths[0].some(g=>g.kind==='area')).toBe(false);
});
it('finds two stacked main-transformer fire walls in a mixed file without swallowing foundations or the ladder',()=>{
 const entities=[...Array.from({length:14},(_,i)=>({id:`wall${i}`,name:'基本墙:预制',category:'C-A1',sourceIds:[`wall${i}`],kind:'whole',boundaryEvidence:'x',classificationState:'identified',classificationConflicts:0})),
  {id:'low',name:'基本墙:常规',category:'C-A1',sourceIds:['low'],kind:'whole',boundaryEvidence:'x',classificationState:'identified',classificationConflicts:0},
  {id:'ladder',name:'防火墙钢梯',category:'C-B7',sourceIds:['ladder'],kind:'whole',boundaryEvidence:'x',classificationState:'identified',classificationConflicts:0}];
 const snapshot={scope:'p',rulesVersion:'r',entities,memberships:[],pending:[],aliases:[],relationships:[],diagnostics:[]} as never;
 const facts=entities.map(e=>({entityId:e.id,hostEntityIds:[],spaces:[],declarations:[],sourceHints:['DEV/主变基础及防火墙.ifc'],deliveryAreaNames:[{value:'主变区域',evidenceId:'source'}]}));
 const bounds=entities.map((e,i)=>({entityId:e.id,bounds:i<14?[i<7?24:53,20,(i%7)*0.8,i<7?24.18:53.18,29,(i%7+1)*0.8]:i===14?[25,20,-0.8,25.2,29,0.1]:[23,21,0,24,22,6],evidence:e.id}));
 const diagnostics:CompositionSpatialDiagnostics & {firewallStacks:NonNullable<CompositionSpatialDiagnostics['firewallStacks']>}={footprints:[],firewallStacks:[]};const original=JSON.stringify(snapshot);
 const rows=projectSpatialComposition(snapshot,facts,bounds,diagnostics);
 expect(diagnostics.firewallStacks.map(s=>s.members)).toEqual([7,7]);
 expect(rows.filter(r=>r.paths[0][r.paths[0].length-1]?.title==='防火墙')).toHaveLength(14);
 expect(rows.filter(r=>['low','ladder'].includes(r.entityId)).map(r=>r.paths[0][r.paths[0].length-1]?.title)).toEqual(['构架','构架']);
 expect(JSON.stringify(snapshot)).toBe(original);
});
