import {expect,it} from 'vitest';
import {normalizeEngineeringModel} from '../../engineering/normalize.js';
import {projectSpatialComposition} from '../projections/compositionSpatial.js';
import type {ObjectEvidence} from '../../engineering/types.js';
const object=(sourceId:string,name:string):ObjectEvidence=>({sourceId,name,traits:{},designations:[],identityCodes:[],identityNames:[],phases:[]});
it('uses named storeys in a placeholder building and projects other architectural files into its footprint without merging wholes',()=>{
 const snapshot=normalizeEngineeringModel('p',[object('a','墙'),object('b','板'),object('c','柱'),object('d','梁')]),before=JSON.stringify(snapshot);
 const facts=snapshot.entities.map(e=>({entityId:e.id,hostEntityIds:[],declarations:[],sourceHints:['建筑.ifc'],spaces:[{building:{value:'IFCBUILDING #111',evidenceId:'b'},storeys:[{value:e.sourceIds[0]==='a'?'4.8m标高层（110配电楼）':'0m',evidenceId:'floor'}]}]}));
 const boxes=[[0,0,0,10,1,4],[0,0,3,10,10,3.2],[9,0,0,10,10,4],[2,2,0,3,3,1]];
 const result=projectSpatialComposition(snapshot,facts,snapshot.entities.map((e,i)=>({entityId:e.id,bounds:boxes[i],evidence:'actual-shape'})));
 expect(result.every(a=>a.paths[0].some(g=>g.title==='110千伏配电装置楼'))).toBe(true);
 expect(JSON.stringify(snapshot)).toBe(before);
 expect(result.filter(a=>a.inferred).every(a=>a.evidence.includes('actual-shape')&&a.evidence.includes('composition-spatial-v1'))).toBe(true);
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
