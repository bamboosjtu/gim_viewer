import type { AppState } from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';

/** Application commands describe intent; UI owns elements, markup and listeners. */
export interface ProjectPresentation {
  refreshDeviceBounds(state: AppState, current: () => boolean): Promise<void>;
  renderNavigation(
    state: AppState,
    select: (node: CbmNode) => void,
    current: () => boolean,
  ): Promise<void>;
  resetIdentity(current: () => boolean): Promise<void>;
  clearProjectViews(current: () => boolean): Promise<void>;
  clearSelection(): void;
  hideEmptyState(): void;
  expandedTreePaths(): string[];
  restoreExpandedTree(paths: readonly string[], current: () => boolean): Promise<void>;
  removeModelRows(modelIds: readonly string[]): void;
  geometryFeedback(detail: string, fitWhole?: boolean): void;
  chooseEngineeringRange(
    detail: string,
    choices: { label: string; choose: () => void }[],
    current: () => boolean,
  ): Promise<void>;
}
let presentation: ProjectPresentation;
export function bindProjectPresentation(port: ProjectPresentation): void {
  presentation = port;
}
export function projectPresentation(): ProjectPresentation {
  if (!presentation) throw Error('Project presentation is not configured');
  return presentation;
}
