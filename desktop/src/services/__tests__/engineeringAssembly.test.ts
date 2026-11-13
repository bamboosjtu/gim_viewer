// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {assembleEngineeringView,assembleStoredEngineeringView} from '../engineeringAssembly.js';
import {extractEngineeringSourceGraph} from '../../gim/engineering/sourceGraph.js';
import {collectSourceGeometryOccurrences} from '../../gim/engineering/geometryOccurrences.js';
import * as composition from '../../engineering/composition.js';
import {normalizeEngineeringSources} from '../../gim/engineering/buildSources.js';
import {assertEngineeringPartition} from '../../engineering/validate.js';
import {createEngineeringWorkerHandler} from '../engineeringWorker.js';
import {decodeEngineeringWorkerResult,encodeEngineeringWorkerResult,type TransportGraphCache} from '../engineeringWorkerTransport.js';
afterEach(()=>{vi.restoreAllMocks();});
async function graph(){const files:Record<string,string>={'project.cbm':'OBJECTMODELPOINTER=a.dev','a.dev':'TYPE=GIS'};return extractEngineeringSourceGraph({paths:Object.keys(files),readText:async p=>files[p]});}
it('publishes source tree and physical catalog after recognition fails, including source-cache restoration',async()=>{
  const g=await graph(),fail=()=>{throw Error('recognition failure');};
  const first=assembleEngineeringView('scope',g,[],[],[],fail);
  expect(first.stageErrors.recognition).toContain('recognition failure');expect(first.snapshot.recognitionCoverage?.processed).toBe(0);
  assertEngineeringPartition(first.snapshot,g.records.map(r=>r.id));
  expect(first.navigation.sourceRows.size).toBe(1);expect(first.geometryOccurrences).toEqual(collectSourceGeometryOccurrences(g));
  expect(assembleStoredEngineeringView('scope',first.sources,fail).geometryOccurrences).toEqual(first.geometryOccurrences);
});
it('isolates composition failure without altering semantics, source view or physical placement',async()=>{
  const g=await graph();vi.spyOn(composition,'projectEngineeringComposition').mockImplementationOnce(()=>{throw Error('projection failure');});
  const first=assembleEngineeringView('scope',g,[],[]);
  expect(first.stageErrors.composition).toContain('projection failure');expect(first.snapshot.entities).toHaveLength(1);expect(first.navigation.sourceRows.size).toBe(1);
  const other=assembleEngineeringView('scope',g,[],[],[],(scope,sources)=>{const s=normalizeEngineeringSources(scope,sources);s.entities[0].category='E06';return s;});
  expect(other.geometryOccurrences).toEqual(first.geometryOccurrences);expect(g.records[0].source_type).toBe('GIS');
});
it('revises identification from explicitly recovered family evidence without rebuilding physical occurrences',async()=>{
  const handle=createEngineeringWorkerHandler();await handle({type:'init',scope:'scope',paths:['project.cbm','a.dev','a.fam']});
  await handle({type:'files',files:[{path:'project.cbm',blob:new Blob(['OBJECTMODELPOINTER=a.dev'])},{path:'a.dev',blob:new Blob(['BASEFAMILY=a.fam'])}]});
  const initial=await handle({type:'extract'});expect(initial.type).toBe('graph');
  const partial=await handle({type:'assemble',objects:[],models:[]});if(partial.type!=='model')throw Error('model expected');
  expect((await decodeEngineeringWorkerResult(partial.result,()=>true)).sources.complete).toBe(false);
  await handle({type:'files',files:[{path:'a.fam',blob:new Blob(['[设计]\n设备类型=EQUIPMENTTYPE=CircuitBreaker'])}]});
  await handle({type:'evidence-ensure',range:{entryIds:['a.fam'],kinds:['attributes']}});
  const recovered=await handle({type:'recognize-evidence'});if(recovered.type!=='model')throw Error('model expected');
  const result=await decodeEngineeringWorkerResult(recovered.result,()=>true);
  expect(result.sources.complete).toBe(true);expect(result.snapshot.entities[0].category).toBe('E06');
  if(initial.type==='graph')expect(result.geometryOccurrences.occurrences.map(o=>o.id)).toEqual(initial.geometryOccurrences.occurrences.map(o=>o.id));
});
it('reuses unchanged source facts across model frames and refuses foreign or missing graph references',async()=>{
  const g=await graph(),result=assembleEngineeringView('scope',g,[],[]),sender:TransportGraphCache={},receiver:TransportGraphCache={};
  const full=encodeEngineeringWorkerResult(result,sender);await decodeEngineeringWorkerResult(full,()=>true,receiver);
  const delta=encodeEngineeringWorkerResult(result,sender);
  expect(delta.graphFrame?.reference).toBe(true);expect(delta.body.byteLength).toBeLessThan(full.body.byteLength);
  expect((await decodeEngineeringWorkerResult(delta,()=>true,receiver)).sources.graph).toBe(receiver.graph);
  await expect(decodeEngineeringWorkerResult(delta,()=>true,{})).rejects.toThrow('graph reference unavailable');
  g.revision=(g.revision??0)+1;expect(encodeEngineeringWorkerResult(result,sender).graphFrame?.reference).toBe(false);
});
