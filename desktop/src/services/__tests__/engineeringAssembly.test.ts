import {normalizeEngineeringSources} from '@gim/gim-sdk/source-adapter';
// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {assembleEngineeringView,assembleStoredEngineeringView} from '../engineeringAssembly.js';
import {extractEngineeringSourceGraph} from '@gim/gim-sdk/source';
import {failNextProjection} from '../../../../packages/gim-sdk/src/projection/__tests__/projectionFailures.js';
import {assertEngineeringNavigation} from '../engineeringNavigationCache.js';

import {assertEngineeringPartition} from '@gim/gim-sdk/semantic';
import {createEngineeringWorkerHandler} from '../engineeringWorkerHandler.js';
import {ModelEvidenceProvider} from '@gim/gim-sdk/source';
import {decodeEngineeringWorkerResult,encodeEngineeringWorkerResultAsync,type TransportGraphCache} from '../../infrastructure/workers/engineeringWorkerTransport.js';
import type { IfcSpatialObject } from '../../gim/ifcSpatialParser.js';
afterEach(()=>{vi.restoreAllMocks();});
it.each(['composition','source','inventory','inventory-search'] as const)('transfers an explicitly failed %s projection while rejecting it as a complete cache',async failure=>{
  const stage=failure;
  const g=await graph();
  failNextProjection(stage);
  const result=assembleEngineeringView('scope',g,[],[]);
  const restored=await decodeEngineeringWorkerResult(await encodeEngineeringWorkerResultAsync(result),()=>true);
  expect(restored.stageErrors?.[stage]).toContain('projection failure');
  expect(restored.snapshot.entities).toEqual(result.snapshot.entities);
  expect('geometryOccurrences' in restored).toBe(false);
  expect(()=>assertEngineeringNavigation(restored.navigation,restored.sources,restored.snapshot)).toThrow('partial projection');
  if(stage!=='source')expect(restored.navigation.sourceRows.size).toBe(1);
  if(failure!=='inventory')expect(restored.navigation.inventory?.rowsBySource.size).toBe(1);
  if(failure==='inventory-search')expect(restored.navigation.inventorySearch).toEqual([]);
  restored.navigation.sourceNodes.get(restored.navigation.sourceRoot)!.children.push('foreign-row');
  await expect(decodeEngineeringWorkerResult(await encodeEngineeringWorkerResultAsync(restored),()=>true)).rejects.toThrow('child edge');
});
async function graph(){const files:Record<string,string>={'project.cbm':'OBJECTMODELPOINTER=a.dev','a.dev':'TYPE=GIS'};return extractEngineeringSourceGraph({paths:Object.keys(files),readText:async p=>files[p]});}
it('publishes the merged capacitor group through the Viewer assembly and inventory',async()=>{
  const files:Record<string,string>={
    'project.cbm':'OBJECTMODELPOINTER=unit.dev\nBASEFAMILY=unit.fam',
    'unit.dev':'TYPE=AssembledCapacitorBank;SeriesCapacitorSet\nSYMBOLNAME=35kV装置',
    'unit.fam':'[设计参数]\n设备类型=设备类型=并联电容器组',
  };
  const source=await extractEngineeringSourceGraph({paths:Object.keys(files),readText:async path=>files[path]});
  const {snapshot,navigation}=assembleEngineeringView('scope',source,[],[]);
  expect(snapshot.entities).toHaveLength(1);
  expect(snapshot.entities[0]).toMatchObject({category:'E10',standardClass:{id:'equipment:framecapacitor',label:'电容器组'}});
  expect([...navigation.inventory!.nodes.values()].some(node=>node.title==='电容器组'&&node.entityCount===1)).toBe(true);
});
it('publishes IFC equipment and material separately even when display names suggest different classes',async()=>{
  const path='delivery/model.ifc',modelId='logical-model';
  const make=(expressId:number,name:string,objectType:string):IfcSpatialObject=>({
    key:`${modelId}#${expressId}`,modelId,expressId,ifcType:'IFCBUILDINGELEMENTPROXY',
    name,objectType,globalId:'',geometryStatus:'unrepresented',parentObjectKey:null,
    childObjectKeys:[],relationshipCount:0,hostObjectKey:null,spatialKey:null,spatialKeys:[],
    spatialContainment:null,sourcePath:path,
  });
  const source=await extractEngineeringSourceGraph({paths:['project.cbm',path],readText:async()=>''});
  const {snapshot,navigation}=assembleEngineeringView('scope',source,[
    make(1,'灯具','ProtectionCabinet'),make(2,'主变压器','PowerBox'),
  ],[]);
  expect(snapshot.entities.map(entity=>entity.category).sort()).toEqual(['E17','M05']);
  const inventory=navigation.inventory!;
  expect(inventory.nodes.get('inventory:root/设备')?.entityCount).toBe(1);
  expect(inventory.nodes.get('inventory:root/材料')?.entityCount).toBe(1);
});
it('publishes the independent source tree after recognition fails, including source-cache restoration',async()=>{
  const g=await graph(),fail=()=>{throw Error('recognition failure');};
  const first=assembleEngineeringView('scope',g,[],[],[],fail);
  expect(first.stageErrors.recognition).toContain('recognition failure');expect(first.snapshot.recognitionCoverage?.processed).toBe(0);
  assertEngineeringPartition(first.snapshot,g.records.map(r=>r.id));
  expect(first.navigation.sourceRows.size).toBe(1);
  expect(assembleStoredEngineeringView('scope',first.sources,fail).navigation.sourceRows.size).toBe(1);
});
it('isolates composition failure without altering semantics, source view or physical placement',async()=>{
  const g=await graph();failNextProjection('composition');
  const first=assembleEngineeringView('scope',g,[],[]);
  expect(first.stageErrors.composition).toContain('projection failure');expect(first.snapshot.entities).toHaveLength(1);expect(first.navigation.sourceRows.size).toBe(1);
  const other=assembleEngineeringView('scope',g,[],[],[],(scope,sources)=>{const s=normalizeEngineeringSources(scope,sources);s.entities[0].category='E06';return s;});
  expect('geometryOccurrences' in other).toBe(false);expect(g.records[0].source_type).toBe('GIS');
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
  expect('geometryOccurrences' in result).toBe(false);
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
  const full=await encodeEngineeringWorkerResultAsync(result,sender);await decodeEngineeringWorkerResult(full,()=>true,receiver);
  const delta=await encodeEngineeringWorkerResultAsync(result,sender);
  expect(delta.graphFrame?.reference).toBe(true);expect(delta.body.byteLength).toBeLessThan(full.body.byteLength);
  expect((await decodeEngineeringWorkerResult(delta,()=>true,receiver)).sources.graph).toBe(receiver.graph);
  await expect(decodeEngineeringWorkerResult(delta,()=>true,{})).rejects.toThrow('graph reference unavailable');
  g.revision=(g.revision??0)+1;expect((await encodeEngineeringWorkerResultAsync(result,sender)).graphFrame?.reference).toBe(false);
});

