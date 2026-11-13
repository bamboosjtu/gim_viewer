import type { EngineeringBuildResult } from './engineeringWorkerProtocol.js';
import { engineeringNavigationFromWire, engineeringNavigationToWire } from './engineeringNavigationCache.js';
import { packEngineeringSource, unpackEngineeringSourceAsync } from './engineeringSourceCodec.js';
import type {EngineeringSourceGraph} from '../gim/engineering/sourceGraph.js';
export interface TransportGraphCache {scope?:string;revision?:number;graph?:EngineeringSourceGraph}

export interface EngineeringWorkerPayload {
  graphFrame?:{scope:string;revision:number;reference:boolean};
  encoding: 'engineering-worker-table-v3';
  body: Uint8Array;
  metrics?: EngineeringBuildResult['metrics'];
}
export const MAX_ENGINEERING_TRANSPORT_BYTES = 384 * 1024 * 1024;

/** Runtime transport is independent from persisted cache versions. Repeated
 * immutable source facts and long identities occur once in the table. Only
 * owned byte buffers cross the Worker boundary; raw graph clones do not. */
export function encodeEngineeringWorkerResult(result: EngineeringBuildResult,cache?:TransportGraphCache): EngineeringWorkerPayload {
  const started=performance.now();
  const { navigation, ...data } = result;
  const graph=result.sources.graph,revision=graph.revision??0,scope=result.snapshot.scope;
  const reference=!!cache&&cache.scope===scope&&cache.graph===graph&&cache.revision===revision;
  const sources=reference?{...data.sources,graph:undefined}:data.sources;
  const body = new TextEncoder().encode(JSON.stringify(packEngineeringSource({ ...data,sources, navigation: engineeringNavigationToWire(navigation) })));
  if (body.byteLength > MAX_ENGINEERING_TRANSPORT_BYTES) throw Error('工程来源传输超过容量上限');
  // Metrics are small transport metadata, never a second model/cache body.
  if(cache){cache.scope=scope;cache.revision=revision;cache.graph=graph;}
  return { encoding: 'engineering-worker-table-v3', body,...(cache?{graphFrame:{scope,revision,reference}}:{}), metrics:{buildMs:result.metrics?.buildMs??0,transportEncodeMs:performance.now()-started,transportBytes:body.byteLength} };
}

export function engineeringWorkerResultTransfers(payload: EngineeringWorkerPayload): ArrayBuffer[] {
  return [payload.body.buffer as ArrayBuffer];
}

export async function decodeEngineeringWorkerResult(payload: EngineeringWorkerPayload, isCurrent: () => boolean,cache?:TransportGraphCache): Promise<EngineeringBuildResult> {
  const started=performance.now();
  if (!isCurrent()) throw new DOMException('Engineering hydration cancelled', 'AbortError');
  if (payload.encoding !== 'engineering-worker-table-v3' || !(payload.body instanceof Uint8Array)
    || !payload.body.byteLength || payload.body.byteLength > MAX_ENGINEERING_TRANSPORT_BYTES) throw Error('工程来源传输无效');
  const table: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload.body));
  const data = await unpackEngineeringSourceAsync(table, isCurrent) as Omit<EngineeringBuildResult, 'navigation'> & { navigation: unknown };
  if(payload.graphFrame){
    const frame=payload.graphFrame;
    if(!Number.isSafeInteger(frame.revision)||frame.revision<0||typeof frame.reference!=='boolean'||frame.scope!==data.snapshot.scope)throw Error('Engineering graph frame scope mismatch');
    if(frame.reference){if(!cache?.graph||cache.scope!==frame.scope||cache.revision!==frame.revision)throw Error('Engineering graph reference unavailable');data.sources={...data.sources,graph:cache.graph};}
    else{if((data.sources.graph?.revision??0)!==frame.revision)throw Error('Engineering graph revision mismatch');if(cache){cache.scope=frame.scope;cache.revision=frame.revision;cache.graph=data.sources.graph;}}
  }
  const navigation = engineeringNavigationFromWire(data.navigation, data.sources, data.snapshot, true);
  if (!isCurrent()) throw new DOMException('Engineering hydration cancelled', 'AbortError');
  return { ...data, navigation, metrics:payload.metrics?{...payload.metrics,hydrateMs:performance.now()-started}:undefined };
}
