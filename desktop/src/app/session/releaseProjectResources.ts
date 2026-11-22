import type { AppState } from '../state.js';
import { reportProjectReleaseError } from './projectSessionState.js';

/** Release each registered owner in scene dependency order. An owner may
 * synchronously trigger another project transition during its disposer. */
export function releaseProjectResources(state: AppState, stillClosing: () => boolean): void {
  const steps = [
    () => state.selection.releaseDecorations(stillClosing),
    () => state.viewState.releaseNavigation(),
    () => state.engineering.release(),
    () => {
      state.deviceLodRuntime = null;
    },
    () => {
      const monitor = state.substationResourceMonitor;
      state.substationResourceMonitor = null;
      monitor?.release();
    },
    () => {
      const preview = state.substationConnectionPreview;
      state.substationConnectionPreview = null;
      preview?.release();
    },
    () => {
      state.substationMemoryPressure = 'unknown';
      state.substationFineQueue = null;
      state.substationConnectionPorts = null;
    },
    () => state.viewState.viewHistory?.clear(),
    () => {
      state.viewState.stationOverview = null;
      state.selection.onlySelected = false;
    },
    () => state.selection.invalidateSelection(),
    () => state.ifc.releaseRuntimes(),
    () => state.selection.selectionVisibility?.reset(),
    () => {
      state.selection.selectionHighlightRequestId = null;
    },
  ];
  for (const release of steps) {
    if (!stillClosing()) return;
    try {
      release();
    } catch (error) {
      reportProjectReleaseError(error);
    }
  }
}
