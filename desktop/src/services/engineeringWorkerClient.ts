import measuredWorkerAsset from './engineeringWorker.ts?worker&url';
import { createMeasuredWorker, drainMeasuredWorker, measurementWorkerUrl } from '../measurement/hostWorker.js';
import { WorkerRequests } from './workerRequests.js';
import type {EngineeringSourceBatch} from './engineeringWorkerProtocol.js';
import type { IfcSpatialObject, IfcSpatialNode, SpatialModelSummary } from '../gim/ifcSpatialParser.js';
import type { EngineeringCacheIdentity } from './engineeringCacheCodec.js';
import type { EngineeringBuildResult, EngineeringCacheDomain, EngineeringCacheResult, EngineeringEvidenceCheckpoint, EngineeringExtractSummary, EngineeringWorkerCommand, EngineeringWorkerRequest, EngineeringWorkerResponse } from './engineeringWorkerProtocol.js';
import type { SourceGeometryOccurrenceCatalog } from '../gim/engineering/geometryOccurrences.js';
import { decodeEngineeringWorkerResult,type TransportGraphCache,type EngineeringWorkerPayload } from './engineeringWorkerTransport.js';
import type { EngineeringNavigationCacheProjection } from './engineeringNavigationCache.js';
import type { EvidenceInventory,EvidencePage,EvidenceQuery,EvidenceRange } from '../engineering/evidence.js';

