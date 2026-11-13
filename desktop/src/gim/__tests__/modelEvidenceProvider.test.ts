// @vitest-environment node
import {expect,it,vi} from 'vitest';
import {ModelEvidenceProvider} from '../engineering/evidenceProvider.js';
import {extractEngineeringSourceGraph,materializeEngineeringFamilies} from '../engineering/sourceGraph.js';
import {collectSourceGeometryOccurrences} from '../engineering/geometryOccurrences.js';

it('enumerates metadata without reading; parses only requested documents and bounds records rather than files',async()=>{
  const raw:Record<string,string>={'a.fam':'[设计]\n额定电压=RATEDVOLTAGE=250 kV\n[产品]\n额定电压=RATEDVOLTAGE=250000 V\n厂家自定义=VENDOR=abc','unused.fam':'bad'};
  const read=vi.fn(async(path:string)=>raw[path]),provider=new ModelEvidenceProvider('sha',Object.keys(raw),read);
  const before=provider.getSnapshot(),range={entryIds:['a.fam'],kinds:['attributes'] as const};
  expect(before.entries).toHaveLength(2);expect(provider.queryEvidence({range,revision:before.revision,limit:1}).attributes).toEqual([]);expect(read).not.toHaveBeenCalled();
  const after=await provider.ensureEvidence(range);await provider.ensureEvidence(range);
  expect(read.mock.calls).toEqual([['a.fam']]);expect(provider.getSnapshot().coverage.find(e=>e.entryId==='unused.fam')?.status).toBe('not_requested');
  expect(after.entryRange).toEqual(['a.fam']);expect(after.entries).toHaveLength(1);expect(after.inventoryTotals?.entries).toBe(2);
  expect(()=>provider.queryEvidence({range,revision:before.revision,limit:1})).toThrow('EVIDENCE_REVISION_EXPIRED');
  const first=provider.queryEvidence({range,revision:after.revision,limit:1});
  expect(first.attributes).toHaveLength(1);expect(first.nextOffset).toBe(1);
  const second=provider.queryEvidence({range,revision:after.revision,offset:first.nextOffset,limit:1});
  expect(second.attributes[0].id).not.toBe(first.attributes[0].id);
  expect(first.attributes[0]).toMatchObject({rawValue:'250 kV',rawUnit:'kV',rawSection:'设计',semanticValue:{value:{value:250000},unit:{quantityKind:'voltage'}}});
  expect(second.attributes[0]).toMatchObject({rawSection:'产品',semanticValue:{value:{value:250000}}});
  expect(before.entries.every(e=>e.status==='not_requested')).toBe(true);
});

it('publishes physical sources before any family read and reuses source records across property queries',async()=>{
  const raw:Record<string,string>={'project.cbm':'OBJECTMODELPOINTER=root.dev','root.dev':'TYPE=GIS\nBASEFAMILY=a.fam','a.fam':'[设计]\n设备名称=DEVICENAME=组合电器','unused.fam':'ignored'};
  const read=vi.fn(async(path:string)=>raw[path]);
  const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:read},{deferFamilies:true});
  expect(read.mock.calls.map(c=>c[0])).toEqual(['project.cbm','root.dev']);
  const geometry=collectSourceGeometryOccurrences(graph);
  const provider=new ModelEvidenceProvider('test',Object.keys(raw),read);provider.attachGraph(graph);
  await materializeEngineeringFamilies(graph,path=>provider.readText(path));provider.attachGraph(graph);
  const range={entryIds:['a.fam'],kinds:['attributes','assignments'] as const};
  const metadata=provider.getSnapshot();expect(provider.queryEvidence({range,revision:metadata.revision,limit:20}).attributes).toEqual([]);
  expect(metadata.coverage.find(e=>e.entryId==='a.fam')).toMatchObject({status:'complete',materialization:'not_materialized'});
  const snapshot=await provider.ensureEvidence(range);
  const page=provider.queryEvidence({range,revision:snapshot.revision,limit:20});
  expect(page.assignments[0]).toMatchObject({sourceId:graph.records[0].id,status:'confirmed'});
  await provider.ensureEvidence(range);expect(read.mock.calls.filter(c=>c[0]==='a.fam')).toHaveLength(1);
  const physical=(catalog:typeof geometry)=>catalog.occurrences.map(o=>({id:o.id,sourceId:o.sourceId,devPath:o.devPath,placement:o.placementMatrix}));
  expect(physical(collectSourceGeometryOccurrences(graph))).toEqual(physical(geometry));
});

it('keeps missing, ambiguous and dual-use PARTINDEX relationships without creating additional roots',async()=>{
  const raw:Record<string,string>={'project.cbm':'OBJECTMODELPOINTER=root.dev\nSUBDEVICE0=part.cbm\nSUBDEVICE1=orphan.cbm\nSUBSYSTEM0=physical.cbm',
    'root.dev':'TYPE=GIS\nSUBDEVICE0=part.dev\nSUBDEVICE1=part.dev','part.dev':'TYPE=Radiator','part.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=part.dev',
    'orphan.cbm':'ENTITYNAME=PARTINDEX\nOBJECTMODELPOINTER=orphan.dev','orphan.dev':'TYPE=Body','physical.cbm':'OBJECTMODELPOINTER=orphan.dev'};
  const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]});
  expect(graph.aliases.map(a=>a.status)).toEqual(['ambiguous','unresolved']);
  expect(graph.aliases[0].candidates).toHaveLength(2);
  expect(collectSourceGeometryOccurrences(graph).occurrences.map(o=>o.devPath)).toEqual(['root.dev','orphan.dev']);
  expect(graph.records.filter(r=>r.source==='orphan.dev')).toHaveLength(1);
});

it('isolates a broken child while preserving other physical branches',async()=>{
  const raw:Record<string,string>={'project.cbm':'SUBSYSTEM0=bad.cbm\nSUBSYSTEM1=ok.cbm','ok.cbm':'OBJECTMODELPOINTER=ok.dev','ok.dev':'TYPE=GIS'};
  const graph=await extractEngineeringSourceGraph({paths:[...Object.keys(raw),'bad.cbm'],readText:async p=>{if(p==='bad.cbm')throw Error('read failure');return raw[p];}});
  expect(graph.diagnostics).toContainEqual({kind:'read-failed',source:'bad.cbm'});expect(collectSourceGeometryOccurrences(graph).occurrences).toHaveLength(1);
});
it('marks comparable same-context value conflicts and rejects pre-reset cursors',async()=>{
  const provider=new ModelEvidenceProvider('sha',['a.fam'],async()=>'[设计]\n额定电压=RATEDVOLTAGE=220 kV\n额定电压=RATEDVOLTAGE=110 kV');
  const range={entryIds:['a.fam'],kinds:['attributes'] as const},snapshot=await provider.ensureEvidence(range);
  const page=provider.queryEvidence({range,revision:snapshot.revision,limit:10});
  expect(page.attributes).toHaveLength(2);expect(page.attributes.every(a=>a.conflict?.reason==='incompatible_observations')).toBe(true);
  provider.resetObservations();expect(()=>provider.queryEvidence({range,revision:snapshot.revision,limit:10})).toThrow('EVIDENCE_REVISION_EXPIRED');
});
