import type * as THREE from 'three';
export interface DevBaseEvidence {
  id: string;
  sha: string;
  bounds: number[];
  matrix: number[];
  status: string;
  simplifiedBooleans?: number;
}
export type DeviceRuntime = {
  select(rootOccurrence: string): Promise<THREE.Group[]>;
  ensureBase?(rootOccurrence: string): Promise<THREE.Group[]>;
  retry?(rootOccurrence: string): Promise<THREE.Group[]>;
  refine?(rootOccurrence: string): Promise<THREE.Group[]>;
  releaseFine?(rootOccurrence: string): void;
  setOnlySelected?(only: boolean): void;
  patrolDirectory?(
    signal: AbortSignal,
  ): Promise<import('../viewer/patrol/navigationQueryPort.js').PatrolDirectory>;
  release(): void;
  clearSelection(): void;
  notifyCoordinateAnchor?(): void;
  getLoadedRoot?(rootOccurrence: string): THREE.Group | undefined;
  setBackgroundPaused?(paused: boolean): void;
  pick?(
    ray: THREE.Raycaster,
    accepts?: (point: THREE.Vector3) => boolean,
  ): {
    point?: THREE.Vector3;
    rootOccurrence: string;
    instanceKey: string;
    distance: number;
    object?: THREE.Object3D;
    hint?: import('../engineering/representations.js').DevRepresentationHint;
  } | null;
  setExternalMemoryPressure?(pressure: 'unknown' | 'normal' | 'high' | 'critical'): void;
  resourceCounts?(): {
    templateCount: number;
    templateParseCount: number;
    sharedGeometryCount: number;
    sharedMaterialCount: number;
    sharedTextureCount: number;
  };
  forEachLoadedRoot?(visit: (occurrence: string, root: THREE.Group, lod: number) => void): void;
  baseRepresentationEvidence?(): readonly DevBaseEvidence[];
  catalogMissSources?(): readonly string[];
  diagnostics: Record<string, unknown>;
};
