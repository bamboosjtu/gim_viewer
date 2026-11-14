import {expect,it} from 'vitest';
import {toObjectEvidence,type SourceRecord} from '../../gim/engineering/sourceEvidence.js';
import {interpretObject} from '../classify.js';
import {normalizeEngineeringModel} from '../normalize.js';
import {attributeFromProperty,annotateAttributeConflicts} from '../../gim/engineering/attributeEvidence.js';
import {extractEngineeringSourceGraph} from '../../gim/engineering/sourceGraph.js';
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

it.each(['EQUIPMENTTYPE','MATERIALTYPE'])('uses the sole FAM %s candidate and retains its evidence',key=>{
  const result=interpretObject(toObjectEvidence(record('t','OTHERS',{properties:[{path:'a.fam',line:2,keys:[key],value:'OilImmersedTransformer'}]})));
  expect(result.equipmentType).toMatchObject({id:'oil_immersed_transformer',status:'confirmed'});
  expect(result.equipmentType?.evidence[0]).toContain('a.fam');expect(result.category).toBe('E-T');expect(result.purpose?.status).toBe('unresolved');
  const component=interpretObject(toObjectEvidence(record('c','OTHERS',{properties:[{path:'a.fam',line:3,keys:[key],value:'Body'}]})));
  expect(component.componentType).toMatchObject({id:'body',status:'confirmed'});expect(component.componentType?.evidence[0]).toContain('a.fam');
});

it.each(['SYSCLASSIFYNAME','PARTNAME'])('R09 maps only verified exact %s terms, retains unknown codes and ignores field order',async field=>{
  const lines=[`${field}=GIS`,'OBJECTMODELPOINTER=a.dev'];
  for(const ordered of [lines,[...lines].reverse()]){
    const raw:Record<string,string>={'project.cbm':ordered.join('\n'),'a.dev':'TYPE=OTHERS'};
    const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]});
    const result=interpretObject(toObjectEvidence(graph.records[0]));
    expect(result).toMatchObject({category:'E05',categoryStatus:'confirmed',equipmentType:{id:'gis',status:'confirmed'}});
    expect(result.vocabularyObservations?.[0]).toMatchObject({field,rawValue:'GIS',status:'mapped',dictionaryVersion:'source-keywords-2'});
    expect(result.vocabularyObservations?.[0].dictionaryEvidence).toContain('C17');
    expect(result.classificationEvidence?.some(id=>id.includes('project.cbm'))).toBe(true);
  }
  for(const value of ['0AFD*002','GIS-unknown','&GN']){
    const result=interpretObject(toObjectEvidence(record('x','OTHERS',{properties:[{keys:[field],value,path:'project.cbm',line:1}]})));
    expect(result).toMatchObject({category:'U-OBJECT',categoryStatus:'unresolved',vocabularyObservations:[{field,rawValue:value,status:'unresolved'}]});
    expect(result.equipmentType).toBeUndefined();
  }
  expect(interpretObject(toObjectEvidence(record('x','OTHERS'))).vocabularyObservations).toBeUndefined();
});

it.each([['本体','body','A5'],['散热器','radiator','A13'],['Body','body','B5']])('maps exact PARTNAME=%s with field-level dictionary evidence',(value,id,cell)=>{
  const result=interpretObject(toObjectEvidence(record('x','OTHERS',{properties:[{keys:['PARTNAME'],value,path:'a.cbm',line:1}]})));
  expect(result.componentType).toMatchObject({id,status:'confirmed'});
  expect(result.vocabularyObservations?.[0]).toMatchObject({rawValue:value,status:'mapped',dictionaryVersion:'source-keywords-2'});
  expect(result.vocabularyObservations?.[0].dictionaryEvidence).toContain(cell);
});
it('maps the reviewed Chinese equipment name without guessing unknown code prefixes',()=>{
  const result=interpretObject(toObjectEvidence(record('x','OTHERS',{properties:[{keys:['SYSCLASSIFYNAME'],value:'油浸式变压器',path:'a.cbm'}]})));
  expect(result).toMatchObject({category:'E-T',equipmentType:{id:'oil_immersed_transformer'}});
  for(const value of ['本体一号','散热器-未知','GYAA011-unknown'])expect(interpretObject(toObjectEvidence(record('x','OTHERS',{properties:[{keys:['PARTNAME'],value}]}))).vocabularyObservations?.[0].status).toBe('unresolved');
});

it('compares observed attributes only within the same object, stage, Pset and applicability',()=>{
  const base={path:'a.ifc',sourceId:'a',containerId:'a.ifc#10',rawContainerName:'Pset_Design',applicability:'instance' as const,section:'设计',keys:['额定电压'],value:'1 kV'};
  for(const variation of [{rawContainerName:'Pset_Product'},{applicability:'type' as const},{sourceId:'b'},{section:'产品'},{path:'b.ifc'}]){
    const attributes=annotateAttributeConflicts([attributeFromProperty(base,0),attributeFromProperty({...base,...variation,value:'2 kV'},1)]);
    expect(attributes.every(a=>!a.conflict)).toBe(true);expect(new Set(attributes.map(a=>a.id)).size).toBe(2);
  }
  const conflict=annotateAttributeConflicts([attributeFromProperty(base,0),attributeFromProperty({...base,value:'2 kV'},1)]);
  expect(conflict.every(a=>a.conflict)).toBe(true);
  expect(conflict[0]).toMatchObject({rawContainerName:'Pset_Design',applicability:'instance',containerId:'a.ifc#10',sourceId:'a',rawSection:'设计',evidence:[{path:'a.ifc',sourceId:'a',containerId:'a.ifc#10'}]});
});
