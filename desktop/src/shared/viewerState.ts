import type { SubstationFineQueue } from './selectionContracts.js';
import type { ProjectSelectionState } from './projectSelectionState.js';
import type { IfcRuntimeState } from './ifcRuntimeState.js';
import type * as THREE from 'three';

import type { ProjectLoadSession } from './projectSession.js';

export interface ViewerState {
  selection: Pick<
    ProjectSelectionState,
    | 'onlySelected'
    | 'hoverCleanup'
    | 'selectionDecorationCleanup'
    | 'selectionVisibility'
    | 'selectionHighlightRequestId'
    | 'highlightedItems'
    | 'highlightedModState'
    | 'representationSelection'
    | 'selectionRequest'
    | 'beginSelection'
    | 'isCurrentSelection'
    | 'canAutoLocate'
    | 'selectionGuard'
  >;
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
    pick?(ray: THREE.Raycaster): {
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
