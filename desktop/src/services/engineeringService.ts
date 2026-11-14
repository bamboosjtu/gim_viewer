import type { AppState, ProjectLoadSession } from '../app/state.js';
import {isByteFile,copyByteFileBytes} from '@desktop/byteFile.js';
import {ENGINEERING_SOURCE_BATCH_BYTES,ENGINEERING_SOURCE_BATCH_FILES} from './engineeringWorkerProtocol.js';
import type { SubstationSpatialIndex } from '../gim/ifcSpatialParser.js';
import { engineeringCacheEntry, engineeringSourceCacheMatchesFiles, type EngineeringCacheIdentity } from './engineeringCacheCodec.js';
import type { EngineeringBuildResult } from './engineeringWorkerProtocol.js';
import { EngineeringWorkerClient } from './engineeringWorkerClient.js';
import { SUBSTATION_PARSER_DOMAIN_VERSION, SUBSTATION_SPATIAL_SEMANTIC_VERSION } from './substationSpatialCodec.js';
import { isTauri } from '@desktop/runtime.js';
import { perfMark,perfMarkProductMoment } from '../utils/perfTimings.js';
import type { SourceGeometryOccurrenceCatalog } from '../gim/engineering/geometryOccurrences.js';
import { installCompositionProjection } from './compositionProjectionService.js';
import { createNavigationCacheProjection } from './engineeringNavigationCache.js';
import type {EvidenceQuery,EvidenceRange} from '../engineering/evidence.js';

interface EngineeringJob {
  publishedBuildId:number;
  evidenceReady:Promise<void>;
  resolveEvidence():void;
  session: ProjectLoadSession;
  controller: AbortController;
  client: EngineeringWorkerClient;
  ready: Promise<void>;
  lastSpatial: SubstationSpatialIndex | null;
  finished: boolean;
  enriching: boolean;
  identity?: EngineeringCacheIdentity;
  update: () => void;
  beforeCacheWrite?: Promise<unknown>;
  resolveGeometry(catalog: SourceGeometryOccurrenceCatalog | null): void;
  projectionReady: Promise<boolean>;
  resolveProjection(complete: boolean): void;
}
const jobs = new WeakMap<AppState, EngineeringJob>();
const current = (state: AppState, job: EngineeringJob) => jobs.get(state) === job && !job.controller.signal.aborted && state.isCurrentSession(job.session);
const currentBuild=(state:AppState,job:EngineeringJob,result:EngineeringBuildResult)=>current(state,job)&&(!result.buildId||result.buildId===job.publishedBuildId);

