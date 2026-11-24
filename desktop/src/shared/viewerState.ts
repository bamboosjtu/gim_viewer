import type { SubstationFineQueue, ViewerSelectionState } from './selectionContracts.js';
import type { IfcRuntimeState } from './ifcRuntimeState.js';
import type { DeviceRuntime } from './deviceRuntime.js';

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
  deviceLodRuntime: DeviceRuntime | null;
  captureProjectSession: () => ProjectLoadSession;
  isCurrentSession: (session: ProjectLoadSession) => boolean;
  initialized: boolean;
  eventsRegistered: boolean;
}
