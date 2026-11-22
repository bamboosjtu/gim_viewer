import type { AppState } from '../../../app/state.js';
import type { SessionScope } from '../../../shared/sessionScope.js';

const presented = new WeakMap<AppState, SessionScope>();

export function isSubstationViewerInteractive(state: AppState): boolean {
  return presented.get(state)?.isCurrent() ?? false;
}

export function setSubstationViewerInteractive(
  state: AppState,
  scope: SessionScope,
  value: boolean,
): void {
  if (!scope.isCurrent()) return;
  if (value) presented.set(state, scope);
  else presented.delete(state);
}
