import { decodeGimText } from '../shared/textDecode.js';
import {EngineeringSourceBatches} from './engineeringSourceBatches.js';
import { createWorkerProbe, NOOP_TASK, type WorkerTaskProbe } from '../measurement/workerProbe.js';
import { extractEngineeringSourceGraph, materializeEngineeringFamilies, type EngineeringSourceGraph } from '../gim/engineering/sourceGraph.js';
import { ModelEvidenceProvider } from '../gim/engineering/evidenceProvider.js';
import { assembleEngineeringView,assembleStoredEngineeringView } from './engineeringAssembly.js';
import type {EngineeringSources} from '../gim/engineering/buildSources.js';
import { decodeEngineeringEntities, decodeEngineeringSources, encodeEngineeringEntities, encodeEngineeringSources, engineeringCacheSizes } from './engineeringCacheCodec.js';
import type { EngineeringBuildResult, EngineeringCacheDomain, EngineeringCacheResult, EngineeringWorkerCommand, EngineeringWorkerReply, EngineeringWorkerRequest, EngineeringWorkerResponse } from './engineeringWorkerProtocol.js';
import type { EngineeringCacheIdentity } from './engineeringCacheCodec.js';
import { projectEngineeringNavigation } from '../gim/engineering/navigation.js';
import { applyNavigationCacheProjection, decodeEngineeringNavigation, encodeEngineeringNavigation } from './engineeringNavigationCache.js';
import { collectSourceGeometryOccurrences } from '../gim/engineering/geometryOccurrences.js';
import { encodeEngineeringWorkerResultAsync, engineeringWorkerResultTransfers,type TransportGraphCache } from './engineeringWorkerTransport.js';
import type {EvidenceStatus,EvidenceInventory} from '../engineering/evidence.js';

export function markCacheFailure(result:Pick<EngineeringBuildResult,'cacheError'|'cacheDisabled'>,error:unknown):void{
  result.cacheError=String(error);
  if(/plain size|encoded size|expanded length/i.test(String(error)))result.cacheDisabled='工程缓存超过单域 384 MiB 预算，已停止本次缓存写入';
}

/** Display and persistence have separate requests. Only the latest immutable
 * build is retained; one cache buffer is encoded and transferred at a time. */
