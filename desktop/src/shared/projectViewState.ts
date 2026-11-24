import type { ViewerViewHistory } from '../viewer/viewHistory.js';

export class ProjectViewState {
  viewHistory:
    | (Pick<
        ViewerViewHistory,
        'back' | 'canGoBack' | 'clear' | 'dispose' | 'interruptRestore' | 'recordVisibility'
      > &
        Partial<Pick<ViewerViewHistory, 'suspend' | 'resume' | 'flush'>>)
    | null = null;
  stationOverview: (() => void) | null = null;
  engineeringNavigationCleanup: (() => void) | null = null;

  releaseNavigation(): void {
    const dispose = this.engineeringNavigationCleanup;
    this.engineeringNavigationCleanup = null;
    dispose?.();
  }
  hasFittedCamera = false;
  viewerUserInteracted = false;
  // Window-monotonic: a project reset must not revive an earlier camera intent.
  cameraNavigationVersion = 0;
  mode: 'composition' | 'source' | 'inventory' = 'inventory';
  expanded = {
    composition: new Set<string>(),
    source: new Set<string>(),
    inventory: new Set<string>(),
  };
  reset(): void {
    this.hasFittedCamera = false;
    this.viewerUserInteracted = false;
    this.mode = 'inventory';
    this.expanded = { composition: new Set(), source: new Set(), inventory: new Set() };
  }
}
