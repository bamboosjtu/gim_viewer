import type { AppState } from '../../app/state.js';
export function viewerToolContext(state: AppState) {
  return {
    hasModel:
      state.currentProjectType === 'substation' ||
      state.currentProjectType === 'equipment' ||
      state.ifc.loadedModels.size > 0,
    lineProject: state.currentProjectType === 'transmission_line',
    canIsolate: state.selection.canIsolateSelection,
    onlySelected: state.selection.onlySelected,
    canGoBack: !!state.viewState.viewHistory?.canGoBack,
  };
}
