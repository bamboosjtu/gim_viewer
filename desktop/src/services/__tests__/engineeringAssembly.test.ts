// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {assembleEngineeringView,assembleStoredEngineeringView} from '../engineeringAssembly.js';
import {extractEngineeringSourceGraph} from '../../gim/engineering/sourceGraph.js';
import {collectSourceGeometryOccurrences} from '../../gim/engineering/geometryOccurrences.js';
import * as composition from '../../engineering/composition.js';
import * as sourceProjection from '../../gim/engineering/sourceProjection.js';
import * as inventory from '../../gim/engineering/inventory.js';
import {assertEngineeringNavigation} from '../engineeringNavigationCache.js';
import {normalizeEngineeringSources} from '../../gim/engineering/buildSources.js';
import {assertEngineeringPartition} from '../../engineering/validate.js';
import {createEngineeringWorkerHandler} from '../engineeringWorker.js';
import {ModelEvidenceProvider} from '../../gim/engineering/evidenceProvider.js';
import {decodeEngineeringWorkerResult,encodeEngineeringWorkerResult,type TransportGraphCache} from '../engineeringWorkerTransport.js';
afterEach(()=>{vi.restoreAllMocks();});
it.each(['composition','source','inventory','inventory-search'] as const)('transfers an explicitly failed %s projection while rejecting it as a complete cache',async failure=>{
  const stage=failure==='inventory-search'?'inventory':failure;
  const g=await graph();
  const fail=()=>{throw Error('projection failure');};
  if(stage==='composition')vi.spyOn(composition,'projectEngineeringComposition').mockImplementationOnce(fail);
  else if(stage==='source')vi.spyOn(sourceProjection,'projectEngineeringSource').mockImplementationOnce(fail);
  else if(failure==='inventory-search')vi.spyOn(inventory,'projectInventorySearch').mockImplementationOnce(fail);
  else vi.spyOn(inventory,'projectEngineeringInventory').mockImplementationOnce(fail);
  const result=assembleEngineeringView('scope',g,[],[]);
  const restored=await decodeEngineeringWorkerResult(encodeEngineeringWorkerResult(result),()=>true);
  expect(restored.stageErrors?.[stage]).toContain('projection failure');
  expect(restored.snapshot.entities).toEqual(result.snapshot.entities);
  expect(restored.geometryOccurrences).toEqual(collectSourceGeometryOccurrences(g));
  expect(()=>assertEngineeringNavigation(restored.navigation,restored.sources,restored.snapshot)).toThrow('partial projection');
  if(stage!=='source')expect(restored.navigation.sourceRows.size).toBe(1);
  if(stage!=='inventory')expect(restored.navigation.inventory?.rowsBySource.size).toBe(1);
  restored.navigation.sourceNodes.get(restored.navigation.sourceRoot)!.children.push('foreign-row');
  await expect(decodeEngineeringWorkerResult(encodeEngineeringWorkerResult(restored),()=>true)).rejects.toThrow('child edge');
});
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
  const failed=await handle({type:'evidence-snapshot',entryIds:['a.fam']});
  expect(failed.type==='evidence'&&failed.snapshot?.coverage[0].status).toBe('failed');
  await handle({type:'files',files:[{path:'a.fam',blob:new Blob(['[设计]\n设备类型=EQUIPMENTTYPE=CircuitBreaker'])}]});
  await handle({type:'evidence-ensure',range:{entryIds:['a.fam'],kinds:['attributes']}});
  const recovered=await handle({type:'recognize-evidence'});if(recovered.type!=='model')throw Error('model expected');
  const result=await decodeEngineeringWorkerResult(recovered.result,()=>true);
  expect(result.sources.complete).toBe(true);expect(result.snapshot.entities[0].category).toBe('E06');
  if(initial.type==='graph')expect(result.geometryOccurrences.occurrences.map(o=>o.id)).toEqual(initial.geometryOccurrences.occurrences.map(o=>o.id));
});
it('keeps evidence indexing off first geometry and parks reconstructible source facts after cache publication',async()=>{
  const attach=vi.spyOn(ModelEvidenceProvider.prototype,'attachGraph'),handle=createEngineeringWorkerHandler();
  const paths=['project.cbm','a.dev','a.fam'],identity={sourceSha256:'a'.repeat(64),parserVersion:'fixture',entries:paths};
  await handle({type:'init',scope:identity.sourceSha256,paths});
  await handle({type:'files',files:[{path:paths[0],blob:new Blob(['OBJECTMODELPOINTER=a.dev'])},{path:paths[1],blob:new Blob(['TYPE=GIS\nBASEFAMILY=a.fam'])},{path:paths[2],blob:new Blob(['[设计]\n额定电压=RATEDVOLTAGE=220 kV'])}]});
  await handle({type:'extract'});const reply=await handle({type:'assemble',objects:[],models:[],identity});if(reply.type!=='model')throw Error('model expected');
  const model=await decodeEngineeringWorkerResult(reply.result,()=>true);expect(attach).not.toHaveBeenCalled();
  await handle({type:'encode-cache',buildId:model.buildId!,domain:'sources'});await handle({type:'release-model',buildId:model.buildId});
  const meta=await handle({type:'evidence-snapshot',entryIds:['a.fam']});if(meta.type!=='evidence'||!meta.snapshot)throw Error('evidence expected');
  expect(meta.snapshot.coverage[0]).toMatchObject({status:'complete',rawAvailable:false,restorable:true});expect(attach).not.toHaveBeenCalled();
  vi.useFakeTimers();
  try{
    const loaded=await handle({type:'evidence-ensure',range:{entryIds:['a.fam'],kinds:['attributes']}});if(loaded.type!=='evidence'||!loaded.snapshot)throw Error('evidence expected');
    const query={range:{entryIds:['a.fam'],kinds:['attributes' as const]},revision:loaded.snapshot.revision,limit:10};
    const page=await handle({type:'evidence-query',query});
    expect(page.type==='evidence'&&page.page?.attributes[0].rawValue).toBe('220 kV');expect(attach).toHaveBeenCalledTimes(1);
    const again=await handle({type:'evidence-ensure',range:query.range});
    expect(again.type==='evidence'&&again.snapshot?.revision).toBe(loaded.snapshot.revision);expect(attach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1501);
    await expect(handle({type:'evidence-query',query})).rejects.toThrow('EVIDENCE_REVISION_EXPIRED');
    const resumed=await handle({type:'evidence-ensure',range:query.range});if(resumed.type!=='evidence'||!resumed.snapshot)throw Error('evidence expected');
    const recovered=await handle({type:'evidence-query',query:{...query,revision:resumed.snapshot.revision}});
    expect(recovered.type==='evidence'&&recovered.page?.attributes).toEqual(page.type==='evidence'&&page.page?.attributes);expect(attach).toHaveBeenCalledTimes(2);
  }finally{vi.useRealTimers();}
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
