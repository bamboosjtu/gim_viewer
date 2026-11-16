import {projectPresentation} from './projectPresentationPort.js';
import type { AppState } from '../app/state.js';

/** Explicit clearing leaves isolation before invalidating its selected range. */
export async function clearCurrentSelection(state: AppState): Promise<void> {
  state.setOnlySelected(false);
  const request = state.beginSelection(null, 'command'), guard = state.selectionGuard(request);
  if (state.initialized) {
    const [{ getViewerRuntimeWithUI }, { commitSelectionHighlight }] = await Promise.all([import('./viewerUIBinding.js'), import('../viewer/highlight.js')]);
    if (!guard.isCurrent()) return;
    const { ctx } = await getViewerRuntimeWithUI(state); if (!guard.isCurrent()) return;
    await commitSelectionHighlight(ctx, state, guard);
  }
  if (!guard.isCurrent()) return;
  const { syncSelectionNavigation } = await import('./nodeInteractionService.js');
  await syncSelectionNavigation(state, request);
  if (!guard.isCurrent()) return;
  projectPresentation().clearSelection();
}
