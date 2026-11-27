import type { ProjectLoadSession } from './projectSession.js';
import type { Material, Mesh, Object3D } from 'three';

export interface ModHighlightState {
  groups: Object3D[];
  originalMaterials: Map<Mesh, Material | Material[]>;
}

/** Renderer-facing view of the session's selection owner. */
export interface ViewerSelectionState {
  onlySelected: boolean;
  hoverCleanup: (() => void) | null;
  selectionDecorationCleanup: (() => void) | null;
  selectionVisibility: SelectionVisibilityController | null;
  selectionHighlightRequestId: number | null;
  highlightedItems: Readonly<Record<string, Iterable<number>>> | null;
  highlightedModState: ModHighlightState | null;
  representationSelection:
    import('./representationSelection.js').RepresentationSelectionScope | null;
  selectionRequest: SelectionRequest | null;
  beginSelection(
    target: SelectionRequest['target'],
    origin?: SelectionRequest['origin'],
  ): SelectionRequest;
  isCurrentSelection(request: SelectionRequest): boolean;
  canAutoLocate(request: SelectionRequest): boolean;
  selectionGuard(request: SelectionRequest): SelectionCommitGuard;
}
/** Runtime-only user intent; it never invalidates the geometry batch or cache. */
export interface SelectionRequest {
  origin?: 'tree' | 'viewport' | 'command';
  cameraNavigationVersion?: number;
  id: number;
  session: ProjectLoadSession;
  signal: AbortSignal;
  target: {
    kind:
      | 'cbm'
      | 'spatial-node'
      | 'ifc-object'
      | 'ifc-element'
      | 'sld'
      | 'engineering'
      | 'engineering-source'
      | 'engineering-group';
    key: string;
  } | null;
}

export interface EngineeringSelectionScope {
  requestId: number;
  snapshot: import('../engineering/types.js').EngineeringSnapshot;
  ownerIds: Set<string>;
  sourceIds: Set<string>;
  devRoots: Set<string>;
  ifc: Array<{ modelId: string; expressId: number; globalId: string }>;
}

export interface SelectionCommitGuard {
  isCurrent: () => boolean;
  isSessionCurrent: () => boolean;
  signal?: AbortSignal;
}

export interface SelectionGeometryState {
  status:
    | 'not-loaded'
    | 'unknown'
    | 'available'
    | 'renderable'
    | 'empty'
    | 'unsupported'
    | 'partial'
    | 'failed'
    | 'unlinked'
    | 'ambiguous'
    | 'file-only'
    | 'unassociated';
  detail: string;
}

export interface SubstationFineQueue {
  isPreparingDevGeometry?(): boolean;
  enqueueUserIfcFine(
    key: string,
    run: () => Promise<void>,
  ): { promise: Promise<void>; cancel: () => boolean };
}

/** Renderer visibility adapter owned by the active selection session. */
export interface SelectionVisibilityController {
  registerModel(
    id: string,
    model: import('../viewer/ifcModelVisibility.js').IfcVisibilityModel,
  ): import('../viewer/ifcModelVisibility.js').IfcModelVisibility;
  removeModel(id: string, runtimeId: string): void;
  setModelVisible(id: string, visible: boolean): void;
  sync(guard?: SelectionCommitGuard): Promise<void>;
  reset(): void;
}
