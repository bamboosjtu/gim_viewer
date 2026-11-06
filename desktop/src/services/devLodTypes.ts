/** Internal DEV LOD cache/template contracts shared by the session owners. */
import type { DevSpatialOccurrence } from './devSpatialCatalog.js';
import type { DevArtifactReadStatus } from '@desktop/devLodCache.js';
import type * as THREE from 'three';
import type { PerfTaskIdentity } from '../utils/perfTimings.js';
import type { DeviceLod } from '../viewer/devLodPolicy.js';
import type { DevGlbTemplate } from './devGlbTemplateRuntime.js';
import type { DevGlbSerializationResult } from './glbCacheService.js';

export interface CachedTemplate {
  result: DevGlbSerializationResult;
  sha: string;
  sourceInvalid?: {
    message: string;
    evidence: string;
  };
}

export interface TemplateRow {
  bounds: THREE.Box3;
  template: DevGlbTemplate;
  sha: string;
  status: DevGlbSerializationResult['status'];
  diagnostics: DevGlbSerializationResult['diagnostics'];
  task?: PerfTaskIdentity;
}

export interface CacheDecision {
  key: string;
  devPath: string;
  lod: DeviceLod;
  status: DevArtifactReadStatus | 'compiled' | 'write-failed';
  reason?: string;
}

export type MemoryPressure = 'unknown' | 'normal' | 'high' | 'critical';

export interface Occurrence {
  entry: DevSpatialOccurrence;
  inView: boolean;
  box: THREE.Box3 | null;
  pickBounds?: THREE.Box3;
  pickLocalBounds?: THREE.Box3;
  desired: DeviceLod | null;
  browseDesired: DeviceLod | null;
  displayed: DeviceLod;
  geometryStatus?: DevGlbSerializationResult['status'];
  group?: THREE.Group;
  key?: string;
  failedKey?: string;
}