it('publishes unaffected equipment and the known boundary of an independently declared object with disputed type',async()=>{
  const files:Record<string,string>={
    'project.cbm':'SUBSYSTEM0=good.cbm\nSUBSYSTEM1=bad.cbm',
    'good.cbm':'OBJECTMODELPOINTER=good.dev',
    'bad.cbm':'OBJECTMODELPOINTER=bad.dev',
    'good.dev':'TYPE=CircuitBreaker',
    'bad.dev':'TYPE=GIS\nEQUIPMENTTYPE=HGIS\nOBJECTROLE=independent',
  };
  const source=await extractEngineeringSourceGraph({paths:Object.keys(files),readText:async path=>files[path]});
  const {snapshot,stageErrors}=assembleEngineeringView('scope',source,[],[]);
  const normal=source.records.find(row=>row.source==='good.dev')!,disputed=source.records.find(row=>row.source==='bad.dev')!;
  expect(stageErrors.recognition).toBeUndefined();
  expect(snapshot.entities.find(row=>row.sourceIds.includes(normal.id))).toMatchObject({category:'E06'});
  expect(snapshot.entities.find(row=>row.sourceIds.includes(disputed.id))).toMatchObject({category:'U-OBJECT',boundaryStatus:'confirmed',classificationStatus:'unresolved'});
  expect(snapshot.memberships.find(row=>row.sourceId===disputed.id)?.interpretation).toMatchObject({independent:true,conflict:'equipment_type_conflict'});
});
