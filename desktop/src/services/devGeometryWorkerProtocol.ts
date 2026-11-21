import type { GeometryFailureKind } from '../gim/geometry/sourceGeometryError.js';
import type { TraceContext } from '../measurement/core.js';
import type { DeviceLod } from '../viewer/xmlModGeometry.js';
import type { DevSourceBounds } from './devSpatialCatalog.js';
import type { DevGlbSerializationResult } from './glbCacheService.js';
import type { DiscoveredGeometries } from './modGeometryDiscovery.js';

export interface DevGeometryWorkerPartition {
  referencePaths: readonly string[];
  canonicalDevPath: string;
  discovered: DiscoveredGeometries;
  maxBytes: number;
  allowSmallFallback?: boolean;
  rootSlice?: { index: number; total: number };
}

interface TaskAddress {
  id: number;
  session: number;
  key: string;
  path: string;
}

type TaskRequest = TaskAddress & {
  traceId: string;
  lod: DeviceLod;
  parentTaskId?: string;
  _gimMeasurementContext?: TraceContext;
} & (
    | { kind: 'bounds' }
    | { kind: 'compile'; noSplit?: boolean; partition?: DevGeometryWorkerPartition }
    | { kind: 'merge'; parts: Uint8Array[] }
  );

type FileRow<T extends File | null> = [path: string, size: number, blob: T];

export type DevGeometryWorkerRequest =
  | TaskRequest
  | { kind: 'init'; cacheDivisor: number; files: FileRow<File | null>[] }
  | { kind: 'sources'; files: FileRow<File>[] }
  | ({ kind: 'read-result'; id: number } & (
      { bytes: ArrayBuffer; error?: never } | { error: string; bytes?: never }
    ));

export type DevGeometryWorkerResult = DevSourceBounds | DevGlbSerializationResult;

export type DevGeometryWorkerCompletion = TaskAddress & {
  kind: 'result';
  wallMs?: number;
  stages?: Record<string, number>;
} & (
    | { result: DevGeometryWorkerResult; error?: never }
    | {
        error: string;
        result?: never;
        sourceErrorKind?: GeometryFailureKind;
        sourceEvidence?: string;
      }
  );

export type DevGeometryWorkerReply =
  { kind: 'read'; id: number; path: string } | DevGeometryWorkerCompletion;

export function isDevGeometryMessage(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

// Check the payload discriminant and buffer before handing off worker output.
// Nested geometry and source diagnostics already belong to the producing worker.
export function isDevGeometryWorkerCompletion(
  value: Record<string, unknown>,
): value is Record<string, unknown> & DevGeometryWorkerCompletion {
  if (
    value.kind !== 'result' ||
    typeof value.id !== 'number' ||
    typeof value.session !== 'number' ||
    typeof value.key !== 'string' ||
    typeof value.path !== 'string'
  )
    return false;
  if (typeof value.error === 'string') return value.result === undefined;
  if (value.error !== undefined || !isDevGeometryMessage(value.result)) return false;
  return 'boundsQuality' in value.result
    ? ['conservative', 'unknown', 'empty'].includes(String(value.result.boundsQuality))
    : (value.result.bytes === null || value.result.bytes instanceof Uint8Array) &&
        isDevGeometryMessage(value.result.diagnostics);
}
