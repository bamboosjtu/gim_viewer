import type { ProjectLoadSession } from './projectSession.js';
/** Runtime-only user intent; it never invalidates the geometry batch or cache. */
export interface SelectionRequest {
  origin?: 'tree' | 'viewport' | 'command';
  cameraNavigationVersion?: number;
  id: number;
  session: ProjectLoadSession;
  signal: AbortSignal;
  target: { kind: 'cbm' | 'spatial-node' | 'ifc-object' | 'ifc-element' | 'sld' | 'engineering' | 'engineering-source' | 'engineering-group'; key: string } | null;
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
  evidence?:import('../engineering/representations.js').RepresentationEvidenceState;
  status: 'not-loaded' | 'unknown' | 'available' | 'renderable' | 'empty' | 'unsupported' | 'partial' | 'failed' | 'unlinked' | 'ambiguous' | 'file-only' | 'unassociated';
  detail: string;
}


export interface SubstationFineQueue {
  enqueueUserIfcFine(key: string, run: () => Promise<void>): { promise: Promise<void>; cancel: () => boolean };
}

