import {expect,it} from 'vitest';
import {toObjectEvidence,type SourceRecord} from '../../gim/engineering/sourceEvidence.js';
import {interpretObject} from '../classify.js';
import {normalizeEngineeringModel} from '../normalize.js';
import {attributeFromProperty} from '../../gim/engineering/attributeEvidence.js';
const record=(id:string,type:string,extra:Partial<SourceRecord>={}):SourceRecord=>({id,track:'dev',source:id+'.dev',source_type:type,name:'unknown',parent:'',properties:[],sources:[],context:[],guid:'',...extra});
it('confirms transformer type while keeping purpose/category and boundary independent',()=>{
  const evidence=toObjectEvidence(record('t','OilImmersedTransformer'));
  expect(interpretObject(evidence)).toMatchObject({category:'E-T',categoryStatus:'candidate',equipmentType:{id:'oil_immersed_transformer',status:'confirmed'},purpose:{status:'unresolved'}});
  expect(normalizeEngineeringModel('scope',[evidence]).entities[0].boundaryStatus).toBe('candidate');
  const station=toObjectEvidence(record('t','OilImmersedTransformer',{properties:[{keys:['PURPOSE'],value:'站用'}]}));
  expect(interpretObject(station)).toMatchObject({category:'E03',purpose:{id:'station_service_transformer',status:'confirmed'}});
});
it('recognizes the standard breaker keyword with unknown name and keeps an explicitly internal breaker in GIS',()=>{
  const host=toObjectEvidence(record('gis','GIS'));
  const child=toObjectEvidence(record('breaker','ACPorcelainCircuitBreaker',{parent:'gis',properties:[{keys:['OBJECTROLE'],value:'内部部件'}]}));
  const snapshot=normalizeEngineeringModel('scope',[child,host]);
  expect(snapshot.entities).toHaveLength(1);
  expect(snapshot.memberships.find(m=>m.sourceId==='breaker')?.interpretation).toMatchObject({category:'E06',meaning:'part',objectRole:{id:'part',status:'confirmed'},equipmentType:{id:'ac_porcelain_circuit_breaker'}});
  expect(interpretObject(toObjectEvidence(record('b','ACPorcelainCircuitBreaker')))).toMatchObject({category:'E06',categoryStatus:'confirmed'});
});
it('does not equate absence of parsed units or unsupported complex values with normalized numbers',()=>{
  const a=attributeFromProperty({keys:['额定电压'],value:'250',path:'a.fam'},0);
  expect(a.rawValue).toBe('250');expect(a.semanticValue).toBeUndefined();
  const b=attributeFromProperty({keys:['额定电压'],value:'10 MVA',path:'a.fam'},1);
  expect(b.semanticValue).toBeUndefined();expect(b.rawUnit).toBe('MVA');
  const c=attributeFromProperty({keys:['未知字段'],value:'(1,2,3)',path:'a.fam'},2);
  expect(c.rawValue).toBe('(1,2,3)');expect(c.semanticValue).toBeUndefined();
});
it('retains category observations from different lifecycle sections without reporting a same-context conflict',()=>{
  const evidence=toObjectEvidence(record('b','CircuitBreaker',{properties:[{keys:['设备类别'],value:'E06',section:'设计'},{keys:['设备类别'],value:'E07',section:'产品'}]}));
  expect(interpretObject(evidence)).toMatchObject({category:'E06',categoryStatus:'candidate',basis:'contextual_category_candidates',conflict:''});
});
it('does not select the first of incompatible specific TYPE declarations sharing a coarse category',()=>{
  const evidence=toObjectEvidence(record('g','GIS',{properties:[{keys:['TYPE'],value:'GIS'},{keys:['TYPE'],value:'HGIS'}]}));
  expect(interpretObject(evidence)).toMatchObject({category:'U-OBJECT',categoryStatus:'unresolved',basis:'attribute_conflict',equipmentType:{status:'unresolved'},conflict:'equipment_type_conflict'});
});
