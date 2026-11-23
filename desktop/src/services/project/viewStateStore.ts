import { projectPresentation } from '../presentation/projectPresentationPort.js';
import type { AppState } from '../../app/state.js';

/**
 * 工程视图偏好。
 *
 * 变电默认打开是整站远景全景（camera.ts 的 overview），因此这里只保存
 * 层级树展开状态；不再恢复上次相机和选中对象，避免“上次放大到某台设备”
 * 把默认全景覆盖掉。选中对象仍可按需查看属性。
 */
const STORAGE_PREFIX = 'gim-view-state-v1';

interface StoredViewState {
  expandedPaths: string[];
  updatedAt: number;
}

function storageKey(state: AppState): string {
  const session = state.captureProjectSession();
  return `${STORAGE_PREFIX}|${session.sourceSha256 || `project:${session.projectId ?? 'none'}`}`;
}

export function saveViewState(state: AppState): void {
  const stored: StoredViewState = {
    expandedPaths: projectPresentation().expandedTreePaths(),
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(storageKey(state), JSON.stringify(stored));
  } catch {
    /* ignore */
  }
}

function loadStored(state: AppState): StoredViewState | null {
  try {
    const raw = localStorage.getItem(storageKey(state));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredViewState;
    if (!Array.isArray(parsed.expandedPaths)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 恢复层级树展开状态；best effort，不阻塞首帧，也不改变相机或选择。 */
export function restoreTreeState(state: AppState): void {
  const stored = loadStored(state);
  if (!stored) return;
  const session = state.captureProjectSession();
  void projectPresentation()
    .restoreExpandedTree((stored.expandedPaths ?? []).slice(0, 48), () =>
      state.isCurrentSession(session),
    )
    .catch(() => {
      /* tree restore is best effort */
    });
}
