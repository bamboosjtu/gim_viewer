export class ProjectViewState {
  viewHistory: import('../viewer/viewHistory.js').ViewerViewHistory | null = null;
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
