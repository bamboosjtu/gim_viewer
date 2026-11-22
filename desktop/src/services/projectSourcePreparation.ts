import type { AppState } from '../app/state.js';

/** Read-only availability query for shared selection and geometry consumers. */
export interface ProjectSourcePreparation {
  current: () => boolean;
  complete: boolean;
  error?: string;
}

const preparation = new WeakMap<AppState, ProjectSourcePreparation>();

export function setProjectSourcePreparation(
  state: AppState,
  status?: ProjectSourcePreparation,
): void {
  if (status) preparation.set(state, status);
  else preparation.delete(state);
}

export function isSubstationSourceMaterializing(state: AppState): boolean {
  const status = preparation.get(state);
  return !!status && status.current() && !status.complete;
}

export function substationSourcePreparationMessage(state: AppState): string {
  return preparation.get(state)?.error
    ? '源几何准备失败。已读取的属性和来源信息仍可查看。'
    : '源几何仍在后台准备。当前对象的属性和来源信息可以查看。';
}
