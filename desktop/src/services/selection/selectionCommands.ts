import { projectPresentation } from '../presentation/projectPresentationPort.js';
import type { AppState } from '../../app/state.js';

/** Explicit clearing leaves isolation before invalidating its selected range. */
export async function clearCurrentSelection(state: AppState): Promise<void> {
  state.selection.setOnlySelected(false);
  const request = state.selection.beginSelection(null, 'command'),
    guard = state.selection.selectionGuard(request);
  if (state.initialized) {
    const [{ getViewerRuntimeWithUI }, { commitSelectionHighlight }] = await Promise.all([
      import('../presentation/viewerUIBinding.js'),
      import('../../viewer/highlight.js'),
    ]);
    if (!guard.isCurrent()) return;
    const { ctx } = await getViewerRuntimeWithUI(state);
    if (!guard.isCurrent()) return;
    await commitSelectionHighlight(ctx, state, guard);
  }
  if (!guard.isCurrent()) return;
  const { syncSelectionNavigation } = await import('./selectionNavigation.js');
  await syncSelectionNavigation(state, request);
  if (!guard.isCurrent()) return;
  projectPresentation().clearSelection();
}
