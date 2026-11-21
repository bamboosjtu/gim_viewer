import type { Material, Mesh, Object3D } from 'three';
import type { ProjectLoadSession } from './projectSession.js';
import type {
  SelectionRequest,
  EngineeringSelectionScope,
  SelectionCommitGuard,
  SelectionGeometryState,
  SelectionVisibilityController,
} from './selectionContracts.js';
import type { DeviceRuntime } from './deviceRuntime.js';
import type { IfcRegionalRuntime } from '../viewer/ifcRegionalRuntime.js';
import type { EngineeringSnapshot } from '../engineering/types.js';
import { logger } from '../utils/logger.js';
import { reportBackgroundError } from '../utils/backgroundErrors.js';
interface SelectionHost {
  captureSession(): ProjectLoadSession;
  isCurrentSession(session: ProjectLoadSession): boolean;
  cameraNavigationVersion(): number;
  snapshot(): EngineeringSnapshot | null;
  deviceRuntime(): DeviceRuntime | null;
  runtimes(): Iterable<IfcRegionalRuntime>;
  applyGeometryFilter(): void;
  recordVisibility(): void;
}
/** User selection owns cancellation and feedback independently of project source data. */
export class ProjectSelectionState {
  constructor(private readonly host: SelectionHost) {}
  onlySelected = false;
  autoLocate = true;
  hoverCleanup: (() => void) | null = null;
  selectionDecorationCleanup: (() => void) | null = null;
  selectionVisibility: SelectionVisibilityController | null = null;
  selectionHighlightRequestId: number | null = null;
  highlightedItems: Readonly<Record<string, Iterable<number>>> | null = null;
  highlightedModState: {
    groups: Object3D[];
    originalMaterials: Map<Mesh, Material | Material[]>;
  } | null = null;

  /** The Viewer restores and disposes material clones before project reset. */
  resetHighlightState(): void {
    this.highlightedItems = null;
    this.highlightedModState = null;
  }

  engineeringSelection: EngineeringSelectionScope | null = null;
  representationSelection:
    import('../shared/representationSelection.js').RepresentationSelectionScope | null = null;
  engineeringSelectionCleanup: (() => void) | null = null;
  selectionRequest: SelectionRequest | null = null;
  selectionGeometry: SelectionGeometryState | null = null;
  selectionMessage = '';
  private selectionSequence = 0;
  private selectionAbort: AbortController | null = null;
  beginSelection(
    target: SelectionRequest['target'],
    origin: SelectionRequest['origin'] = 'tree',
  ): SelectionRequest {
    this.hoverCleanup?.();
    this.selectionAbort?.abort();
    // While a new target is resolving, the previous isolated range remains
    // visible. Its request is obsolete, so it cannot publish any late results.
    const retainRange = this.onlySelected && target !== null;
    if (!retainRange) {
      this.engineeringSelection = null;
      this.representationSelection = null;
      this.host.applyGeometryFilter();
      this.host.deviceRuntime()?.clearSelection();
      for (const runtime of this.host.runtimes()) {
        runtime.clearFineSelection?.();
        runtime.clearSelectionFilter?.();
      }
    }
    this.selectionAbort = new AbortController();
    const request: SelectionRequest = {
      id: ++this.selectionSequence,
      session: this.host.captureSession(),
      signal: this.selectionAbort.signal,
      target,
      origin,
      cameraNavigationVersion: this.host.cameraNavigationVersion(),
    };
    this.selectionRequest = request;
    if (!retainRange) {
      this.host.deviceRuntime()?.setOnlySelected?.(this.onlySelected);
      for (const runtime of this.host.runtimes()) runtime.setOnlySelected?.(this.onlySelected);
    }
    this.selectionGeometry = null;
    this.selectionMessage = '';
    return request;
  }
  isCurrentSelection(request: SelectionRequest): boolean {
    return (
      this.selectionRequest?.id === request.id &&
      !request.signal.aborted &&
      this.host.isCurrentSession(request.session)
    );
  }
  canAutoLocate(request: SelectionRequest): boolean {
    return (
      this.autoLocate &&
      request.origin !== 'viewport' &&
      (request.cameraNavigationVersion === undefined ||
        request.cameraNavigationVersion === this.host.cameraNavigationVersion())
    );
  }
  selectionGuard(request: SelectionRequest): SelectionCommitGuard {
    return {
      isCurrent: () => this.isCurrentSelection(request),
      isSessionCurrent: () => this.host.isCurrentSession(request.session),
      signal: request.signal,
    };
  }
  invalidateSelection(): void {
    this.selectionAbort?.abort();
    for (const runtime of this.host.runtimes()) {
      runtime.clearFineSelection?.();
      runtime.clearSelectionFilter?.();
    }
    this.selectionSequence++;
    this.selectionRequest = null;
    this.engineeringSelection = null;
    this.representationSelection = null;
    this.host.applyGeometryFilter();
    this.selectionGeometry = null;
    this.selectionMessage = '';
  }
  get canIsolateSelection(): boolean {
    const request = this.selectionRequest,
      kind = request?.target?.kind;
    if (!request?.target) return false;
    if (kind !== 'engineering' && kind !== 'engineering-source' && kind !== 'engineering-group')
      return true;
    const scope = this.engineeringSelection;
    return (
      !!scope &&
      scope.requestId === request.id &&
      scope.snapshot === this.host.snapshot() &&
      scope.sourceIds.size > 0
    );
  }
  setOnlySelected(only: boolean): void {
    if (only && !this.canIsolateSelection) return;
    this.onlySelected = only;
    this.host.applyGeometryFilter();
    this.host.deviceRuntime()?.setOnlySelected?.(only);
    for (const runtime of this.host.runtimes()) runtime.setOnlySelected?.(only);
    void Promise.resolve(
      this.selectionVisibility
        ?.sync()
        .catch((error) => logger.warn('[Selection visibility]', error)),
    ).catch(reportBackgroundError);
    this.host.recordVisibility();
  }
  releaseDecorations(): void {
    for (const key of [
      'hoverCleanup',
      'selectionDecorationCleanup',
      'engineeringSelectionCleanup',
    ] as const) {
      const cleanup = this[key];
      this[key] = null;
      try {
        cleanup?.();
      } catch (error) {
        logger.error('[Selection] release failed', error);
      }
    }
  }
}
