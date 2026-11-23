import type { SubstationFineQueue, ViewerSelectionState } from './selectionContracts.js';
import type { IfcRuntimeState } from './ifcRuntimeState.js';
import type * as THREE from 'three';

import type { ProjectLoadSession } from './projectSession.js';

export interface ViewerState {
  toolModelChanged?: (id?: string) => void;
  selection: ViewerSelectionState;
  ifc: Pick<
    IfcRuntimeState,
    | 'runtimeModelIds'
    | 'logicalModelIds'
    | 'modelOwners'
    | 'loadedModels'
    | 'regionalRuntimes'
    | 'getRuntimeModelId'
    | 'registerIfcRuntimeModel'
    | 'resolveLogicalModelId'
    | 'isCurrentRuntimeModel'
    | 'remove'
  >;
  viewState: Pick<
    import('./projectViewState.js').ProjectViewState,
    'viewHistory' | 'hasFittedCamera' | 'viewerUserInteracted' | 'cameraNavigationVersion'
  >;
  substationFineQueue: SubstationFineQueue | null;
  substationMemoryPressure: import('../utils/memoryPressure.js').MemoryPressure;
  engineeringGeometryEvidenceChanged: (() => void) | null;
  deviceLodRuntime: {
    select(rootOccurrence: string): Promise<THREE.Group[]>;
    ensureBase?(rootOccurrence: string): Promise<THREE.Group[]>;
    retry?(rootOccurrence: string): Promise<THREE.Group[]>;
    refine?(rootOccurrence: string): Promise<THREE.Group[]>;
    releaseFine?(rootOccurrence: string): void;
    setOnlySelected?(only: boolean): void;
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
    diagnostics: Record<string, unknown>;
  } | null;
  captureProjectSession: () => ProjectLoadSession;
  isCurrentSession: (session: ProjectLoadSession) => boolean;
  initialized: boolean;
  eventsRegistered: boolean;
}