function evidenceJob(state:AppState):EngineeringJob{const job=jobs.get(state);if(!job||!current(state,job))throw Error('Engineering evidence session unavailable');return job;}
export async function getEngineeringEvidenceSnapshot(state:AppState,entryIds?:readonly string[]){const job=evidenceJob(state);await job.evidenceReady;if(!current(state,job))throw Error('Stale evidence session');const snapshot=await job.client.getEvidenceSnapshot(entryIds);if(!current(state,job))throw Error('Stale evidence session');return snapshot;}
export async function queryEngineeringEvidence(state:AppState,query:EvidenceQuery){const job=evidenceJob(state);await job.evidenceReady;if(!current(state,job))throw Error('Stale evidence session');const page=await job.client.queryEvidence(query);if(!current(state,job))throw Error('Stale evidence session');return page;}
async function prepareEvidenceEntry(state:AppState,job:EngineeringJob,path:string):Promise<void>{
  if((state.substationEntrySizes.get(path)??0)>16*1024*1024)throw Error('Evidence entry exceeds read budget');
  const file=state.currentFiles?.get(path);
  let bytes:Uint8Array;
  if(file){if(file.size>16*1024*1024)throw Error('Evidence entry exceeds read budget');bytes=new Uint8Array(await file.arrayBuffer());}
  else{if(state.currentProjectId==null)throw Error('Evidence entry unavailable');const {readCachedEntry}=await import('@desktop/database.js');bytes=await readCachedEntry(state.currentProjectId,path);}
  if(bytes.byteLength>16*1024*1024)throw Error('Evidence entry exceeds read budget');
  if(!current(state,job))throw Error('Stale evidence session');await job.client.addFiles([{path,bytes}]);
}
export async function ensureEngineeringEvidence(state:AppState,range:EvidenceRange){
  const job=evidenceJob(state);await job.ready;
  const inventory=await job.client.getEvidenceSnapshot(range.entryIds),entries=new Map(inventory.entries.map(e=>[e.id,e])),coverage=new Map(inventory.coverage.map(e=>[e.entryId,e]));
  for(const path of range.entryIds){const entry=entries.get(path);if(!entry)throw Error('Unknown evidence entry');if(!coverage.get(path)?.restorable&&(entry.status==='not_requested'||entry.status==='failed'||coverage.get(path)?.rawAvailable===false))await prepareEvidenceEntry(state,job,path);}
  const result=await job.client.ensureEvidence(range);if(!current(state,job))throw Error('Stale evidence session');
  const requested=new Set(range.entryIds),affectsRecognition=state.engineeringSources?.graph.familyAssignments?.some(a=>requested.has(a.path));
  if(affectsRecognition&&range.entryIds.some(id=>entries.get(id)?.status==='failed'||entries.get(id)?.status==='not_requested')&&result.revision!==inventory.revision){
    const rebuilt=await job.client.recognizeEvidence(job.identity);if(!current(state,job))throw Error('Stale evidence session');
    publish(state,job,rebuilt);await finishBuild(state,job,rebuilt);
    return job.client.getEvidenceSnapshot(range.entryIds);
  }
  return result;
}
export async function readEngineeringEvidenceEntry(state:AppState,path:string){const job=evidenceJob(state);await job.ready;const inventory=await job.client.getEvidenceSnapshot([path]);if(!inventory.entries.some(e=>e.id===path))throw Error('Unknown evidence entry');await prepareEvidenceEntry(state,job,path);const bytes=await job.client.readEvidenceEntry(path);if(!current(state,job))throw Error('Stale evidence session');return bytes;}
const semanticPath = (path: string) => /\.(?:cbm|dev|fam)$/i.test(path);
export const ENGINEERING_PARSER_CONTRACT = `${SUBSTATION_PARSER_DOMAIN_VERSION}|${SUBSTATION_SPATIAL_SEMANTIC_VERSION}`;

export interface EngineeringBuildOptions {
  onUpdate?: () => void;
  /** Dependency injection for lifecycle/integration tests; production uses a real Worker. */
  createWorker?: (isCurrent: () => boolean, signal: AbortSignal, onProgress:(stage:string,completed:number)=>void) => EngineeringWorkerClient;
  /** Native early-open sources are not a published cache until extraction commits. */
  beforeCacheWrite?: Promise<unknown>;
  /** Starts shared IFC semantics on demand; has no geometry readiness gate. */
  ensureIfcSemantics?: () => Promise<unknown>;
}

async function saveResult(state: AppState, job: EngineeringJob, result: EngineeringBuildResult): Promise<void> {
  if(!currentBuild(state,job,result)||!job.identity||job.session.projectId==null||!result.cachePlan?.length||!result.buildId)return;
  state.engineeringCacheStatus = 'saving'; job.update();
  try {
    await job.beforeCacheWrite;
    if (!currentBuild(state, job,result)) return;
    const { writeCacheFile } = await import('@desktop/database.js');
    if (!currentBuild(state, job,result)) return;
    // Request only after publication and the source commit barrier. Persist and
    // release each buffer before asking the Worker to encode the next domain.
    for(const domain of result.cachePlan){
      if(!currentBuild(state,job,result))return;
      if(domain==='navigation' && !await job.projectionReady){
        if(currentBuild(state,job,result)){state.engineeringCacheStatus='partial';job.update();}return;
      }
      if(!currentBuild(state,job,result))return;
      let projection:ReturnType<typeof createNavigationCacheProjection>|undefined;
      if(domain==='navigation'&&state.engineeringNavigation){
        try{projection=createNavigationCacheProjection(result.navigation,state.engineeringNavigation);}
        catch{
          // The Worker base may not contain the final composition. Never fall
          // back to persisting it as a complete view, or invalidate domains
          // already saved because an optional projection cannot be constructed.
          if(currentBuild(state,job,result)){state.engineeringCacheStatus='partial';
            state.engineeringCacheError='navigation-projection-unavailable';job.update();}
          return;
        }
      }
      const encoded=await job.client.encodeCache(result.buildId,domain,projection);
      if(!currentBuild(state,job,result))return;
      perfMark('工程缓存域编码',{domain,...encoded.metrics});
      state.engineeringPipelineMetrics?.caches.push({domain,...encoded.metrics});
      if(encoded.error||!encoded.bytes){state.engineeringCacheStatus=encoded.disabled?'disabled':'error';state.engineeringCacheError=encoded.disabled??encoded.error??'工程缓存编码未返回内容';job.update();return;}
      await writeCacheFile(job.session.projectId,engineeringCacheEntry(job.identity,domain),encoded.bytes,job.identity.sourceSha256);
      encoded.bytes=undefined;
    }
    if (currentBuild(state, job,result)) { state.engineeringCacheStatus = Object.keys(result.stageErrors??{}).length?'partial':'saved'; state.engineeringCacheError = ''; job.update(); }
  } catch (error) {
    if (currentBuild(state, job,result)) { state.engineeringCacheStatus = 'error'; state.engineeringCacheError = String(error); job.update(); }
  }
}

