import type { AppState, SelectionRequest } from '../app/state.js';
import { perfBegin } from '../utils/perfTimings.js';

/** Selection wall times share the existing bounded, session-owned profiler.
 * Overlapping stages must not be summed or described as CPU/GPU time. */
export function beginSelectionStage(state: AppState, request: SelectionRequest,
  stage: 'navigation' | 'propertySummary' | 'propertyParams' | 'collectGroups' | 'highlightCommit' | 'frame') {
  const meta = {selectionId:request.id,selectionKind:request.target?.kind,sourcePath:request.target?.key};
  const end = perfBegin(`selection.${stage}`, meta);
  let ended = false;
  return (): void => {
    if (ended) return; ended = true;
    end(undefined, {...meta, current:state.isCurrentSelection(request), cancelled:request.signal.aborted});
  };
}
