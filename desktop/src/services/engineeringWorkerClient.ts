import measuredWorkerAsset from './engineeringWorker.ts?worker&url';
import { createMeasuredWorker, measurementWorkerUrl } from '../measurement/hostWorker.js';
import { WorkerRequests } from './workerRequests.js';
import type {EngineeringSourceBatch} from './engineeringWorkerProtocol.js';
import type { IfcSpatialObject, IfcSpatialNode, SpatialModelSummary } from '../gim/ifcSpatialParser.js';
import type { EngineeringCacheIdentity } from './engineeringCacheCodec.js';
import type { EngineeringBuildResult, EngineeringCacheDomain, EngineeringCacheResult, EngineeringExtractSummary, EngineeringWorkerCommand, EngineeringWorkerRequest, EngineeringWorkerResponse } from './engineeringWorkerProtocol.js';
import type { SourceGeometryOccurrenceCatalog } from '../gim/engineering/geometryOccurrences.js';
import { decodeEngineeringWorkerResult } from './engineeringWorkerTransport.js';

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
  private pending = new WorkerRequests<EngineeringWorkerResponse>(120_000, error => this.close(error));
  private abort = () => this.close();
  constructor(private readonly port: EngineeringWorkerPort, private readonly isCurrent: () => boolean,
    private readonly signal?: AbortSignal, private readonly onProgress?:(stage:string,completed:number)=>void) {
    port.onmessage = event => {
      if (!this.isCurrent() || this.signal?.aborted) { this.close(); return; }
      const response = event.data;
      if(response.type==='progress'){
        if(Number.isSafeInteger(response.completed)&&response.completed>0&&this.pending.touch(response.requestId))
          this.onProgress?.(response.stage,response.completed);
        return;
      }
      this.pending.settle(response.requestId, response, response.type === 'error' ? new Error(response.message) : undefined);
    };
    port.onerror = event => this.close(new Error(event.message || 'Engineering worker failed'));
    port.onmessageerror = () => this.close(new Error('Engineering worker returned unreadable data'));
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.close();
  }
  static create(isCurrent: () => boolean, signal?: AbortSignal, onProgress?:(stage:string,completed:number)=>void) {
    return new EngineeringWorkerClient(createMeasuredWorker('engineering', identity => new Worker(measurementWorkerUrl(measuredWorkerAsset,identity), {type:'module',...(identity?{name:identity}:{})})), isCurrent, signal,onProgress);
  }
  close(error: Error = new DOMException('Engineering build cancelled', 'AbortError')): void {
    if (this.closed) return;
    this.closed = true; this.signal?.removeEventListener('abort', this.abort);
    this.port.onmessage = null; this.port.onerror = null; this.port.onmessageerror = null; this.port.terminate();
    this.pending.rejectAll(error);
  }
  private request(command: EngineeringWorkerCommand, transfer: Transferable[] = []): Promise<EngineeringWorkerResponse> {
    if (this.closed || !this.isCurrent() || this.signal?.aborted) { this.close(); return Promise.reject(new DOMException('Engineering build cancelled', 'AbortError')); }
    const requestId = ++this.sequence;
    return this.pending.request(requestId, () => this.port.postMessage({ ...command, requestId }, transfer),
      command.type==='extract'?60_000:120_000);
  }
  async init(scope: string, paths: string[]): Promise<void> { await this.request({ type: 'init', scope, paths }); }
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
  async encodeCache(buildId:number,domain:EngineeringCacheDomain,navigation?:import('../gim/engineering/navigation.js').EngineeringNavigationData):Promise<EngineeringCacheResult>{
    const response=await this.request({type:'encode-cache',buildId,domain,navigation});
    if(response.type!=='cache'||response.result.buildId!==buildId||response.result.domain!==domain)throw Error('Engineering cache response identity mismatch');
    return response.result;
  }
  async assemble(objects: IfcSpatialObject[], models: SpatialModelSummary[], identity?: EngineeringCacheIdentity, nodes: IfcSpatialNode[] = []): Promise<EngineeringBuildResult> {
    const response = await this.request({ type: 'assemble', objects, models, identity, nodes });
    if (response.type !== 'model') throw Error('Engineering model response expected');
    return decodeEngineeringWorkerResult(response.result, () => !this.closed && this.isCurrent() && !this.signal?.aborted);
  }
  async restore(sourceBytes: Uint8Array, entityBytes: Uint8Array | undefined, identity: EngineeringCacheIdentity, navigationBytes?: Uint8Array): Promise<EngineeringBuildResult> {
    const transfer = [sourceBytes.buffer as ArrayBuffer]; if (entityBytes) transfer.push(entityBytes.buffer as ArrayBuffer);
    if (navigationBytes) transfer.push(navigationBytes.buffer as ArrayBuffer);
    const response = await this.request({ type: 'restore', sourceBytes, entityBytes, navigationBytes, identity }, [...new Set(transfer)]);
    if (response.type !== 'model') throw Error('Engineering model response expected');
    return decodeEngineeringWorkerResult(response.result, () => !this.closed && this.isCurrent() && !this.signal?.aborted);
  }
}
