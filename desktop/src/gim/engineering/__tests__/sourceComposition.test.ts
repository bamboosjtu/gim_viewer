// @vitest-environment node
import {it,expect,vi} from 'vitest';
import {extractEngineeringSourceGraph, engineeringSourceRecords} from '../sourceGraph.js';
import {collectSourceComposition} from '../sourceComposition.js';
import {collectSourceGeometryOccurrences} from '../geometryOccurrences.js';

async function read(entries:Record<string,string>) {
  const readText=vi.fn(async(path:string)=>entries[path]);
  const graph=await extractEngineeringSourceGraph({paths:Object.keys(entries),readText});
  return {graph,readText};
}
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