async function finishBuild(state:AppState,job:EngineeringJob,result:EngineeringBuildResult):Promise<void>{
  if(!currentBuild(state,job,result))return;
  job.finished=true;
  try{await saveResult(state,job,result);}finally{
    // Retain metadata/checkpoint; an idle reconstructible Worker can terminate.
    await job.client.releaseModel?.(result.buildId);
    if(currentBuild(state,job,result)){state.engineeringBuildPending=false;job.update();
      if(!state.engineeringSources?.models.length&&state.engineeringTreeStatus==='loading')
        state.engineeringGeometryEvidenceChanged?.();}
  }
}

function publish(state: AppState, job: EngineeringJob, result: EngineeringBuildResult): void {
  if (!current(state, job)) return;
  if(result.buildId&&result.buildId<=job.publishedBuildId)return;
  if(result.buildId)job.publishedBuildId=result.buildId;
  state.engineeringSources = result.sources;
  state.engineeringSnapshot = result.snapshot;
  state.engineeringNavigation = result.navigation;
  state.engineeringNavigationCacheHit = result.navigationCacheHit === true;
  const noIfc=result.sources.graph.ifcPaths.length===0;
  const finalNavigation=!result.navigation.projectionErrors&&(result.navigationCacheHit===true&&result.navigation.compositionComplete===true&&result.navigation.compositionCoverage==='full' || noIfc);
  state.engineeringTreeStatus=finalNavigation||result.navigation.projectionErrors?'ready':'loading';
  if(result.navigation.projectionErrors){result.navigation.compositionCoverage='partial';job.resolveProjection(false);}
  if(finalNavigation){result.navigation.compositionComplete=true;result.navigation.compositionCoverage='full';job.resolveProjection(true);
    perfMarkProductMoment('engineeringTreeReady',{available:true,source:'engineering-publish'});}
  state.engineeringPipelineMetrics=result.metrics?{...result.metrics,caches:[]}:null;
  state.engineeringGeometryCatalog = result.geometryOccurrences; job.resolveGeometry(result.geometryOccurrences);
  state.engineeringRepresentationChanged?.();
  state.engineeringStatus = result.sources.complete&&!Object.keys(result.stageErrors??{}).length ? 'ready' : 'partial';
  state.engineeringError = Object.entries(result.stageErrors??{}).map(([stage,error])=>`${stage}: ${error}`).join('\n');
  state.engineeringFailureCode=null;
  if (!result.sources.complete) state.engineeringCacheStatus = 'partial';
  if (result.cacheError) { state.engineeringCacheStatus = 'error'; state.engineeringCacheError = result.cacheError; }
  if (result.cacheDisabled) { state.engineeringCacheStatus = 'disabled'; state.engineeringCacheError = result.cacheDisabled; }
  perfMark('工程实体就绪', { complete: result.sources.complete, sources: result.snapshot.memberships.length,
    entities: result.snapshot.entities.length, pending: result.snapshot.pending.length, entityCacheHit: result.entityCacheHit === true, navigationCacheHit: result.navigationCacheHit === true });
  job.update();
  state.engineeringGeometryEvidenceChanged?.();
  // Engineering semantics publish is independent of geometry compilation.
  // Source-template GLB assets are materialized by the DEV path; no entity GLB
  // is scheduled here.
}

