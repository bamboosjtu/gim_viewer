import type { EngineeringBuildResult } from './engineeringWorkerProtocol.js';
import { engineeringNavigationFromWire, engineeringNavigationToWire } from './engineeringNavigationCache.js';
import { packEngineeringSource, unpackEngineeringSourceAsync } from './engineeringSourceCodec.js';

export interface EngineeringWorkerPayload {
  encoding: 'engineering-worker-table-v2';
  body: Uint8Array;
  metrics?: EngineeringBuildResult['metrics'];
}
export const MAX_ENGINEERING_TRANSPORT_BYTES = 384 * 1024 * 1024;

/** Runtime transport is independent from persisted cache versions. Repeated
 * immutable source facts and long identities occur once in the table. Only
 * owned byte buffers cross the Worker boundary; raw graph clones do not. */
export function encodeEngineeringWorkerResult(result: EngineeringBuildResult): EngineeringWorkerPayload {
  const started=performance.now();
  const { navigation, ...data } = result;
  const body = new TextEncoder().encode(JSON.stringify(packEngineeringSource({ ...data, navigation: engineeringNavigationToWire(navigation) })));
  if (body.byteLength > MAX_ENGINEERING_TRANSPORT_BYTES) throw Error('工程来源传输超过容量上限');
  // Metrics are small transport metadata, never a second model/cache body.
  return { encoding: 'engineering-worker-table-v2', body, metrics:{buildMs:result.metrics?.buildMs??0,transportEncodeMs:performance.now()-started,transportBytes:body.byteLength} };
}

export function engineeringWorkerResultTransfers(payload: EngineeringWorkerPayload): ArrayBuffer[] {
  return [payload.body.buffer as ArrayBuffer];
}

export async function decodeEngineeringWorkerResult(payload: EngineeringWorkerPayload, isCurrent: () => boolean): Promise<EngineeringBuildResult> {
  const started=performance.now();
  if (!isCurrent()) throw new DOMException('Engineering hydration cancelled', 'AbortError');
  if (payload.encoding !== 'engineering-worker-table-v2' || !(payload.body instanceof Uint8Array)
    || !payload.body.byteLength || payload.body.byteLength > MAX_ENGINEERING_TRANSPORT_BYTES) throw Error('工程来源传输无效');
  const table: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload.body));
  const data = await unpackEngineeringSourceAsync(table, isCurrent) as Omit<EngineeringBuildResult, 'navigation'> & { navigation: unknown };
  const navigation = engineeringNavigationFromWire(data.navigation, data.sources, data.snapshot);
  if (!isCurrent()) throw new DOMException('Engineering hydration cancelled', 'AbortError');
  return { ...data, navigation, metrics:payload.metrics?{...payload.metrics,hydrateMs:performance.now()-started}:undefined };
}
