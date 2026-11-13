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
import { encodeEngineeringWorkerResult, engineeringWorkerResultTransfers,type TransportGraphCache } from './engineeringWorkerTransport.js';

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
  async function readRaw(path:string):Promise<Uint8Array>{
    const file=files.get(path);if(!file)throw Error('Raw source unavailable: '+path);
    const bytes=file instanceof Uint8Array?file.slice():new Uint8Array(await file.arrayBuffer());files.delete(path);return bytes;
  }
  function publish(result:EngineeringBuildResult,started:number,identity?:EngineeringCacheIdentity,digest?:string,plan:EngineeringCacheDomain[]=[]):EngineeringWorkerReply{
    result.evidenceRevision=evidence?.getRevision();
    result.buildId=++sequence;result.cachePlan=plan;result.metrics={buildMs:performance.now()-started,transportEncodeMs:0,transportBytes:0};
    latest={result,identity,digest,plan:[...plan]};
    return {type:'model',result:encodeEngineeringWorkerResult(result,graphReferences?wireGraph:undefined)};
  }
  return async(request:EngineeringWorkerCommand, trace:WorkerTaskProbe=NOOP_TASK,
    reportProgress:(stage:'source-index'|'source-traverse'|'source-sort',completed:number)=>void=()=>{}):Promise<EngineeringWorkerReply>=>{
    const started=performance.now();
    if(request.type==='release-model'){if(request.buildId===undefined||latest?.result.buildId===request.buildId)latest=undefined;return {type:'ready'};}
    if(request.type==='init'){scope=request.scope;paths=request.paths;files.clear();batches.clear();graph=null;latest=undefined;lastSources=undefined;
      graphReferences=request.graphReferences===true;wireGraph={};
      evidence=new ModelEvidenceProvider(scope,paths,async path=>batches.has(path)?batches.read(path):decodeGimText(await readRaw(path)).text,readRaw);
      return {type:'ready'};}
    if(request.type==='evidence-snapshot'){if(!evidence)throw Error('Evidence not initialized');return {type:'evidence',snapshot:evidence.getSnapshot(request.entryIds)};}
    if(request.type==='evidence-query'){if(!evidence)throw Error('Evidence not initialized');return {type:'evidence',page:evidence.queryEvidence(request.query)};}
    if(request.type==='evidence-ensure'){if(!evidence)throw Error('Evidence not initialized');return {type:'evidence',snapshot:await evidence.ensureEvidence(request.range)};}
    if(request.type==='evidence-read'){if(!evidence)throw Error('Evidence not initialized');return {type:'evidence',bytes:await evidence.readEntry(request.path)};}
    if(request.type==='recognize-evidence'){
      if(!lastSources||!evidence)throw Error('Engineering sources not ready');
      await materializeEngineeringFamilies(lastSources.graph,path=>evidence!.readText(path),path=>evidence!.familyDocument(path));
      const reasons=lastSources.incompleteReasons.filter(r=>r!=='source-graph-incomplete');
      if(lastSources.graph.diagnostics.length)reasons.push('source-graph-incomplete');
      lastSources={...lastSources,complete:reasons.length===0,incompleteReasons:reasons};
      const result=assembleStoredEngineeringView(scope,lastSources);evidence.attachGraph(lastSources.graph,lastSources.ifcRecords);
      return publish(result,started,request.identity,undefined,request.identity&&lastSources.complete?result.stageErrors.recognition?['sources']:Object.keys(result.stageErrors).length?['sources','entities']:['sources','entities','navigation']:[]);
    }
    if(request.type==='packed-files'){batches.add(request.batch);return {type:'ready'};}
    if(request.type==='files'){
      for(const source of request.files){if(!source.blob&&!source.bytes)throw Error(`Engineering source bytes missing: ${source.path}`);files.set(source.path,source.blob??source.bytes!);}
      return {type:'ready'};
    }
    if(request.type==='extract'){
      graph=null;latest=undefined;lastSources=undefined;evidence?.resetObservations();wireGraph={};
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
      evidence?.attachGraph(graph);
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
        if(request.domain==='sources'){const encoded=await encodeEngineeringSources(result.sources,identity);current.digest=encoded.digest;response.bytes=encoded.bytes;}
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
      lastSources=artifact.sources;evidence=new ModelEvidenceProvider(scope,request.identity.entries,async path=>decodeGimText(await readRaw(path)).text,readRaw);evidence.attachGraph(graph,artifact.sources.ifcRecords);
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
    if(evidence){await materializeEngineeringFamilies(graph,path=>evidence!.readText(path),path=>evidence!.familyDocument(path));evidence.attachGraph(graph);}
    files.clear();batches.clear();
    const built=trace.sync('engineering.normalize', () => assembleEngineeringView(scope,graph!,request.objects,request.models,request.nodes));
    lastSources=built.sources;
    evidence?.attachGraph(graph,built.sources.ifcRecords);
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
      const transfers=response.type==='model'?engineeringWorkerResultTransfers(response.result):response.type==='cache'&&response.result.bytes?[response.result.bytes.buffer as ArrayBuffer]:[];
      trace.produced({ transferBuffers: transfers.length });
      send(trace.result(response),transfers);trace.sentResult();
    }catch(error){trace.fail(error);send({type:'error',requestId:request.requestId,message:String(error)});}});});
  };
}
