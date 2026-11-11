import type { EngineeringSources } from '../gim/engineering/buildSources.js';
import type { EngineeringSnapshot } from '../engineering/types.js';
import type { IfcSpatialObject, IfcSpatialNode, SpatialModelSummary } from '../gim/ifcSpatialParser.js';
import type { EngineeringNavigationData } from '../gim/engineering/navigation.js';
import type { SourceGeometryOccurrenceCatalog } from '../gim/engineering/geometryOccurrences.js';
import type { EngineeringCacheIdentity } from './engineeringCacheCodec.js';
import type { EngineeringWorkerPayload } from './engineeringWorkerTransport.js';

export interface EngineeringExtractSummary { ifcPaths: string[]; sourceRecords: number }
export const ENGINEERING_SOURCE_BATCH_BYTES=8*1024*1024;
export const ENGINEERING_SOURCE_BATCH_FILES=256;
/** A bounded immutable carrier; offsets describe original file bytes, not text characters. */
export interface EngineeringSourceBatch {
  blob: Blob;
  entries: Array<{path:string;offset:number;length:number}>;
}
export type EngineeringCacheDomain = 'sources' | 'entities' | 'navigation';
export interface EngineeringCacheResult {
  buildId: number;
  domain: EngineeringCacheDomain;
  bytes?: Uint8Array;
  error?: string;
  disabled?: string;
  metrics: { encodeMs: number; plainBytes: number; encodedBytes: number };
}

export interface EngineeringBuildResult {
  sources: EngineeringSources;
  snapshot: EngineeringSnapshot;
  navigation: EngineeringNavigationData;
  geometryOccurrences: SourceGeometryOccurrenceCatalog;
  navigationCacheHit?: boolean;
  entityCacheHit?: boolean;
  buildId?: number;
  cachePlan?: EngineeringCacheDomain[];
  metrics?: { buildMs: number; transportEncodeMs: number; transportBytes: number; hydrateMs?: number };
  cacheError?: string;
  /** Set when a complete source/entity body exceeds the cache budget. The
   * snapshot remains usable; persistence is explicitly disabled, not partial. */
  cacheDisabled?: string;
}
export type EngineeringWorkerCommand =
  | { type: 'init'; scope: string; paths: string[] }
  | { type: 'files'; files: Array<{ path: string; blob?: Blob; bytes?: Uint8Array }> }
  | { type: 'packed-files'; batch: EngineeringSourceBatch }
  | { type: 'extract' }
  | { type: 'encode-cache'; buildId: number; domain: EngineeringCacheDomain; navigation?: EngineeringNavigationData }
  | { type: 'assemble'; objects: IfcSpatialObject[]; models: SpatialModelSummary[]; nodes?: IfcSpatialNode[]; identity?: EngineeringCacheIdentity }
  | { type: 'restore'; sourceBytes: Uint8Array; entityBytes?: Uint8Array; navigationBytes?: Uint8Array; identity: EngineeringCacheIdentity };
export type EngineeringWorkerRequest = EngineeringWorkerCommand & { requestId: number };
export type EngineeringWorkerReply =
  | { type: 'ready' }
  | { type: 'progress'; stage: 'source-index'|'source-traverse'|'source-sort'; completed: number }
  | { type: 'graph'; summary: EngineeringExtractSummary; geometryOccurrences: SourceGeometryOccurrenceCatalog }
  | { type: 'model'; result: EngineeringWorkerPayload }
  | { type: 'cache'; result: EngineeringCacheResult }
  | { type: 'error'; message: string };
export type EngineeringWorkerResponse = EngineeringWorkerReply & { requestId: number };
