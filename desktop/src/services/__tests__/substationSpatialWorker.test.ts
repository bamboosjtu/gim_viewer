import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SubstationSpatialIndexBuilder, buildSubstationSpatialIndexFromFiles,
  type SubstationSpatialIndexObserver } from '../../gim/ifcSpatialParser.js';
import type { CbmNode } from '../../gim/types.js';
import { buildSubstationSpatialIndexInWorker, cancelSubstationSpatialWorkers } from '../substationSpatialWorkerClient.js';
import type { SpatialWorkerRequest, SpatialWorkerResponse } from '../substationSpatialWorker.js';
import { AppState } from '../../app/state.js';
import { webcrypto } from 'node:crypto';
import { isTauri } from '@desktop/runtime.js';
import { readCachedEntry } from '@desktop/database.js';
import { encodeBusinessTree } from '../businessTreeCache.js';
import { buildSubstationSpatialIndexFromTexts } from '../../gim/ifcSpatialParser.js';
import { buildBusinessTree, type BusinessTreeProjection } from '../../gim/businessTree.js';
import { getBusinessTree, restoreBusinessTree, prefetchBusinessTree, type BusinessBuildInput } from '../businessTreeService.js';
import { collectBusinessGeometry } from '../businessGeometryEvidence.js';
vi.mock('@desktop/runtime.js',()=>({isTauri:vi.fn(()=>false)}));
vi.mock('@desktop/database.js',()=>({readCachedEntry:vi.fn(),writeCacheFile:vi.fn()}));

class SpatialWorker {
  static instances:SpatialWorker[]=[];
  static hold=false;
  builder!:SubstationSpatialIndexBuilder;
  onmessage:((event:MessageEvent<SpatialWorkerResponse>)=>void)|null=null;
  onerror:null=null;onmessageerror:null=null;
  terminate=vi.fn(); requests:SpatialWorkerRequest[]=[];
  constructor(){SpatialWorker.instances.push(this);}
  postMessage(input:SpatialWorkerRequest,transfer:Transferable[]=[]){
    const blob=input.type==='model'?input.blob:undefined;
    const request=structuredClone(input.type==='model'?{...input,blob:undefined}:input,{transfer}) as SpatialWorkerRequest;
    if(request.type==='model' && blob)request.blob=blob;
    this.requests.push(request);
    if(SpatialWorker.hold)return;
    queueMicrotask(async ()=>{
      const send=(data:SpatialWorkerResponse)=>this.onmessage?.({data} as MessageEvent<SpatialWorkerResponse>);
      if(request.type==='init'){
        const observer:SubstationSpatialIndexObserver={onModelParsed:profile=>send({type:'diagnostic',event:'onModelParsed',profile})};
        this.builder=new SubstationSpatialIndexBuilder(request.tree,request.relations,observer);
      } else if(request.type==='model'){
        send({type:'diagnostic',event:'onModelRead',profile:request.read});
        const bytes=request.blob ? await request.blob.arrayBuffer() : request.bytes;
        this.builder.addIfcModel(request.entry,request.text??(bytes?new TextDecoder().decode(bytes):null),request.read.bytes);
      } else {send({type:'complete',index:structuredClone(this.builder.finalize())});return;}
      send({type:'ready'});
    });
  }
}
const entry={modelId:'model',name:'model',path:'CBM/model.ifc'};
const text="#1=IFCPROJECT('p',#99,'Project',$,$,$,$,(#90),$);\n#2=IFCBUILDINGSTOREY('s',#99,'Floor',$,$,$,$,$,.ELEMENT.,0.);\n#10=IFCWALL('wall',#99,'Wall',$,$,$,$,$,$);\n#20=IFCRELAGGREGATES('r1',#99,$,$,#1,(#2));\n#21=IFCRELCONTAINEDINSPATIALSTRUCTURE('r2',#99,$,$,(#10),#2);";
const tree:CbmNode={path:'CBM/wall.cbm',name:'Wall',entityName:'F4System',children:[],famPath:'',devPath:'',ifcFile:'model.ifc',ifcGuid:'wall',classifyName:'',transformMatrix:'',systemNames:[],devSymbolName:'',devType:'',devExpanded:false};
beforeEach(()=>{SpatialWorker.instances=[];SpatialWorker.hold=false;vi.mocked(isTauri).mockReturnValue(false);vi.stubGlobal('Worker',SpatialWorker);});
afterEach(()=>{cancelSubstationSpatialWorkers();vi.unstubAllGlobals();});