export function createEngineeringWorkerHandler(){
  let scope='',paths:string[]=[],graph:EngineeringSourceGraph|null=null,sequence=0;
  let latest:{result:EngineeringBuildResult;identity?:EngineeringCacheIdentity;digest?:string;plan:EngineeringCacheDomain[]}|undefined;
  const files=new Map<string,Blob|Uint8Array>();
  const batches=new EngineeringSourceBatches();
  let evidence:ModelEvidenceProvider|undefined;
  let lastSources:EngineeringSources|undefined;
  let graphReferences=false,wireGraph:TransportGraphCache={};
  let parked:{bytes:Uint8Array;identity:EngineeringCacheIdentity;revision:number}|undefined;
  let parkedCoverage:Array<{path:string;status:EvidenceStatus}>=[];
  let parkedEntries=new Set<string>();
  let indexedGraph:EngineeringSourceGraph|undefined,indexedRevision=-1;
  let parkTimer:ReturnType<typeof setTimeout>|undefined,activeEvidence=0;
  async function readFamily(path:string,trace:WorkerTaskProbe=NOOP_TASK):Promise<string>{
    if(batches.has(path))return batches.read(path,trace);
    const source=files.get(path);if(!source)throw Error('Raw source unavailable: '+path);
    const bytes=source instanceof Uint8Array?source:await trace.measureObserved('engineering.source-read',()=>source.arrayBuffer());files.delete(path);
    return decodeGimText(bytes).text;
  }
  function provider():ModelEvidenceProvider{
    if(!evidence){evidence=new ModelEvidenceProvider(scope,paths,path=>readFamily(path),readRaw);evidence.seedCoverage(parkedCoverage);}
    return evidence;
  }
  function sourceCoverage(source:EngineeringSourceGraph):Array<{path:string;status:EvidenceStatus}>{
    return [...source.documents.map(d=>({path:d.path,status:d.attributeStatus??'partial' as const})),
      ...source.diagnostics.filter(d=>d.kind==='read-failed').map(d=>({path:d.source,status:'failed' as const}))];
  }
  function metadata(entryIds?:readonly string[]):EvidenceInventory{
    const p=provider();
    // Metadata needs coverage, not candidate-vector/occurrence indexes.
    if(lastSources)p.seedCoverage(sourceCoverage(lastSources.graph));
    else if(graph)p.seedCoverage(sourceCoverage(graph));
    const snapshot=p.getSnapshot(entryIds);
    return {...snapshot,coverage:snapshot.coverage.map(row=>({...row,restorable:!!parked&&parkedEntries.has(row.entryId)}))};
  }
  function compact():void{
    if(!parked||!lastSources||latest||activeEvidence||parked.revision!==(lastSources.graph.revision??0))return;
    parkedCoverage=sourceCoverage(lastSources.graph);
    for(const model of lastSources.models)parkedCoverage.push({path:model.path,status:'partial'});
    parkedEntries=new Set(parkedCoverage.map(row=>row.path));
    evidence?.seedCoverage(parkedCoverage);evidence?.detachRaw();
    graph=null;lastSources=undefined;wireGraph={};indexedGraph=undefined;indexedRevision=-1;
  }
  async function resume():Promise<ModelEvidenceProvider>{
    if(!lastSources&&parked){const artifact=await decodeEngineeringSources(parked.bytes,parked.identity);lastSources=artifact.sources;graph=lastSources.graph;}
    const p=provider(),current=lastSources?.graph??graph;
    if(current&&(indexedGraph!==current||indexedRevision!==(current.revision??0))){
      p.attachGraph(current,lastSources?.ifcRecords);indexedGraph=current;indexedRevision=current.revision??0;
    }
    return p;
  }
  async function detail<T>(work:()=>Promise<T>|T):Promise<T>{
    if(parkTimer)clearTimeout(parkTimer);activeEvidence++;
    try{return await work();}finally{activeEvidence--;if(parked&&!latest&&!activeEvidence)parkTimer=setTimeout(compact,1500);}
  }
  async function readRaw(path:string):Promise<Uint8Array>{
    const file=files.get(path);if(!file)throw Error('Raw source unavailable: '+path);
    const bytes=file instanceof Uint8Array?file.slice():new Uint8Array(await file.arrayBuffer());files.delete(path);return bytes;
  }
  async function publish(result:EngineeringBuildResult,started:number,identity?:EngineeringCacheIdentity,digest?:string,plan:EngineeringCacheDomain[]=[]):Promise<EngineeringWorkerReply>{
    result.evidenceRevision=evidence?.getRevision();
    result.buildId=++sequence;result.cachePlan=plan;result.metrics={buildMs:performance.now()-started,transportEncodeMs:0,transportBytes:0};
    latest={result,identity,digest,plan:[...plan]};
    return {type:'model',result:await encodeEngineeringWorkerResultAsync(result,graphReferences?wireGraph:undefined)};
  }
  return async(request:EngineeringWorkerCommand, trace:WorkerTaskProbe=NOOP_TASK,
    reportProgress:(stage:'source-index'|'source-traverse'|'source-sort',completed:number)=>void=()=>{}):Promise<EngineeringWorkerReply>=>{
    const started=performance.now();
    if(request.type==='checkpoint-evidence'){
      if(!parked||latest||activeEvidence||lastSources&&parked.revision!==(lastSources.graph.revision??0))return {type:'evidence-checkpoint'};
      compact();const p=provider();p.detachRaw();
      return {type:'evidence-checkpoint',checkpoint:{bytes:parked.bytes,identity:parked.identity,sourceRevision:parked.revision,buildSequence:sequence,snapshot:metadata()}};
    }
    if(request.type==='restore-evidence-checkpoint'){
      const checkpoint=request.checkpoint;
      if(checkpoint.identity.sourceSha256!==scope||checkpoint.snapshot.scope!==scope||!Number.isSafeInteger(checkpoint.sourceRevision)||checkpoint.sourceRevision<0||!Number.isSafeInteger(checkpoint.buildSequence)||checkpoint.buildSequence<0||!checkpoint.bytes.byteLength)throw Error('Invalid evidence checkpoint identity');
      sequence=Math.max(sequence,checkpoint.buildSequence);
      parked={bytes:checkpoint.bytes,identity:checkpoint.identity,revision:checkpoint.sourceRevision};graph=null;lastSources=undefined;latest=undefined;wireGraph={};indexedGraph=undefined;indexedRevision=-1;
      parkedCoverage=checkpoint.snapshot.entries.map(e=>({path:e.path,status:e.status}));parkedEntries=new Set(checkpoint.snapshot.coverage.filter(c=>c.restorable).map(c=>c.entryId));
      provider().restoreMetadata(checkpoint.snapshot);return {type:'ready'};
    }
    if(request.type==='release-model'){if(request.buildId===undefined||latest?.result.buildId===request.buildId){latest=undefined;compact();}return {type:'ready'};}
    if(request.type==='init'){scope=request.scope;paths=request.paths;files.clear();batches.clear();graph=null;latest=undefined;lastSources=undefined;
      graphReferences=request.graphReferences===true;wireGraph={};
      if(parkTimer)clearTimeout(parkTimer);parked=undefined;parkedCoverage=[];parkedEntries.clear();evidence=undefined;indexedGraph=undefined;indexedRevision=-1;
      return {type:'ready'};}
    if(request.type==='evidence-snapshot')return {type:'evidence',snapshot:metadata(request.entryIds)};
    if(request.type==='evidence-query')return detail(()=>({type:'evidence' as const,page:provider().queryEvidence(request.query)}));
    if(request.type==='evidence-ensure')return detail(async()=>{const p=await resume();return {type:'evidence' as const,snapshot:await p.ensureEvidence(request.range)};});
    if(request.type==='evidence-read')return detail(async()=>({type:'evidence' as const,bytes:await provider().readEntry(request.path)}));
    if(request.type==='recognize-evidence')return detail(async()=>{
      await resume();if(!lastSources||!evidence)throw Error('Engineering sources not ready');
      await materializeEngineeringFamilies(lastSources.graph,path=>evidence!.readText(path),path=>evidence!.familyDocument(path));
      const reasons=lastSources.incompleteReasons.filter(r=>r!=='source-graph-incomplete');
      if(lastSources.graph.diagnostics.length)reasons.push('source-graph-incomplete');
      lastSources={...lastSources,complete:reasons.length===0,incompleteReasons:reasons};
      const result=assembleStoredEngineeringView(scope,lastSources);evidence.attachGraph(lastSources.graph,lastSources.ifcRecords);
      indexedGraph=lastSources.graph;indexedRevision=indexedGraph.revision??0;
      return publish(result,started,request.identity,undefined,request.identity&&lastSources.complete?result.stageErrors.recognition?['sources']:Object.keys(result.stageErrors).length?['sources','entities']:['sources','entities','navigation']:[]);
    });
    if(request.type==='packed-files'){batches.add(request.batch);return {type:'ready'};}
    if(request.type==='files'){
      for(const source of request.files){if(!source.blob&&!source.bytes)throw Error(`Engineering source bytes missing: ${source.path}`);files.set(source.path,source.blob??source.bytes!);}
      return {type:'ready'};
    }
    if(request.type==='extract'){
      graph=null;latest=undefined;lastSources=undefined;evidence?.resetObservations();wireGraph={};parked=undefined;parkedCoverage=[];parkedEntries.clear();indexedGraph=undefined;indexedRevision=-1;
      let lastProgress=0,lastStage='',completed=0;
      let byteReads=0,lastYield=performance.now();
      const progress=(stage:'source-index'|'source-traverse'|'source-sort')=>{
        const now=performance.now();completed++;
        if(stage!==lastStage||now-lastProgress>=1000){lastProgress=now;lastStage=stage;reportProgress(stage,completed);}
      };
      try{graph=await trace.measure('engineering.extract', () => extractEngineeringSourceGraph({paths,readText:async path=>{try{
        if(batches.has(path)){
          if(++byteReads%128===0||performance.now()-lastYield>=8){await new Promise<void>(resolve=>setTimeout(resolve,0));lastYield=performance.now();}
          const text=await batches.read(path,trace);progress('source-traverse');return text;
        }
        const source=files.get(path);if(!source)throw Error(`Engineering source unavailable: ${path}`);
        if(source instanceof Uint8Array&&(++byteReads%128===0||performance.now()-lastYield>=8)){
          // Blob reads naturally yield. Binary sources must also let the Worker
          // retire completed async frames and GC between bounded decode slices.
          await new Promise<void>(resolve=>setTimeout(resolve,0));lastYield=performance.now();
        }
        const bytes=source instanceof Uint8Array?source:await trace.measureObserved('engineering.source-read', () => source.arrayBuffer());
        const text=trace.syncObserved('engineering.decode', () => decodeGimText(bytes).text);
        // SourceGraph caches each decoded document by canonical path. Keeping
        // its transferred raw input until the entire graph is sorted doubles
        // residency unnecessarily, especially for large PHM/FAM sources.
        files.delete(path);progress('source-traverse');return text;
      }catch(error){evidence?.recordFailure(path);throw error;}}},{deferFamilies:true,onProgress:progress}));}finally{
        const needed=new Set(graph?.familyAssignments?.map(a=>a.path)??[]);
        for(const path of files.keys())if(!needed.has(path))files.delete(path);
        batches.retain(needed);
      }
      return {type:'graph',summary:{ifcPaths:graph.ifcPaths,sourceRecords:graph.records.length,familyPaths:[...new Set(graph.familyAssignments?.map(a=>a.path)??[])]},geometryOccurrences:collectSourceGeometryOccurrences(graph)};
    }
    if(request.type==='encode-cache'){
      const current=latest;
      if(!current||current.result.buildId!==request.buildId||!current.identity||current.plan[0]!==request.domain)throw Error('工程缓存请求的构建身份或顺序无效');
      const response:EngineeringCacheResult={buildId:request.buildId,domain:request.domain,metrics:{encodeMs:0,plainBytes:0,encodedBytes:0}};
      try{
        const {result,identity}=current;
        if(request.projection){
          if(request.domain!=='navigation')throw Error('Navigation override for non-navigation domain');
          result.navigation=applyNavigationCacheProjection(result.navigation,request.projection);
        }
        if(request.domain==='sources'){const encoded=await encodeEngineeringSources(result.sources,identity);current.digest=encoded.digest;response.bytes=encoded.bytes;parked={bytes:encoded.bytes.slice(),identity,revision:result.sources.graph.revision??0};}
        else {
          if(!current.digest)throw Error('工程缓存缺少来源摘要');
          response.bytes=request.domain==='entities'?await encodeEngineeringEntities(result.snapshot,{sources:result.sources,digest:current.digest},identity)
            :await encodeEngineeringNavigation(result.navigation,result.sources,result.snapshot,current.digest,identity);
        }
        Object.assign(response.metrics,engineeringCacheSizes(response.bytes));current.plan.shift();
      }catch(error){const failure:Pick<EngineeringBuildResult,'cacheError'|'cacheDisabled'>={};markCacheFailure(failure,error);response.error=failure.cacheError;response.disabled=failure.cacheDisabled;current.plan=[];}
      response.metrics.encodeMs=performance.now()-started;
      trace.record('engineering.cache-encode', response.metrics.encodeMs, { bytes: response.bytes?.byteLength ?? 0 });
      return {type:'cache',result:response};
    }
    if(request.type==='restore'){
      latest=undefined;
      const artifact=await decodeEngineeringSources(request.sourceBytes,request.identity);graph=artifact.sources.graph;scope=request.identity.sourceSha256;
      lastSources=artifact.sources;parked={bytes:request.sourceBytes,identity:request.identity,revision:graph.revision??0};
      let snapshot,entityCacheHit=false,stageErrors:Record<string,string>={};
      try{if(!request.entityBytes)throw Error('entity-cache-missing');snapshot=await decodeEngineeringEntities(request.entityBytes,artifact,request.identity);entityCacheHit=true;}
      catch{const recovered=assembleStoredEngineeringView(scope,artifact.sources);snapshot=recovered.snapshot;stageErrors=recovered.stageErrors;}
      let navigation,navigationCacheHit=false;
      try{if(!request.navigationBytes)throw Error('navigation-cache-missing');navigation=await decodeEngineeringNavigation(request.navigationBytes,artifact.sources,snapshot,artifact.digest,request.identity);
        if(graph.ifcPaths.length && (navigation.compositionComplete!==true||navigation.compositionCoverage!=='full'))throw Error('navigation-projection-incomplete');
        navigationCacheHit=true;}
      catch{navigation=projectEngineeringNavigation(artifact.sources,snapshot);}
      Object.assign(stageErrors,navigation.projectionErrors);
      // Drop incoming cache buffers before constructing the display transport.
      request.sourceBytes=new Uint8Array();delete request.entityBytes;delete request.navigationBytes;
      const plan:EngineeringCacheDomain[]=[];if(!stageErrors.recognition&&!entityCacheHit)plan.push('entities');if(!Object.keys(stageErrors).length&&!navigationCacheHit)plan.push('navigation');
      return publish({sources:artifact.sources,snapshot,navigation,geometryOccurrences:collectSourceGeometryOccurrences(graph),entityCacheHit,navigationCacheHit,stageErrors},started,request.identity,artifact.digest,plan);
    }
    if(!graph||!scope)throw Error('Engineering source graph is not ready');
    latest=undefined;
    await trace.measure('engineering.families',()=>materializeEngineeringFamilies(graph!,path=>readFamily(path,trace),path=>evidence?.familyDocument(path)));
    files.clear();batches.clear();
    const built=trace.sync('engineering.normalize', () => assembleEngineeringView(scope,graph!,request.objects,request.models,request.nodes));
    lastSources=built.sources;
    return publish(built,started,request.identity,undefined,
      request.identity&&built.sources.complete?built.stageErrors.recognition?['sources']:Object.keys(built.stageErrors).length?['sources','entities']:['sources','entities','navigation']:[]);
  };
}

