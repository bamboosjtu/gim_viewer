import type * as THREE from 'three';
export type DeviceRuntime = { select(rootOccurrence: string): Promise<THREE.Group[]>; ensureBase?(rootOccurrence: string): Promise<THREE.Group[]>; retry?(rootOccurrence: string): Promise<THREE.Group[]>; refine?(rootOccurrence: string): Promise<THREE.Group[]>; releaseFine?(rootOccurrence: string): void; setOnlySelected?(only: boolean): void; release(): void; clearSelection(): void; notifyCoordinateAnchor?(): void;
    getLoadedRoot?(rootOccurrence: string): THREE.Group | undefined;
    setBackgroundPaused?(paused: boolean): void;
    pick?(ray: THREE.Raycaster): {rootOccurrence: string; instanceKey: string; distance: number; object?: THREE.Object3D; hint?: import('../engineering/representations.js').DevRepresentationHint} | null;
    setExternalMemoryPressure?(pressure: 'unknown' | 'normal' | 'high' | 'critical'): void;
    resourceCounts?(): { templateCount: number; templateParseCount: number; sharedGeometryCount: number; sharedMaterialCount: number; sharedTextureCount: number };
    diagnostics: Record<string, unknown> };
