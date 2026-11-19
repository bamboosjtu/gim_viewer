import {it,expect,vi} from 'vitest';
import {createEntryIndex} from '../../source/entryResolver.js';
import {SourceDocuments} from '../../source/sourceDocuments.js';
import {extractPhysicalOccurrences} from '../physicalOccurrences.js';
import {extractEngineeringSourceGraph} from '../../source/sourceGraph.js';

it('publishes real placements without semantic records and reuses document reads/parsing',async()=>{
  const raw:Record<string,string>={
    'project.cbm':'SUBSYSTEM0=a.cbm\nSUBSYSTEM1=b.cbm',
    'a.cbm':'OBJECTMODELPOINTER=main.dev\nSUBDEVICE0=part.cbm\nTRANSFORMMATRIX=1,0,0,0,0,1,0,0,0,0,1,0,1000,0,0,1',
    'b.cbm':'OBJECTMODELPOINTER=main.dev\nTRANSFORMMATRIX=1,0,0,0,0,1,0,0,0,0,1,0,5000,0,0,1',
    'part.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=body.dev\nBASEFAMILY=part.fam',
    'main.dev':'SUBDEVICE0=body.dev\nTYPE=Unknown','body.dev':'SOLIDMODEL0=part.phm',
    'part.fam':'TYPE=GIS','part.phm':'SOLIDMODEL0=shape.mod','shape.mod':'<invalid/>',
  };
  const read=vi.fn(async(path:string)=>raw[path]),documents=new SourceDocuments(read),entryIndex=createEntryIndex(Object.keys(raw));
  const physical=await extractPhysicalOccurrences({entryIndex,readDocument:path=>documents.read(path)});
  expect(physical.occurrences.map(o=>[o.devPath,o.placementMatrix[12]])).toEqual([['main.dev',1000],['main.dev',5000]]);
  const ids=physical.occurrences.map(o=>o.id);expect(ids[0]).not.toBe(ids[1]);
  expect(read.mock.calls.some(([path])=>/\.(fam|phm|mod)$/.test(path))).toBe(false);
  const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),entryIndex,readText:read,readDocument:path=>documents.read(path)},{deferFamilies:true});
  expect(graph.records.filter(r=>r.devOccurrence?.rootSourceId===r.id).map(r=>r.id)).toEqual(ids);
  for(const path of new Set(read.mock.calls.map(([path])=>path)))expect(read.mock.calls.filter(([p])=>p===path)).toHaveLength(1);
});
it('keeps unmatched PARTINDEX logical and another real reference to its DEV physical',async()=>{
  const raw:Record<string,string>={'project.cbm':'OBJECTMODELPOINTER=main.dev\nSUBDEVICE0=part.cbm\nSUBDEVICE1=real.cbm','main.dev':'TYPE=GIS','body.dev':'TYPE=Body',
    'part.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=body.dev','real.cbm':'OBJECTMODELPOINTER=body.dev'};
  const documents=new SourceDocuments(async path=>raw[path]);
  const catalog=await extractPhysicalOccurrences({entryIndex:createEntryIndex(Object.keys(raw)),readDocument:path=>documents.read(path)});
  expect(catalog.occurrences.map(o=>o.devPath)).toEqual(['main.dev','body.dev']);
});