if(typeof document==='undefined'&&typeof self!=='undefined'&&typeof self.postMessage==='function'){
  const handle=createEngineeringWorkerHandler(),send=self.postMessage.bind(self) as (response:EngineeringWorkerResponse,transfer?:Transferable[])=>void;
  let chain=Promise.resolve();
  const probe=createWorkerProbe();
  self.onmessage=(event:MessageEvent<EngineeringWorkerRequest>)=>{
    if(probe.control(event))return;
    chain=chain.then(async()=>{await probe.run(event, async trace=>{const request=event.data;try{
      const reply=await handle(request, trace,(stage,completed)=>send({type:'progress',stage,completed,requestId:request.requestId})),response={...reply,requestId:request.requestId} as EngineeringWorkerResponse;
      const transfers=response.type==='model'?engineeringWorkerResultTransfers(response.result):response.type==='evidence-checkpoint'&&response.checkpoint?[response.checkpoint.bytes.buffer as ArrayBuffer]:response.type==='cache'&&response.result.bytes?[response.result.bytes.buffer as ArrayBuffer]:[];
      trace.produced({ transferBuffers: transfers.length });
      send(trace.result(response),transfers);trace.sentResult();
    }catch(error){trace.fail(error);send({type:'error',requestId:request.requestId,message:String(error)});}});});
  };
}
