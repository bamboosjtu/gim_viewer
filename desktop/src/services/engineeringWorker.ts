import { extractEngineeringSourceGraph, type EngineeringSourceGraph } from '../gim/engineering/sourceGraph.js';
import { buildEngineeringSources, normalizeEngineeringSources } from '../gim/engineering/buildSources.js';
import { decodeEngineeringEntities, decodeEngineeringSources, encodeEngineeringEntities, encodeEngineeringSources, engineeringCacheSizes } from './engineeringCacheCodec.js';
import type { EngineeringBuildResult, EngineeringCacheDomain, EngineeringCacheResult, EngineeringWorkerCommand, EngineeringWorkerReply, EngineeringWorkerRequest, EngineeringWorkerResponse } from './engineeringWorkerProtocol.js';
import type { EngineeringCacheIdentity } from './engineeringCacheCodec.js';
import { projectEngineeringNavigation } from '../gim/engineering/navigation.js';
import { assertEngineeringNavigation, decodeEngineeringNavigation, encodeEngineeringNavigation } from './engineeringNavigationCache.js';
import { collectSourceGeometryOccurrences } from '../gim/engineering/geometryOccurrences.js';
import { encodeEngineeringWorkerResult, engineeringWorkerResultTransfers } from './engineeringWorkerTransport.js';

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
  function publish(result:EngineeringBuildResult,started:number,identity?:EngineeringCacheIdentity,digest?:string,plan:EngineeringCacheDomain[]=[]):EngineeringWorkerReply{
    result.buildId=++sequence;result.cachePlan=plan;result.metrics={buildMs:performance.now()-started,transportEncodeMs:0,transportBytes:0};
    latest={result,identity,digest,plan:[...plan]};
    return {type:'model',result:encodeEngineeringWorkerResult(result)};
  }
  return async(request:EngineeringWorkerCommand):Promise<EngineeringWorkerReply>=>{
    const started=performance.now();
    if(request.type==='init'){scope=request.scope;paths=request.paths;files.clear();graph=null;latest=undefined;return {type:'ready'};}
    if(request.type==='files'){
      for(const source of request.files){if(!source.blob&&!source.bytes)throw Error(`Engineering source bytes missing: ${source.path}`);files.set(source.path,source.blob??source.bytes!);}
      return {type:'ready'};
    }
    if(request.type==='extract'){
      graph=await extractEngineeringSourceGraph({paths,readText:async path=>{
        const source=files.get(path);if(!source)throw Error(`Engineering source unavailable: ${path}`);
        const bytes=source instanceof Uint8Array?source:await source.arrayBuffer();
        try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('gb18030',{fatal:true}).decode(bytes);}
      }});files.clear();
      return {type:'graph',summary:{ifcPaths:graph.ifcPaths,sourceRecords:graph.records.length},geometryOccurrences:collectSourceGeometryOccurrences(graph)};
    }
    if(request.type==='encode-cache'){
      const current=latest;
      if(!current||current.result.buildId!==request.buildId||!current.identity||current.plan[0]!==request.domain)throw Error('工程缓存请求的构建身份或顺序无效');
      const response:EngineeringCacheResult={buildId:request.buildId,domain:request.domain,metrics:{encodeMs:0,plainBytes:0,encodedBytes:0}};
      try{
        const {result,identity}=current;
        if(request.navigation){
          if(request.domain!=='navigation')throw Error('Navigation override for non-navigation domain');
          assertEngineeringNavigation(request.navigation,result.sources,result.snapshot);
          result.navigation=request.navigation;
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
      return {type:'cache',result:response};
    }
    if(request.type==='restore'){
      latest=undefined;
      const artifact=await decodeEngineeringSources(request.sourceBytes,request.identity);graph=artifact.sources.graph;scope=request.identity.sourceSha256;
      let snapshot,entityCacheHit=false;
      try{if(!request.entityBytes)throw Error('entity-cache-missing');snapshot=await decodeEngineeringEntities(request.entityBytes,artifact,request.identity);entityCacheHit=true;}
      catch{snapshot=normalizeEngineeringSources(scope,artifact.sources);}
      let navigation,navigationCacheHit=false;
      try{if(!request.navigationBytes)throw Error('navigation-cache-missing');navigation=await decodeEngineeringNavigation(request.navigationBytes,artifact.sources,snapshot,artifact.digest,request.identity);
        if(graph.ifcPaths.length && (navigation.compositionComplete!==true||navigation.compositionCoverage!=='full'))throw Error('navigation-projection-incomplete');
        navigationCacheHit=true;}
      catch{navigation=projectEngineeringNavigation(artifact.sources,snapshot);}
      // Drop incoming cache buffers before constructing the display transport.
      request.sourceBytes=new Uint8Array();delete request.entityBytes;delete request.navigationBytes;
      const plan:EngineeringCacheDomain[]=[];if(!entityCacheHit)plan.push('entities');if(!navigationCacheHit)plan.push('navigation');
      return publish({sources:artifact.sources,snapshot,navigation,geometryOccurrences:collectSourceGeometryOccurrences(graph),entityCacheHit,navigationCacheHit},started,request.identity,artifact.digest,plan);
    }
    if(!graph||!scope)throw Error('Engineering source graph is not ready');
    latest=undefined;
    const built=buildEngineeringSources(scope,graph,request.objects,request.models,request.nodes);
    return publish({...built,navigation:projectEngineeringNavigation(built.sources,built.snapshot),geometryOccurrences:collectSourceGeometryOccurrences(graph)},started,request.identity,undefined,
      request.identity&&built.sources.complete?['sources','entities','navigation']:[]);
  };
}

if(typeof document==='undefined'&&typeof self!=='undefined'&&typeof self.postMessage==='function'){
  const handle=createEngineeringWorkerHandler(),send=self.postMessage.bind(self) as (response:EngineeringWorkerResponse,transfer?:Transferable[])=>void;
  let chain=Promise.resolve();
  self.onmessage=(event:MessageEvent<EngineeringWorkerRequest>)=>{
    chain=chain.then(async()=>{const request=event.data;try{
      const reply=await handle(request),response={...reply,requestId:request.requestId} as EngineeringWorkerResponse;
      const transfers=response.type==='model'?engineeringWorkerResultTransfers(response.result):response.type==='cache'&&response.result.bytes?[response.result.bytes.buffer as ArrayBuffer]:[];
      send(response,transfers);
    }catch(error){send({type:'error',requestId:request.requestId,message:String(error)});}});
  };
}
