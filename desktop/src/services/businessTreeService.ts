import type { AppState } from '../app/state.js';
import { buildBusinessTree, type BusinessTreeProjection, type BusinessFamilyValue, type BusinessSpatialObject } from '../gim/businessTree.js';
import type { CbmNode } from '../gim/types.js';
import type { IfcSpatialNode } from '../gim/ifcSpatialParser.js';
import type { FamPropertyPayload } from '@desktop/database.js';
import { isTauri } from '@desktop/runtime.js';
import { createIfcModelId } from '../gim/modelIdentity.js';
import { readBusinessTree, writeBusinessTree, prepareBusinessTreeRead, type BusinessTreeReader, type BusinessCacheIdentity } from './businessTreeCache.js';
import { perfMark } from '../utils/perfTimings.js';
import { collectBusinessGeometry } from './businessGeometryEvidence.js';
interface Cache {root:CbmNode;fam:unknown;count:number;spatial:unknown;value:BusinessTreeProjection;complete:boolean;worker?:Worker;timer?:ReturnType<typeof setTimeout>;update?:()=>void;dispose?:()=>void}
export interface BusinessBuildInput {root:CbmNode;families:Map<string,BusinessFamilyValue[]>;objects:BusinessSpatialObject[];nodes:IfcSpatialNode[];links:Map<string,{cbmPath:string}[]>;geometry?:ReturnType<typeof collectBusinessGeometry>}
const caches=new WeakMap<AppState,Cache>();
const identity=(state:AppState):BusinessCacheIdentity=>({sourceSha256:state.currentSourceSha256??'',semanticVersion:state.businessTreeInputVersion,modelIds:state.currentIfcEntries.map(e=>e.modelId||createIfcModelId(e.path))});
const persistent=(state:AppState)=>isTauri()&&state.currentProjectId!=null&&/^[a-f\d]{64}$/i.test(state.currentSourceSha256??'')&&state.businessTreeInputVersion!=='transient';
function install(state:AppState,cache:Cache):void {
  caches.set(state,cache);state.businessTree=cache.value;cache.value.sourceGeneration=state.projectGeneration;
  state.businessTreeCleanup=()=>{cache.worker?.terminate();clearTimeout(cache.timer);if(caches.get(state)===cache)caches.delete(state);cache.dispose?.();};
}
type BusinessPreparation={reader:BusinessTreeReader;durationMs:number}|{error:unknown};
/** Independent I/O/decode can overlap getGimIndex; no state is installed before final source/model binding. */
export function prefetchBusinessTree(state:AppState):Promise<BusinessPreparation>|undefined {
  if(!persistent(state))return;
  const started=performance.now();
  return prepareBusinessTreeRead(state.currentProjectId!,identity(state)).then(reader=>({reader,durationMs:performance.now()-started})).catch(error=>({error}));
}
/** Warm path: load an immutable, validated projection before rendering. Never invokes classification. */
export async function restoreBusinessTree(state:AppState,preparation?:Promise<BusinessPreparation>):Promise<boolean> {
  if(!state.currentCbmTree||!persistent(state))return false;
  const session=state.captureProjectSession(),root=state.currentCbmTree,started=performance.now();
  try{
    // The existing cbmNodeIndex is a basename lookup. Business identities are
    // complete occurrence paths; hydrate references from the restored graph.
    const nodes=new Map<string,CbmNode>();
    const bind=(node:CbmNode):void=>{if(nodes.has(node.path))return;nodes.set(node.path,node);node.children.forEach(bind);};bind(root);
    const prepared=preparation?await preparation:undefined;
    if(prepared&&'error'in prepared)throw prepared.error;
    const value=prepared?await prepared.reader(identity(state),nodes):await readBusinessTree(session.projectId!,identity(state),nodes);
    if(!state.isCurrentSession(session)||state.currentCbmTree!==root)return false;
    install(state,{root,fam:state.cachedFamSourceProperties,count:state.cachedFamSourceProperties.size,spatial:state.substationSpatialIndex,value,complete:true});
    state.businessTreePending=false;state.businessTreeError='';state.businessTreeCacheStatus='hit';state.businessTreeCacheError='';
    perfMark('业务树缓存恢复',{hit:true,durationMs:performance.now()-started,prefetchMs:prepared?.durationMs,objects:value.objects.size});return true;
  }catch(error){
    if(state.isCurrentSession(session)){state.businessTreeCacheStatus='miss';state.businessTreeCacheError=String(error);perfMark('业务树缓存恢复',{hit:false,reason:String(error),durationMs:performance.now()-started});}
    return false;
  }
}
/** Reuse the FAM rows already parsed by semantic publication; no second source scan. */
export function businessFamiliesPublished(state:AppState,rows:readonly FamPropertyPayload[]):void {
  if(caches.get(state)?.complete){state.businessTreeInputsReady=true;return;}
  const families=new Map<string,import('../gim/famParser.js').FamSourceProperty[]>();
  for(const row of rows)if(row.raw_property_json){const values=families.get(row.source_path)??[];values.push(JSON.parse(row.raw_property_json));families.set(row.source_path,values);}
  state.cachedFamSourceProperties=families;state.businessTreeInputsReady=true;
  const old=caches.get(state);if(old){old.worker?.terminate();clearTimeout(old.timer);caches.delete(state);state.businessTree=null;old.update?.();}
}
/** Cold/missing projection only. Complete projections stay immutable for this read-only source session. */
export function getBusinessTree(state:AppState,onUpdate?:()=>void,onDispose?:()=>void):BusinessTreeProjection|null {
  const root=state.currentCbmTree;if(!root)return null;
  const old=caches.get(state),sameCore=old&&old.root===root&&old.fam===state.cachedFamSourceProperties&&old.count===state.cachedFamSourceProperties.size;
  if(old?.root===root&&(old.complete||sameCore&&old.spatial===state.substationSpatialIndex)){
    old.update=onUpdate??old.update;old.dispose=onDispose??old.dispose;return old.value;
  }
  old?.worker?.terminate();clearTimeout(old?.timer);
  const spatial=state.substationSpatialIndex,background=!!spatial&&typeof Worker!=='undefined',started=performance.now();
  const value=background&&sameCore&&!old.spatial?old.value:buildBusinessTree(root,state.cachedFamSourceProperties,background?null:spatial?{...spatial,...collectBusinessGeometry(state)}:null);
  const cache:Cache={root,fam:state.cachedFamSourceProperties,count:state.cachedFamSourceProperties.size,spatial,value,complete:false,update:onUpdate,dispose:onDispose};install(state,cache);
  state.businessTreePending=background||state.currentIfcEntries.length>0;state.businessTreeError='';state.businessTreeCacheStatus='building';
  perfMark('业务树明确归属',{durationMs:performance.now()-started,objects:value.objects.size,units:value.units.size});
  const session=state.captureProjectSession(),current=()=>state.isCurrentSession(session)&&caches.get(state)===cache;
  const finish=(p:BusinessTreeProjection)=>{
    if(!current())return;p.cbmByPath=value.cbmByPath;p.sourceGeneration=session.generation;cache.value=p;cache.complete=true;state.businessTree=p;state.businessTreePending=false;
    const incomplete=spatial&&(spatial.models.some(m=>m.parseError)||spatial.models.length!==state.currentIfcEntries.length||identity(state).modelIds.some(id=>!spatial.models.some(m=>m.modelId===id)));
    if(incomplete){cache.complete=false;state.businessTreeError='部分 IFC 业务来源解析失败，未保存完整缓存';cache.update?.();return;}
    if(persistent(state)&&state.businessTreeInputsReady){
      state.businessTreeCacheStatus='saving';const cacheIdentity=identity(state);
      void writeBusinessTree(session.projectId!,cacheIdentity,p).then(bytes=>{
        if(!current())return;state.businessTreeCacheStatus='saved';state.businessTreeCacheError='';perfMark('业务树缓存发布',{bytes,objects:p.objects.size});cache.update?.();
      }).catch(error=>{if(current()){state.businessTreeCacheStatus='error';state.businessTreeCacheError=String(error);cache.update?.();}});
    }
    cache.update?.();
  };
  if(background&&spatial){
    const launch=()=>{
      cache.timer=undefined;if(!current())return;
      if(!state.businessTreeInputsReady||state.ifcBackgroundPending||state.deviceLodRuntime&&!state.deviceLodRuntime.diagnostics.baseRepresentationsSettled){cache.timer=setTimeout(launch,100);return;}
      const deferredMs=performance.now()-started;
      try{
        const worker=new Worker(new URL('./businessTreeWorker.ts',import.meta.url),{type:'module'});cache.worker=worker;
        worker.onmessage=(event:MessageEvent<BusinessTreeProjection>)=>{worker.terminate();cache.worker=undefined;if(!current())return;perfMark('业务树 IFC 投影就绪',{durationMs:performance.now()-started,deferredMs,objects:event.data.objects.size});finish(event.data);};
        worker.onerror=event=>{worker.terminate();cache.worker=undefined;if(current()){state.businessTreePending=false;state.businessTreeError=event.message||'IFC 业务索引失败';cache.update?.();}};
        const stripped=new Map<CbmNode,CbmNode>();
        const strip=(n:CbmNode):CbmNode=>{let copy=stripped.get(n);if(copy)return copy;copy={...n,rawProperties:Object.fromEntries(Object.entries(n.rawProperties??{}).filter(([key])=>/^BASEFAMILY(?:POINTER|\d*)$/i.test(key))),children:[]};stripped.set(n,copy);copy.children=n.children.map(strip);return copy;};
        const families=new Map<string,BusinessFamilyValue[]>();
        for(const [path,rows]of state.cachedFamSourceProperties){const values=rows.filter(r=>/设备名称|设备类型|名称|类型|NAME|TYPE|电压|voltage/i.test(r.label||r.rawKey)).map(({label,rawKey,rawValue})=>({label,rawKey,rawValue}));if(values.length)families.set(path,values);}
        const objects=spatial.objects.map(o=>({key:o.key,modelId:o.modelId,globalId:o.globalId,expressId:o.expressId,ifcType:o.ifcType,name:o.name,objectType:o.objectType,parentObjectKey:o.parentObjectKey,hostObjectKey:o.hostObjectKey,spatialKey:o.spatialKey,sourcePath:o.sourcePath}));
        worker.postMessage({root:strip(root),families,objects,nodes:[...spatial.nodeByKey.values()],links:new Map([...spatial.linksByIfcObjectKey].map(([key,rows])=>[key,rows.map(r=>({cbmPath:r.cbmPath}))])),geometry:collectBusinessGeometry(state)} satisfies BusinessBuildInput);
      }catch(error){if(current()){cache.worker?.terminate();cache.worker=undefined;state.businessTreePending=false;state.businessTreeError=String(error);}}
    };launch();
  }else if((spatial||!state.currentIfcEntries.length)&&state.businessTreeInputsReady)finish(value);
  return value;
}
