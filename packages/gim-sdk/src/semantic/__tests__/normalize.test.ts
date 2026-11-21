import {expect,it} from 'vitest';
import {normalizeEngineeringModel} from '../normalize.js';
import {assertEngineeringPartition} from '../validate.js';
import {toObjectEvidence,type SourceRecord} from '../../adapters/recognizeSource.js';
const source=(id:string,type:string,extra:Partial<SourceRecord>={}):SourceRecord=>({id,track:'dev',source:id+'.dev',source_type:type,name:id,parent:'',properties:[],sources:[],context:[],guid:'',...extra});
const props=(values:Record<string,string>)=>Object.entries(values).map(([key,value])=>({keys:[key],value,path:'a.fam'}));
const build=(rows:SourceRecord[])=>normalizeEngineeringModel('scope',rows.map(toObjectEvidence));
it('attaches a configured exact component by a real assembly edge and preserves each proof',()=>{
 const result=build([source('host','OilImmersedTransformer'),source('part','Radiator',{parent:'host'})]);
 expect(result.entities).toHaveLength(1);expect(result.entities[0].sourceIds).toEqual(['host','part']);
 expect(result.memberships[1].interpretation).toMatchObject({meaning:'part',membershipStatus:'confirmed'});
 expect(result.memberships[1].interpretation.membershipEvidence).toEqual(expect.arrayContaining(['assembly:host->part','policy:composition-policy-v1:radiator']));
});
it.each([['GIS','Radiator'],['OilImmersedTransformer','Ladder']])('allows every equipment kind to host typed components: %s / %s',(host,part)=>{
 const result=build([source('host',host),source('part',part,{parent:'host'})]);expect(result.entities[0].sourceIds).toEqual(['host','part']);expect(result.pending).toHaveLength(0);
});
it('rejects material hosts and keeps unknown host kinds unresolved',()=>{
 for(const host of ['GroundingMaterial','OTHERS']){const result=build([source('host',host),source('part','Radiator',{parent:'host'})]);expect(result.pending).toHaveLength(1);}
});
it('never infers ownership from an accessory name without a real assembly',()=>{
 const result=build([source('host','OilImmersedTransformer'),source('part','OTHERS',{name:'1号主变_散热器'})]);
 expect(result.entities).toHaveLength(2);expect(result.memberships[1].interpretation.componentType?.status).toBe('candidate');
});
it('retains unclassified real assembly members as candidate parts without using their names',()=>{
 const result=build([source('host','OilImmersedTransformer'),source('part','OTHERS',{name:'未知对象',parent:'host'})]);
 expect(result.entities).toHaveLength(1);
 expect(result.memberships[1].interpretation).toMatchObject({meaning:'part',membershipStatus:'candidate',basis:'unclassified_equipment_assembly_member'});
 expect(result.memberships[1].interpretation.componentType).toBeUndefined();
 expect(result.memberships[1].interpretation.membershipEvidence).toContain('assembly:host->part');
});
it.each<Record<string,string>>([{TYPE:'CircuitBreaker'},{GRIDIDENTIFICATIONSYSTEMCODE:'own-code'},{PROJECTNAME:'own-designation'}])('retains type/code/designation on composition members without splitting the whole: %j',values=>{
 const snapshot=build([source('host','GIS'),source('child','OTHERS',{parent:'host',properties:props(values)})]);
 expect(snapshot.entities).toHaveLength(1);expect(snapshot.memberships.find(m=>m.sourceId==='child')?.interpretation.meaning).toBe('part');
});
it('keeps explicit independent boxes separate even in a compatible assembly',()=>{
 const result=build([source('host','GIS'),source('box','TerminalBox',{parent:'host',properties:props({OBJECTROLE:'independent'})})]);
 expect(result.entities).toHaveLength(2);expect(result.entities.find(e=>e.sourceIds.includes('box'))?.category).toBe('M04');
});
it('uses a real equipment assembly to resolve a terminal box',()=>{
 expect(build([source('host','GIS'),source('box','TerminalBox',{parent:'host'})]).entities).toHaveLength(1);
 expect(build([source('host','GIS'),source('box','TerminalBox',{parent:'host',properties:props({OBJECTROLE:'part'})})]).entities).toHaveLength(1);
});
it('never groups peers by a name prefix, shared template or engineering code alone',()=>{
 const rows=['a','b'].map(id=>source(id,'OTHERS',{name:'电容器组模型01_柜体',properties:props({PROJECTNAME:'1号电容器组',GRIDIDENTIFICATIONSYSTEMCODE:'same'})}));
 expect(build(rows).entities).toHaveLength(2);expect(build(rows)).toEqual(build([...rows].reverse()));
});
it('preserves explicit single-phase main grouping with conflicting phases rejected',()=>{
 const rows=['A','B','C'].map((phase,i)=>source(String(i),'OilImmersedTransformer',{properties:props({PROJECTNAME:'2号主变',PHASECOUNT:'1',PHASE:phase})}));
 expect(build(rows).entities[0]).toMatchObject({kind:'transformer_bank',phaseBodyCount:3,sourceIds:['0','1','2']});
 rows[1].properties=props({PROJECTNAME:'2号主变',PHASECOUNT:'1',PHASE:'A'});expect(build(rows).pending).toHaveLength(3);
});
it('preserves source-only IFC features without changing other object coverage',()=>{
 const result=build([source('wall','Wall'),source('port','IFCDISTRIBUTIONPORT',{parent:'wall',track:'ifc'}),source('orphan','IFCANNOTATION',{track:'ifc'})]);
 expect(result.memberships).toHaveLength(3);expect(result.entities).toHaveLength(1);expect(result.memberships.find(m=>m.sourceId==='orphan')?.disposition).toBe('source_only');
});
it('retains stable occurrence identity across classification changes',()=>expect(build([source('x','GIS')]).entities[0].id).toBe(build([source('x','OTHERS')]).entities[0].id));
it('rejects duplicate source identities, assembly cycles and broken partitions',()=>{
 expect(()=>build([source('x','GIS'),source('x','GIS')])).toThrow('unique');
 expect(()=>build([source('x','GIS',{parent:'y'}),source('y','GIS',{parent:'x'})])).toThrow('cycle');
 const result=build([source('x','GIS')]);result.memberships.pop();expect(()=>assertEngineeringPartition(result,['x'])).toThrow('incomplete');
});
