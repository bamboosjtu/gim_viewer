import {expect,it} from 'vitest';
import {normalizeEngineeringModel} from '../normalize.js';
import {projectSpatialComposition} from '../compositionSpatial.js';
import type {ObjectEvidence} from '../types.js';
const object=(sourceId:string,name:string):ObjectEvidence=>({sourceId,name,traits:{},designations:[],identityCodes:[],identityNames:[],phases:[]});
it('uses named storeys in a placeholder building and projects other architectural files into its footprint without merging wholes',()=>{
 const snapshot=normalizeEngineeringModel('p',[object('a','墙'),object('b','板'),object('c','柱'),object('d','梁')]),before=JSON.stringify(snapshot);
 const facts=snapshot.entities.map(e=>({entityId:e.id,hostEntityIds:[],declarations:[],sourceHints:['建筑.ifc'],spaces:[{building:{value:'IFCBUILDING #111',evidenceId:'b'},storeys:[{value:e.sourceIds[0]==='a'?'4.8m标高层（110配电楼）':'0m',evidenceId:'floor'}]}]}));
 const boxes=[[0,0,0,10,1,4],[0,0,3,10,10,3.2],[9,0,0,10,10,4],[2,2,0,3,3,1]];
 const result=projectSpatialComposition(snapshot,facts,snapshot.entities.map((e,i)=>({entityId:e.id,bounds:boxes[i],evidence:'actual-shape'})));
 expect(result.every(a=>a.paths[0].some(g=>g.title==='110千伏配电装置楼'))).toBe(true);
 expect(JSON.stringify(snapshot)).toBe(before);
});
it('keeps a shared footprint ambiguous when explicit building names disagree',()=>{
 const snapshot=normalizeEngineeringModel('p',[object('a','墙'),object('b','板'),object('c','柱')]);
 const facts=snapshot.entities.map((e,i)=>({entityId:e.id,hostEntityIds:[],declarations:[],sourceHints:['建筑.ifc'],spaces:[{building:{value:i===0?'综合楼':'主控楼',evidenceId:'building'},storeys:[]}]}));
 const result=projectSpatialComposition(snapshot,facts,snapshot.entities.map(e=>({entityId:e.id,bounds:[0,0,0,10,10,4],evidence:'shape'})));
 expect(result.map(a=>a.paths[0][1].title)).toEqual(['综合楼','主控楼','主控楼']);
});