export interface EngineeringWorkerPort {
  postMessage(message: EngineeringWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<EngineeringWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

/** Session-scoped RPC; close rejects all pending requests and releases the Worker. */
export class EngineeringWorkerClient {
  geometryOccurrences: SourceGeometryOccurrenceCatalog | null = null;
  private sequence = 0;
  private closed = false;
  private graphCache:TransportGraphCache={};
  private decodeQueue:Promise<void>=Promise.resolve();
  private pending = new WorkerRequests<EngineeringWorkerResponse>(120_000, error => this.close(error));
  private abort = () => this.close();
  private port?:EngineeringWorkerPort;
  private checkpoint?:EngineeringEvidenceCheckpoint;
  private metadataEntries=new Map<string,EvidenceInventory['entries'][number]>();
  private metadataCoverage=new Map<string,EvidenceInventory['coverage'][number]>();
  private parking?:Promise<void>;
  private resuming?:Promise<void>;
  private idleTimer?:ReturnType<typeof setTimeout>;
  constructor(port: EngineeringWorkerPort, private readonly isCurrent: () => boolean,
    private readonly signal?: AbortSignal, private readonly onProgress?:(stage:string,completed:number)=>void,
    private readonly restart?:()=>EngineeringWorkerPort) {
    this.attach(port);
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.close();
  }
  private attach(port:EngineeringWorkerPort):void{
    this.port=port;
    port.onmessage = event => {
      if(this.port!==port)return;
      if (!this.isCurrent() || this.signal?.aborted) { this.close(); return; }
      const response = event.data;
      if(response.type==='progress'){
        if(Number.isSafeInteger(response.completed)&&response.completed>0&&this.pending.touch(response.requestId))
          this.onProgress?.(response.stage,response.completed);
        return;
      }
      this.pending.settle(response.requestId, response, response.type === 'error' ? new Error(response.message) : undefined);
    };
    port.onerror = event => {if(this.port===port)this.close(new Error(event.message || 'Engineering worker failed'));};
    port.onmessageerror = () => {if(this.port===port)this.close(new Error('Engineering worker returned unreadable data'));};
  }
  private stopPort():void{
    const port=this.port;this.port=undefined;
    if(port){port.onmessage=null;port.onerror=null;port.onmessageerror=null;port.terminate();}
  }
  static create(isCurrent: () => boolean, signal?: AbortSignal, onProgress?:(stage:string,completed:number)=>void) {
    const factory=()=>createMeasuredWorker('engineering', identity => new Worker(measurementWorkerUrl(measuredWorkerAsset,identity), {type:'module',...(identity?{name:identity}:{})}));
    return new EngineeringWorkerClient(factory(), isCurrent, signal,onProgress,factory);
  }
  close(error: Error = new DOMException('Engineering build cancelled', 'AbortError')): void {
    if (this.closed) return;
    this.closed = true; this.signal?.removeEventListener('abort', this.abort);
    clearTimeout(this.idleTimer);this.checkpoint=undefined;this.metadataEntries.clear();this.metadataCoverage.clear();this.stopPort();
    this.pending.rejectAll(error);
  }
  private assertCurrent():void{
    if(this.closed||!this.isCurrent()||this.signal?.aborted){this.close();throw new DOMException('Engineering build cancelled','AbortError');}
  }
  private send(command:EngineeringWorkerCommand,transfer:Transferable[]=[]):Promise<EngineeringWorkerResponse>{
    this.assertCurrent();const port=this.port;if(!port)return Promise.reject(Error('Engineering worker unavailable'));
    const requestId=++this.sequence;
    return this.pending.request(requestId,()=>port.postMessage({...command,requestId},transfer),command.type==='extract'?60_000:120_000);
  }
  private request(command: EngineeringWorkerCommand, transfer: Transferable[] = []): Promise<EngineeringWorkerResponse> {
    if (this.closed || !this.isCurrent() || this.signal?.aborted) { this.close(); return Promise.reject(new DOMException('Engineering build cancelled', 'AbortError')); }
    clearTimeout(this.idleTimer);
    if(this.parking)return this.parking.then(()=>this.request(command,transfer));
    if(this.resuming)return this.resuming.then(()=>this.request(command,transfer));
    if(!this.port)return this.resume().then(()=>this.request(command,transfer));
    const response=this.send(command,transfer);
    return command.type.startsWith('evidence-')?response.finally(()=>this.idle()):response;
  }
  private resume():Promise<void>{
    if(this.resuming)return this.resuming;
    const checkpoint=this.checkpoint;if(!checkpoint||!this.restart)return Promise.reject(Error('Engineering checkpoint unavailable'));
    const task=(async()=>{
      this.assertCurrent();this.attach(this.restart!());
      await this.send({type:'init',scope:checkpoint.snapshot.scope,paths:checkpoint.snapshot.entries.map(e=>e.path),graphReferences:true});
      await this.send({type:'restore-evidence-checkpoint',checkpoint},[checkpoint.bytes.buffer as ArrayBuffer]);
      this.assertCurrent();this.checkpoint=undefined;this.metadataEntries.clear();this.metadataCoverage.clear();
    })().catch(error=>{this.close(error);throw error;});
    this.resuming=task;void task.finally(()=>{if(this.resuming===task)this.resuming=undefined;}).catch(()=>{});return task;
  }
  private park():Promise<void>{
    if(this.parking)return this.parking;
    if(!this.restart||!this.port||this.closed||this.resuming||this.pending.size)return Promise.resolve();
    clearTimeout(this.idleTimer);
    const port=this.port;
    const task=(async()=>{
      const response=await this.send({type:'checkpoint-evidence'});
      if(response.type!=='evidence-checkpoint')throw Error('Evidence checkpoint expected');
      if(!response.checkpoint)return; // Partial/unencoded facts must stay in their original Worker.
      await drainMeasuredWorker(port);this.assertCurrent();
      this.checkpoint=response.checkpoint;
      this.metadataEntries=new Map(response.checkpoint.snapshot.entries.map(e=>[e.id,e]));
      this.metadataCoverage=new Map(response.checkpoint.snapshot.coverage.map(e=>[e.entryId,e]));
      this.stopPort();
    })().catch(error=>{this.close(error);throw error;});
    this.parking=task;void task.finally(()=>{if(this.parking===task)this.parking=undefined;}).catch(()=>{});return task;
  }
  private idle():void{
    if(!this.restart||!this.port||this.closed)return;
    clearTimeout(this.idleTimer);this.idleTimer=setTimeout(()=>{void this.park().catch(()=>{});},1500);
  }
  private async parkedSnapshot(entryIds?:readonly string[]):Promise<EvidenceInventory|undefined>{
    if(this.parking)await this.parking;if(this.resuming)await this.resuming;this.assertCurrent();
    const snapshot=this.checkpoint?.snapshot;if(!snapshot)return;
    if(!entryIds)return structuredClone(snapshot);
    if(entryIds.some(id=>!this.metadataEntries.has(id)))throw Error('Unknown evidence entry');
    return structuredClone({...snapshot,entryRange:[...entryIds],entries:entryIds.map(id=>this.metadataEntries.get(id)!),coverage:entryIds.map(id=>this.metadataCoverage.get(id)!)});
  }
  async init(scope: string, paths: string[]): Promise<void> {this.graphCache={};await this.request({ type: 'init', scope, paths,graphReferences:true }); }
  private decodeModel(payload:EngineeringWorkerPayload):Promise<EngineeringBuildResult>{
    const next=this.decodeQueue.then(()=>decodeEngineeringWorkerResult(payload,()=>!this.closed&&this.isCurrent()&&!this.signal?.aborted,this.graphCache));
    this.decodeQueue=next.then(()=>{},()=>{});return next;
  }
  async getEvidenceSnapshot(entryIds?:readonly string[]):Promise<EvidenceInventory>{const parked=await this.parkedSnapshot(entryIds);if(parked)return parked;const r=await this.request({type:'evidence-snapshot',entryIds});if(r.type!=='evidence'||!r.snapshot)throw Error('Evidence snapshot expected');return r.snapshot;}
  async queryEvidence(query:EvidenceQuery):Promise<EvidencePage>{
    const parked=await this.parkedSnapshot(query.range.entryIds);
    if(parked){
      if(query.revision!==parked.revision)throw Error('EVIDENCE_REVISION_EXPIRED');
      if(!Number.isSafeInteger(query.offset??0)||(query.offset??0)<0||!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>1000)throw Error('Invalid evidence page');
      return {revision:parked.revision,attributes:[],assignments:[],documents:[],references:[],occurrences:[],coverage:parked.coverage.flatMap(row=>query.range.kinds.map(capability=>({...row,capability,materialization:'not_materialized' as const,rawAvailable:false})))};
    }
    const r=await this.request({type:'evidence-query',query});if(r.type!=='evidence'||!r.page)throw Error('Evidence page expected');return r.page;
  }
  async ensureEvidence(range:EvidenceRange):Promise<EvidenceInventory>{const r=await this.request({type:'evidence-ensure',range});if(r.type!=='evidence'||!r.snapshot)throw Error('Evidence snapshot expected');return r.snapshot;}
  async readEvidenceEntry(path:string):Promise<Uint8Array>{const r=await this.request({type:'evidence-read',path});if(r.type!=='evidence'||!r.bytes)throw Error('Evidence bytes expected');return r.bytes;}
  async releaseModel(buildId?:number):Promise<void>{await this.request({type:'release-model',buildId});await this.park();}
  async recognizeEvidence(identity?:EngineeringCacheIdentity):Promise<EngineeringBuildResult>{const r=await this.request({type:'recognize-evidence',identity});if(r.type!=='model')throw Error('Engineering model expected');return this.decodeModel(r.result);}
  async addFiles(files: Array<{ path: string; blob?: Blob; bytes?: Uint8Array }>): Promise<void> {
    await this.request({ type: 'files', files }, [...new Set(files.flatMap(f => f.bytes ? [f.bytes.buffer as ArrayBuffer] : []))]);
  }
  async addPackedFiles(batch:EngineeringSourceBatch):Promise<void> {await this.request({type:'packed-files',batch});}
  async extract(): Promise<EngineeringExtractSummary> {
    const response = await this.request({ type: 'extract' });
    if (response.type !== 'graph') throw Error('Engineering graph response expected');
    this.geometryOccurrences = response.geometryOccurrences;
    return response.summary;
  }
  async encodeCache(buildId:number,domain:EngineeringCacheDomain,projection?:EngineeringNavigationCacheProjection):Promise<EngineeringCacheResult>{
    const response=await this.request({type:'encode-cache',buildId,domain,projection});
    if(response.type!=='cache'||response.result.buildId!==buildId||response.result.domain!==domain)throw Error('Engineering cache response identity mismatch');
    return response.result;
  }
  async assemble(objects: IfcSpatialObject[], models: SpatialModelSummary[], identity?: EngineeringCacheIdentity, nodes: IfcSpatialNode[] = []): Promise<EngineeringBuildResult> {
    const response = await this.request({ type: 'assemble', objects, models, identity, nodes });
    if (response.type !== 'model') throw Error('Engineering model response expected');
    return this.decodeModel(response.result);
  }
  async restore(sourceBytes: Uint8Array, entityBytes: Uint8Array | undefined, identity: EngineeringCacheIdentity, navigationBytes?: Uint8Array): Promise<EngineeringBuildResult> {
    const transfer = [sourceBytes.buffer as ArrayBuffer]; if (entityBytes) transfer.push(entityBytes.buffer as ArrayBuffer);
    if (navigationBytes) transfer.push(navigationBytes.buffer as ArrayBuffer);
    const response = await this.request({ type: 'restore', sourceBytes, entityBytes, navigationBytes, identity }, [...new Set(transfer)]);
    if (response.type !== 'model') throw Error('Engineering model response expected');
    return this.decodeModel(response.result);
  }
}
