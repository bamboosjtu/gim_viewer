import type { AppState, SelectionRequest } from '../../app/state.js';
import { setSelectionStatus } from '../presentation/shell_statusBar.js';

/** Selection feedback owns no project loading progress or busy task. A caller
 * may carry an opening callback, but it must never receive browsing messages. */
export function selectionMessage(state: AppState, request: SelectionRequest) {
  return (text: string): void => {
    if (!state.selection.isCurrentSelection(request)) return;
    state.selection.selectionMessage = text;
    setSelectionStatus(text);
  };
}
