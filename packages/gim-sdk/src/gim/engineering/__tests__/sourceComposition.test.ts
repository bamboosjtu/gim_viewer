// @vitest-environment node
import {it,expect,vi} from 'vitest';
import {extractEngineeringSourceGraph, engineeringSourceRecords} from '../sourceGraph.js';
import {collectSourceComposition} from '../sourceComposition.js';
import {collectSourceGeometryOccurrences} from '../geometryOccurrences.js';
import {collectEngineeringSources} from '../buildSources.js';
import {normalizeEngineeringSources} from '../semanticAdapter.js';

async function read(entries:Record<string,string>) {
  const readText=vi.fn(async(path:string)=>entries[path]);
  const graph=await extractEngineeringSourceGraph({paths:Object.keys(entries),readText});
  return {graph,readText};
}
it('distinguishes recognized family type, empty type and unread family before falling back to cabinet name',async()=>{
  const source = {
    'project.cbm':'OBJECTMODELPOINTER=panel.dev\nBASEFAMILY=panel.fam',
    'panel.dev':'TYPE=SecondaryCabinet\nSYMBOLNAME=公用测控柜',
  };
  for(const [family,id] of [
    ['DevType#设备类型#控制柜','equipment:controlcabinet'],
    ['型号=型号=2260x600x800','equipment:measurementandcontrolcabinet'],
    [null,'equipment:secondarycabinet'],
  ] as const){
    const {graph}=await read(family===null?source:{...source,'panel.fam':family});
    const model=normalizeEngineeringSources('scope',collectEngineeringSources(graph,[],[]));
    expect(model.entities[0]?.standardClass?.id).toBe(id);
    if(id==='equipment:measurementandcontrolcabinet')expect(model.entities[0]?.standardClass?.status).toBe('candidate');
  }
});
it('recognizes a compound neutral set from the two actual DEV assembly members',async()=>{
  const {graph}=await read({
    'project.cbm':'OBJECTMODELPOINTER=neutral.dev',
    'neutral.dev':'TYPE=GroundTransformer/ArcExtinguishingCoil\nOBJECTROLE=independent\nSUBDEVICE0=ground.dev\nSUBDEVICE1=coil.dev',
    'ground.dev':'TYPE=GroundTransformer',
    'coil.dev':'TYPE=ArcExtinguishingCoil',
  });
  const model=normalizeEngineeringSources('scope',collectEngineeringSources(graph,[],[]));
  expect(model.entities).toHaveLength(1);
  expect(model.entities[0]).toMatchObject({category:'E09',standardClass:{id:'equipment:opengroundingequipment/neutralpointequipment'}});
  expect(model.entities[0].sourceIds).toHaveLength(3);
});
it('keeps semantic-only nested parts and their direct parent separate from physical addresses',async()=>{
  const {graph,readText}=await read({'project.cbm':'OBJECTMODELPOINTER=root.dev\nSUBDEVICE0=part.cbm',
    'root.dev':'TYPE=GIS','part.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=part.dev\nSUBDEVICE0=leaf.cbm',
    'part.dev':'TYPE=CircuitBreaker','leaf.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=leaf.dev','leaf.dev':'TYPE=TerminalBox'});
  const records=engineeringSourceRecords(graph),calls=readText.mock.calls.length;
  const links=collectSourceComposition(graph,records);
  const [part,leaf]=graph.attributeRecords!;
  expect(links.get(part.id)?.[0]).toMatchObject({kind:'semantic_composition',parentSourceIds:[graph.records[0].id],status:'confirmed'});
  expect(links.get(leaf.id)?.[0]).toMatchObject({parentSourceIds:[part.id],status:'confirmed'});
  expect(part.devOccurrence).toBeUndefined();expect(part.parent).toBe('');
  expect(collectSourceGeometryOccurrences(graph).occurrences).toHaveLength(1);
  expect(readText.mock.calls).toHaveLength(calls);
});
it('organization edges cannot create semantic hosts for attribute-only references',async()=>{
  const {graph}=await read({'project.cbm':'OBJECTMODELPOINTER=root.dev\nSUBSYSTEM0=part.cbm',
    'root.dev':'TYPE=GIS','part.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=part.dev','part.dev':'TYPE=Radiator'});
  const part=graph.attributeRecords![0];
  expect(part.relations).toEqual([]);
  expect(collectSourceComposition(graph,engineeringSourceRecords(graph)).has(part.id)).toBe(false);
  expect(graph.cbmOccurrences[1].relationKind).toBe('organization');
});
it('preserves occurrence-specific hosts for repeated semantic documents while reading each document once',async()=>{
  const {graph,readText}=await read({'project.cbm':'SUBSYSTEM0=unit.cbm\nSUBSYSTEM1=unit.cbm',
    'unit.cbm':'OBJECTMODELPOINTER=root.dev\nSUBDEVICE0=part.cbm','root.dev':'TYPE=GIS',
    'part.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=part.dev','part.dev':'TYPE=CircuitBreaker'});
  const links=collectSourceComposition(graph,engineeringSourceRecords(graph));
  expect(graph.attributeRecords).toHaveLength(2);
  expect(new Set(graph.attributeRecords!.flatMap(row=>links.get(row.id)![0].parentSourceIds)).size).toBe(2);
  for(const path of new Set(readText.mock.calls.map(([p])=>p)))expect(readText.mock.calls.filter(([p])=>p===path)).toHaveLength(1);
});
it('preserves contradictory semantic and physical parents rather than silently rebinding a physical member',async()=>{
  const {graph}=await read({'project.cbm':'SUBSYSTEM0=a.cbm\nSUBSYSTEM1=b.cbm',
    'a.cbm':'OBJECTMODELPOINTER=a.dev','a.dev':'TYPE=GIS\nSUBDEVICE0=part.dev','part.dev':'TYPE=CircuitBreaker',
    'b.cbm':'OBJECTMODELPOINTER=b.dev\nSUBDEVICE0=part.cbm','b.dev':'TYPE=GIS',
    'part.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=part.dev'});
  const physical=graph.records.find(row=>row.source==='part.dev')!;
  // Deliberately contradictory import DTO: a semantic alias claims a physical
  // occurrence from a different whole. Both original edges remain evidence.
  graph.aliases[0]={...graph.aliases[0],status:'confirmed',candidates:[physical.id]};
  graph.attributeRecords=[];
  const snapshot=normalizeEngineeringSources('scope',collectEngineeringSources(graph,[],[]));
  const member=snapshot.memberships.find(row=>row.sourceId===physical.id)!;
  expect(member.interpretation.conflict).toBe('composition_host_conflict');
  expect(member.disposition).toBe('pending_whole_member');
  expect(physical.parent).toBe(graph.records.find(row=>row.source==='a.dev')!.id);
});
it('keeps a shared equipment type as whole/member roles and ignores F labels when composition evidence is unchanged',async()=>{
  const input={'project.cbm':'SUBSYSTEM0=whole.cbm',
    'whole.cbm':'ENTITYNAME=F4System\nOBJECTMODELPOINTER=whole.dev\nSUBDEVICE0=part.cbm',
    'whole.dev':'TYPE=GIS\nSUBDEVICE0=part.dev','part.dev':'TYPE=GIS',
    'part.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=part.dev'};
  const first=(await read(input)).graph;
  const second=(await read({...input,'whole.cbm':input['whole.cbm'].replace('F4System','F2System'),
    'part.cbm':input['part.cbm'].replace('PARTINDEX','F4System')})).graph;
  const result=normalizeEngineeringSources('scope',collectEngineeringSources(first,[],[]));
  expect(result.entities).toHaveLength(1);
  expect(result.memberships.map(member=>member.interpretation.meaning)).toEqual(['object','part']);
  expect(result.memberships[0].interpretation.category).toBe(result.memberships[1].interpretation.category);
  expect(normalizeEngineeringSources('scope',collectEngineeringSources(second,[],[]))).toEqual(result);
  expect(collectSourceGeometryOccurrences(second)).toEqual(collectSourceGeometryOccurrences(first));
});

it('keeps a direct occurrence when an alias also contributes a competing host',async()=>{
  const {graph}=await read({'project.cbm':'SUBSYSTEM0=whole.cbm\nSUBSYSTEM1=other.cbm',
    'whole.cbm':'OBJECTMODELPOINTER=whole.dev\nSUBDEVICE0=part.cbm',
    'whole.dev':'TYPE=GIS','other.cbm':'OBJECTMODELPOINTER=other.dev','other.dev':'TYPE=GIS',
    'part.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=part.dev','part.dev':'TYPE=CircuitBreaker'});
  const whole=graph.records.find(row=>row.source==='whole.dev')!;
  const other=graph.records.find(row=>row.source==='other.dev')!;
  graph.aliases.push({sourceId:whole.devOccurrence!.cbmOccurrenceId,status:'ambiguous',candidates:[other.id]});
  const part=graph.attributeRecords![0];
  expect(collectSourceComposition(graph,engineeringSourceRecords(graph)).get(part.id)).toContainEqual(
    expect.objectContaining({kind:'semantic_composition',status:'ambiguous',parentSourceIds:[whole.id,other.id]}),
  );
});
