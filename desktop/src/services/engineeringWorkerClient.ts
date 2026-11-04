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
  private pending = new Map<number, { resolve(value: EngineeringWorkerResponse): void; reject(error: Error): void }>();
  private abort = () => this.close();
  constructor(private readonly port: EngineeringWorkerPort, private readonly isCurrent: () => boolean, private readonly signal?: AbortSignal) {
    port.onmessage = event => {
      if (!this.isCurrent() || this.signal?.aborted) { this.close(); return; }
      const response = event.data, request = this.pending.get(response.requestId);
      if (!request) return;
      this.pending.delete(response.requestId);
      if (response.type === 'error') request.reject(new Error(response.message));
      else request.resolve(response);
    };
    port.onerror = event => this.close(new Error(event.message || 'Engineering worker failed'));
    port.onmessageerror = () => this.close(new Error('Engineering worker returned unreadable data'));
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.close();
  }
  static create(isCurrent: () => boolean, signal?: AbortSignal) {
    return new EngineeringWorkerClient(new Worker(new URL('./engineeringWorker.ts', import.meta.url), { type: 'module' }), isCurrent, signal);
  }
  close(error: Error = new DOMException('Engineering build cancelled', 'AbortError')): void {
    if (this.closed) return;
    this.closed = true; this.signal?.removeEventListener('abort', this.abort);
    this.port.onmessage = null; this.port.onerror = null; this.port.onmessageerror = null; this.port.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  private request(command: EngineeringWorkerCommand, transfer: Transferable[] = []): Promise<EngineeringWorkerResponse> {
    if (this.closed || !this.isCurrent() || this.signal?.aborted) { this.close(); return Promise.reject(new DOMException('Engineering build cancelled', 'AbortError')); }
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try { this.port.postMessage({ ...command, requestId }, transfer); }
      catch (error) { this.pending.delete(requestId); reject(error); }
    });
  }
  async init(scope: string, paths: string[]): Promise<void> { await this.request({ type: 'init', scope, paths }); }
  async addFiles(files: Array<{ path: string; blob?: Blob; bytes?: Uint8Array }>): Promise<void> {
    await this.request({ type: 'files', files }, [...new Set(files.flatMap(f => f.bytes ? [f.bytes.buffer as ArrayBuffer] : []))]);
  }
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