async function enrich(state: AppState, job: EngineeringJob): Promise<void> {
  if (!current(state, job) || job.finished || job.enriching) return;
  job.enriching = true;
  try {
    // Notifications can carry a newer immutable spatial snapshot while the
    // Worker is assembling the previous one. Drain them through one owner;
    // closing an earlier job must never cancel a later assembly request.
    while (current(state, job) && !job.finished) {
      const spatial = state.substationSpatialIndex;
      if (!spatial || spatial === job.lastSpatial) return;
      job.lastSpatial = spatial;
      const result = await job.client.assemble(spatial.objects, spatial.models, job.identity, spatial.nodes);
      if (!current(state, job)) return;
      if (state.substationSpatialIndex !== spatial) continue;
      publish(state, job, result);
      await finishBuild(state,job,result);
    }
  } finally { job.enriching = false; }
}

/** IFC semantic readiness is independent of rendering and LOD completion. */
export function notifyEngineeringIfcEvidence(state: AppState): void {
  const job = jobs.get(state); if (!job) return;
  void job.ready.then(() => enrich(state, job)).catch(error => fail(state, job, error));
}
export function notifyEngineeringIfcFailure(state: AppState, reason: string): void {
  const job = jobs.get(state); if (!job || !current(state, job) || job.finished) return;
  job.ready.then(() => {
    if (!current(state, job) || job.finished) return;
    job.finished = true; job.client.close();
    state.engineeringBuildPending=false;
    job.resolveProjection(false);
    state.engineeringTreeStatus=state.engineeringNavigation?'ready':'error';
    if(state.engineeringNavigation)state.engineeringNavigation={...state.engineeringNavigation,compositionCoverage:'partial'};
    state.engineeringError = reason;
    state.engineeringFailureCode='ifc-semantic-failed';
    state.engineeringStatus = state.engineeringSnapshot ? 'partial' : 'error';
    state.engineeringCacheStatus = 'partial'; job.update();
  }).catch(error => fail(state, job, error));
}

function fail(state: AppState, job: EngineeringJob, error: unknown): void {
  if (!current(state, job) || job.finished) return;
  job.client.close();
  job.resolveEvidence();
  job.resolveGeometry(null);
  console.warn('[工程来源] 构建失败', error instanceof Error ? error.stack : String(error));
  job.finished = true;
  state.engineeringBuildPending=false;
  job.resolveProjection(false);
  state.engineeringTreeStatus=state.engineeringNavigation?'ready':'error';
  if(state.engineeringNavigation)state.engineeringNavigation={...state.engineeringNavigation,compositionCoverage:'partial'};
  state.engineeringError = String(error);
  state.engineeringFailureCode=/Worker 请求超时/.test(String(error))?'engineering-progress-stalled':'engineering-build-failed';
  state.engineeringStatus = state.engineeringSnapshot ? 'partial' : 'error';
  job.update();
}

/** Start from actual source files, never the old tree's object/grain projection.
 * Cold File blobs and warm lazy sources share one extraction protocol.
 */