it('normalizes displayed bounds once and scopes endpoint identities to their IFC model',()=>{
  const state=new AppState(),object=(key:string,modelId:string,expressId:number,globalId:string,ifcType='IFCBUILDINGELEMENTPROXY')=>({key,modelId,expressId,globalId,ifcType});
  state.substationSpatialIndex={objects:[object('wire','a',1,'w'),object('target','a',2,'shared'),object('port','a',3,'shared','IFCDISTRIBUTIONPORT'),object('other-model','b',2,'shared'),object('duplicate1','a',4,'duplicate'),object('duplicate2','a',5,'duplicate'),object('invalid-wire','a',6,'invalid')]} as any;
  state.ifcRegionalRuntimes=new Map([['a',{index:{unitScale:.001,objects:[
    {expressId:1,bounds:[1,2,3,4,5,6],connectionEndpoints:[{kind:'ifc-element',reference:'shared'}]},
    {expressId:6,bounds:[0,0,0,1,1,1],connectionEndpoints:[{kind:'ifc-element',reference:'duplicate'}]},
  ]}}]]) as any;
  state.deviceLodRuntime={getBusinessOccurrences:function*(){yield {rootOccurrence:'device',boundsQuality:'geometry',templateStatus:'ready',sourceBounds:[0,0,0,2,1,3],placementMatrix:[0,1,0,0,-1,0,0,0,0,0,1,0,10000,20000,30000,1]};}} as any;
  const evidence=collectBusinessGeometry(state);
  expect(evidence.shapes.find(s=>s.objectKey==='wire')).toEqual({objectKey:'wire',min:[1,-6,2],max:[4,-3,5],evidence:'geometry'});
  expect(evidence.shapes.find(s=>s.objectKey==='device')).toEqual({objectKey:'device',min:[9,20,30],max:[10,22,33],evidence:'geometry'});
  expect(evidence.connections).toEqual([{objectKey:'wire',endpointKeys:['target']}]);
  expect(evidence.modelUnits.get('a')).toBe(.001);
});

it.each([false,true])('enriches business IFC objects outside the core UI and rejects a stale session = %s',stale=>{
  let worker:BusinessWorker;
  class BusinessWorker {
    input!:BusinessBuildInput;onmessage:((event:MessageEvent<BusinessTreeProjection>)=>void)|null=null;onerror:null=null;terminate=vi.fn();
    constructor(){worker=this;}postMessage(input:BusinessBuildInput){this.input=structuredClone(input);}
  }
  vi.stubGlobal('Worker',BusinessWorker);
  const state=new AppState();state.currentCbmTree=tree;state.currentIfcEntries=[entry];
  const prior=getBusinessTree(state)!;state.substationSpatialIndex=buildSubstationSpatialIndexFromTexts([{entry,text}],tree);
  const changed=vi.fn(),disposed=vi.fn(),core=getBusinessTree(state,changed,disposed)!;
  expect(core).toBe(prior);
  expect(state.businessTreePending).toBe(true);expect(changed).not.toHaveBeenCalled();
  const input=worker!.input,p=buildBusinessTree(input.root,input.families,{objects:input.objects,objectByKey:new Map(input.objects.map(o=>[o.key,o])),nodeByKey:new Map(input.nodes.map(n=>[n.key,n])),linksByIfcObjectKey:input.links});
  p.cbmByPath=new Map();if(stale)state.activateProject(2,'next');
  worker!.onmessage!({data:p}as MessageEvent<BusinessTreeProjection>);
  expect(worker!.terminate).toHaveBeenCalled();
  if(stale){expect(changed).not.toHaveBeenCalled();expect(state.businessTree).toBe(core);}
  else{expect(changed).toHaveBeenCalledOnce();expect(state.businessTreePending).toBe(false);expect(state.businessTree?.cbmByPath.get(tree.path)).toBe(tree);}
  state.businessTreeCleanup?.();
  expect(disposed).toHaveBeenCalledOnce();
});

