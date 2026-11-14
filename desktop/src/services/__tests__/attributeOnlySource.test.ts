// @vitest-environment node
import {it,expect} from 'vitest';
import {extractEngineeringSourceGraph} from '../../gim/engineering/sourceGraph.js';
import {assembleEngineeringView,assembleStoredEngineeringView} from '../engineeringAssembly.js';
import {collectSourceGeometryOccurrences} from '../../gim/engineering/geometryOccurrences.js';
import {encodeEngineeringSources,decodeEngineeringSources} from '../engineeringCacheCodec.js';
import {ModelEvidenceProvider} from '../../gim/engineering/evidenceProvider.js';
const raw:Record<string,string>={'project.cbm':'OBJECTMODELPOINTER=main.dev\nSUBDEVICE0=part.cbm','main.dev':'TYPE=GIS\nSYMBOLNAME=组合电器','part.cbm':'ENTITYNAME=PARTINDEX\nPARTNAME=本体\nOBJECTMODELPOINTER=body.dev\nBASEFAMILY=body.fam','body.dev':'TYPE=Body','body.fam':'[设计]\n部件名称=PARTNAME=本体'};
it('retains an unmatched attribute component without inventing a physical root, including cache restoration and evidence assignments',async()=>{
  const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>raw[p]}),identity={sourceSha256:'a'.repeat(64),parserVersion:'fixture',entries:Object.keys(raw)};
  const physical=collectSourceGeometryOccurrences(graph);expect(physical.occurrences).toHaveLength(1);expect(graph.records).toHaveLength(1);expect(graph.attributeRecords).toHaveLength(1);
  expect(graph.aliases[0]).toMatchObject({status:'unresolved',candidates:[]});
  const part=graph.attributeRecords![0];expect(part).toMatchObject({attributeOnly:true,name:'本体'});expect(part.devOccurrence).toBeUndefined();
  const built=assembleEngineeringView(identity.sourceSha256,graph,[],[]);
  expect(built.snapshot.entities).toHaveLength(1);expect(built.snapshot.entities[0].sourceIds).toContain(part.id);expect(built.navigation.sourceRows.has(part.id)).toBe(true);
  const encoded=await encodeEngineeringSources(built.sources,identity),restored=await decodeEngineeringSources(encoded.bytes,identity);
  const warm=assembleStoredEngineeringView(identity.sourceSha256,restored.sources);expect(warm.snapshot).toEqual(built.snapshot);expect(warm.geometryOccurrences).toEqual(physical);
  const provider=new ModelEvidenceProvider(identity.sourceSha256,identity.entries,async p=>raw[p]);provider.attachGraph(graph);
  const meta=await provider.ensureEvidence({entryIds:['body.fam'],kinds:['attributes','assignments']});
  const page=provider.queryEvidence({revision:meta.revision,range:{entryIds:['body.fam'],kinds:['assignments']},limit:20});
  expect(page.assignments[0]).toMatchObject({sourceId:part.id,status:'confirmed'});
});
it('isolates a failed attribute header read and still publishes the real physical catalog and known source facts',async()=>{
  const graph=await extractEngineeringSourceGraph({paths:Object.keys(raw),readText:async p=>{if(p==='body.dev')throw Error('attribute read denied');return raw[p];}});
  const result=assembleEngineeringView('scope',graph,[],[]);expect(result.geometryOccurrences.occurrences).toHaveLength(1);
  expect(result.sources.complete).toBe(false);expect(graph.diagnostics).toContainEqual({kind:'read-failed',source:'body.dev'});expect(graph.attributeRecords).toHaveLength(1);
});