export function beginEngineeringBuild(state: AppState, files: Map<string, File>, options: EngineeringBuildOptions = {}): Promise<void> {
  state.engineeringCleanup?.();
  state.engineeringBuildPending=true;
  state.engineeringProgress=null;
  state.engineeringFailureCode=null;
  let resolveGeometry!: EngineeringJob['resolveGeometry'];
  let resolveProjection!: EngineeringJob['resolveProjection'];
  let resolveEvidence!:EngineeringJob['resolveEvidence'];
  const evidenceReady=new Promise<void>(resolve=>{resolveEvidence=resolve;});
  const projectionReady=new Promise<boolean>(resolve=>{resolveProjection=resolve;});
  state.engineeringGeometryReady = new Promise(resolve => { resolveGeometry = resolve; }); state.engineeringGeometryCatalog = null;
  const session = state.captureProjectSession(), controller = new AbortController();
  if (typeof Worker === 'undefined' && !options.createWorker) {
    state.engineeringBuildPending=false;
    resolveGeometry(null);
    state.engineeringSources = null; state.engineeringSnapshot = null; state.engineeringNavigation = null; state.engineeringNavigationCacheHit = false;
    state.engineeringTreeStatus='error';state.engineeringStatus = 'error'; state.engineeringError = '当前环境无法启动工程实体构建 Worker';
    state.notifyEngineeringChanged(); options.onUpdate?.();
    return Promise.resolve();
  }
  const update = () => { if (state.isCurrentSession(session) && !controller.signal.aborted) { state.notifyEngineeringChanged(); options.onUpdate?.(); } };
  let job: EngineeringJob;
  const client = (options.createWorker ?? EngineeringWorkerClient.create)(() => !!job && current(state, job), controller.signal,
    (stage,completed)=>{if(job&&current(state,job))state.engineeringProgress={stage,completed};});
  const persistent = isTauri() && session.projectId != null && /^[a-f\d]{64}$/i.test(session.sourceSha256 ?? '');
  job = { session, controller, client, resolveGeometry, projectionReady, resolveProjection,evidenceReady,resolveEvidence,publishedBuildId:0, ready: Promise.resolve(), lastSpatial: null, finished: false, enriching: false, update, beforeCacheWrite: options.beforeCacheWrite,
    identity: persistent ? { sourceSha256: session.sourceSha256!, parserVersion: ENGINEERING_PARSER_CONTRACT, entries: [...files.keys()] } : undefined };
  jobs.set(state, job);
  const disposeProjection=installCompositionProjection(state,complete=>job.resolveProjection(complete));
  state.engineeringCleanup = () => { disposeProjection();resolveGeometry(null);resolveProjection(false);resolveEvidence(); controller.abort(); client.close();
    if (jobs.get(state) === job) {state.engineeringBuildPending=false;jobs.delete(state);} };
  state.engineeringSources = null; state.engineeringSnapshot = null; state.engineeringNavigation = null; state.engineeringNavigationCacheHit = false;
  state.engineeringStatus = 'loading'; state.engineeringError = ''; state.engineeringCacheStatus = 'none'; state.engineeringCacheError = ''; update();
  state.engineeringTreeStatus = 'loading';
  state.engineeringPipelineMetrics=null;
  const run = async () => {
    await client.init(session.sourceSha256 || `session:${session.generation}`, [...files.keys()]);job.resolveEvidence();
    if (job.identity) {
      const { readCachedEntry } = await import('@desktop/database.js');
      const reads = await Promise.allSettled([
        readCachedEntry(session.projectId!, engineeringCacheEntry(job.identity, 'sources')),
        readCachedEntry(session.projectId!, engineeringCacheEntry(job.identity, 'entities')),
        readCachedEntry(session.projectId!, engineeringCacheEntry(job.identity, 'navigation')),
      ]);
      if (!current(state, job)) return;
      if (reads[0].status === 'fulfilled') {
        try {
          const result = await client.restore(reads[0].value, reads[1].status === 'fulfilled' ? reads[1].value : undefined, job.identity, reads[2].status === 'fulfilled' ? reads[2].value : undefined);
          if (!current(state, job)) return;
          if (!result.sources.complete || !engineeringSourceCacheMatchesFiles(result.sources, files.keys())) {
            // Never turn a decoded-but-IFC-less body into a partial "hit".
            // Fall through to a controlled rebuild from the actual inventory.
            state.engineeringCacheStatus = 'partial';
            state.engineeringCacheError = '缓存来源未覆盖当前 IFC 清单，已从来源重建';
          } else {
            // A source-only restore is not a full warm hit: entity/navigation
            // were rebuilt from the source body and still need re-encoding.
            const completeHit = result.entityCacheHit === true && result.navigationCacheHit === true;
            state.engineeringCacheStatus = completeHit ? 'hit' : 'partial';
            if (!completeHit) state.engineeringCacheError = '部分缓存命中：实体/导航缓存已从来源重建';
            publish(state, job, result);
            await finishBuild(state,job,result); return;
          }
        } catch (error) { if (!current(state, job)) return; state.engineeringCacheError = String(error); }
      }
      state.engineeringCacheStatus = 'miss'; update();
    }
    const prepareEntries = async(entries:Array<[string,File]>) => {
    // Bounded source batches; native lazy reads use the existing binary batch IPC.
    for (let offset = 0; offset < entries.length;) {
      if (!current(state, job)) return;
      const chunk: Array<[string, File]> = []; let bytes = 0;
      while (offset < entries.length && chunk.length < ENGINEERING_SOURCE_BATCH_FILES) {
        const entry=entries[offset],size=entry[1].size||0;
        if(chunk.length&&bytes+size>ENGINEERING_SOURCE_BATCH_BYTES)break;
        offset++;chunk.push(entry);bytes+=size;
      }
      const lazy = chunk.filter(([, file]) => !(file instanceof Blob)&&!isByteFile(file));
      let batch: Map<string, Uint8Array | null> | undefined;
      if (lazy.length && job.identity) {
        const { batchReadCachedFiles } = await import('@desktop/database.js');
        batch = await batchReadCachedFiles(session.projectId!, lazy.map(([path]) => path));
      }
      const parts:BlobPart[]=[],ranges:Array<{path:string;offset:number;length:number}>=[];let packedBytes=0;
      for (const [path, file] of chunk) {
        let part:Blob|Uint8Array<ArrayBuffer>;
        if(isByteFile(file))part=copyByteFileBytes(file)!;
        else if (file instanceof Blob) part=file;
        else {
          const lazyFile = file as unknown as { arrayBuffer?: () => Promise<ArrayBuffer>; text(): Promise<string> };
          const value = batch?.get(path);
          part=value?(value.buffer instanceof ArrayBuffer?value as Uint8Array<ArrayBuffer>:value.slice()as Uint8Array<ArrayBuffer>):
            typeof lazyFile.arrayBuffer==='function'?new Uint8Array(await lazyFile.arrayBuffer()):new TextEncoder().encode(await lazyFile.text());
        }
        const length=part instanceof Blob?part.size:part.byteLength;
        ranges.push({path,offset:packedBytes,length});parts.push(part);packedBytes+=length;
      }
      if (!current(state, job)) return;
      const blob=new Blob(parts);
      // Unknown/underreported sizes retain the existing per-file path.
      if(blob.size>ENGINEERING_SOURCE_BATCH_BYTES){
        for(const entry of ranges){
          if(!current(state,job))return;
          await client.addFiles([{path:entry.path,blob:blob.slice(entry.offset,entry.offset+entry.length)}]);
        }
      }else await client.addPackedFiles({blob,entries:ranges});
    }
    };
    await prepareEntries([...files].filter(([path])=>semanticPath(path)&&! /\.fam$/i.test(path)));
    const graph = await client.extract();
    if (!current(state, job)) return;
    if (client.geometryOccurrences) { state.engineeringGeometryCatalog = client.geometryOccurrences; resolveGeometry(client.geometryOccurrences); update(); }
    const familyPaths=new Set(graph.familyPaths??[...files.keys()].filter(path=>/\.fam$/i.test(path)));
    await prepareEntries([...files].filter(([path])=>familyPaths.has(path)));
    if (!current(state, job)) return;
    // The geometry catalog is already usable. When a source-semantic starter
    // exists, join it before encoding a full DEV-only model that would be
    // immediately superseded by the same graph plus IFC records. This does
    // not wait for Viewer/LOD readiness and keeps the original failure path.
    const ifcPreparation=graph.ifcPaths.length&&!state.substationSpatialIndex&&options.ensureIfcSemantics
      ?Promise.resolve().then(options.ensureIfcSemantics):undefined;
    if(ifcPreparation){
      try{await ifcPreparation;}catch{/* Publish available DEV evidence below; the terminal handler retains the failure. */}
      if(!current(state,job))return;
    }
    const spatial = state.substationSpatialIndex;
    job.lastSpatial = spatial;
    const result = await client.assemble(spatial?.objects ?? [], spatial?.models ?? [], job.identity, spatial?.nodes ?? []);
    if (!current(state, job)) return;
    if (spatial === state.substationSpatialIndex) publish(state, job, result);
    if ((spatial && spatial === state.substationSpatialIndex) || graph.ifcPaths.length === 0) { await finishBuild(state,job,result); }
    else {
      // Also catch a spatial publication which arrived during the initial
      // assembly, before a notification could register against job.ready.
      void job.ready.then(() => enrich(state, job)).catch(error => fail(state, job, error));
      if (options.ensureIfcSemantics) void (ifcPreparation??Promise.resolve().then(options.ensureIfcSemantics)).then(ready => {
        if (!current(state, job)) return;
        if (ready === false) notifyEngineeringIfcFailure(state, 'IFC 来源语义未能完成');
        // A warm cache hit or a deferred IFC semantic build can publish the
        // spatial index without going through the cold commit callback. Ask the
        // engineering job to enrich IFC records explicitly in both cases.
        else notifyEngineeringIfcEvidence(state);
      }).catch(error => { if (current(state, job)) notifyEngineeringIfcFailure(state, String(error)); });
    }
  };
  job.ready = run().catch(error => fail(state, job, error));
  return job.ready;
}