it('defers business IFC transfer until IFC and base geometry have settled',()=>{
  vi.useFakeTimers();let created=0;
  class DeferredWorker {onmessage=null;onerror=null;terminate=vi.fn();postMessage=vi.fn();constructor(){created++;}}
  vi.stubGlobal('Worker',DeferredWorker);
  const state=new AppState();state.currentCbmTree=tree;state.substationSpatialIndex=buildSubstationSpatialIndexFromTexts([{entry,text}],tree);state.ifcBackgroundPending=true;
  state.businessTreeInputsReady=false;const diagnostics={baseRepresentationsSettled:false};state.deviceLodRuntime={diagnostics}as any;
  try{
    getBusinessTree(state);expect(created).toBe(0);expect(state.businessTreePending).toBe(true);
    state.ifcBackgroundPending=false;vi.advanceTimersByTime(100);expect(created).toBe(0);
    diagnostics.baseRepresentationsSettled=true;vi.advanceTimersByTime(100);expect(created).toBe(0);
    state.businessTreeInputsReady=true;vi.advanceTimersByTime(100);expect(created).toBe(1);
  }finally{state.businessTreeCleanup?.();vi.useRealTimers();}
});

it('loads a warm business projection without a classification worker, including later spatial publication',async()=>{
  vi.stubGlobal('crypto',webcrypto);vi.mocked(isTauri).mockReturnValue(true);
  const state=new AppState();state.activateProject(7,'a'.repeat(64));state.businessTreeInputVersion='semantic-test';
  const spatial=buildSubstationSpatialIndexFromTexts([{entry,text}],tree),p=buildBusinessTree(tree,new Map(),spatial);
  vi.mocked(readCachedEntry).mockResolvedValue(await encodeBusinessTree(p,{sourceSha256:'a'.repeat(64),semanticVersion:'semantic-test',modelIds:['model']}));
  const preparation=prefetchBusinessTree(state);await preparation;expect(state.businessTree).toBeNull();
  state.currentCbmTree=tree;state.cbmNodeIndex.set('wall.cbm',tree);state.currentIfcEntries=[entry];
  expect(await restoreBusinessTree(state,preparation)).toBe(true);const loaded=getBusinessTree(state);
  state.substationSpatialIndex=spatial;state.cachedFamSourceProperties=new Map();
  expect(getBusinessTree(state)).toBe(loaded);expect(state.businessTreeCacheStatus).toBe('hit');expect(SpatialWorker.instances).toHaveLength(0);
  state.businessTreeCleanup?.();
});

it('worker transport preserves the full spatial graph, Maps, direct links and per-file error isolation',async()=>{
  const files=new Map([['cbm/MODEL.IFC',new File([text],'model.ifc')],['CBM/broken.ifc',{arrayBuffer:async()=>{throw new Error('disk failed');},size:123} as unknown as File]]);
  const entries=[entry,{...entry,modelId:'broken',path:'CBM/broken.ifc'},{...entry,modelId:'missing',path:'CBM/missing.ifc'}];
  const expected=await buildSubstationSpatialIndexFromFiles(files,entries,tree);
  const read=vi.fn(),parsed=vi.fn();
  const actual=await buildSubstationSpatialIndexInWorker(files,entries,tree,[],{onModelRead:read,onModelParsed:parsed},()=>true);
  expect(actual).toEqual(expected);
  const modelRequest=SpatialWorker.instances[0].requests.find(row=>row.type==='model');
  expect(modelRequest?.type==='model' && modelRequest.blob).toBeInstanceOf(Blob);
  expect(modelRequest?.type==='model' && modelRequest.bytes).toBeNull();
  expect(actual.nodeByKey).toBeInstanceOf(Map);
  expect(actual.linksByCbmPath.get(tree.path)?.confidence).toBe('confirmed');
  expect(read).toHaveBeenCalledTimes(3);expect(read.mock.calls[1][0].error).toBe('disk failed');
  expect(parsed).toHaveBeenCalled();
  expect(SpatialWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
});

it('project cleanup rejects a pending STEP task and terminates its worker',async()=>{
  SpatialWorker.hold=true;
  const pending=buildSubstationSpatialIndexInWorker(new Map(),[],null,[],{},()=>true);
  const rejected=expect(pending).rejects.toThrow('obsolete project');
  cancelSubstationSpatialWorkers();await rejected;
  expect(SpatialWorker.instances[0].terminate).toHaveBeenCalledTimes(2);
});

it('unsupported hosts retain the existing parser contract without changing line behavior',async()=>{
  vi.stubGlobal('Worker',undefined);
  const files=new Map([['CBM/model.ifc',new File([text],'model.ifc')]]);
  expect(await buildSubstationSpatialIndexInWorker(files,[entry],tree,[],{},()=>true))
    .toEqual(await buildSubstationSpatialIndexFromFiles(files,[entry],tree));
});
