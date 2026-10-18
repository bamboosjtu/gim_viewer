import * as THREE from 'three';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { CbmNode } from '../gim/types.js';

const STORAGE_PREFIX = 'gim-view-state-v1';

interface StoredViewState {
  position: [number, number, number];
  target: [number, number, number];
  selectedPath: string | null;
  expandedPaths: string[];
  updatedAt: number;
}

function storageKey(state: AppState): string {
  const session = state.captureProjectSession();
  return `${STORAGE_PREFIX}|${session.sourceSha256 || `project:${session.projectId ?? 'none'}`}`;
}

function findExpandedPaths(): string[] {
  const result: string[] = [];
  document.querySelectorAll<HTMLElement>('#cbm-tree-panel .tree-toggle.expanded').forEach((toggle) => {
    const row = toggle.closest<HTMLElement>('.tree-row');
    if (row?.dataset.nodePath) result.push(row.dataset.nodePath);
  });
  return result;
}

function selectedPath(): string | null {
  return document.querySelector<HTMLElement>('#cbm-tree-panel .tree-row.selected')?.dataset.nodePath ?? null;
}

export function saveViewState(state: AppState, ctx?: ViewerContext | null): void {
  if (!ctx) return;
  const controls = ctx.world.camera.controls;
  if (!controls?.getPosition || !controls.getTarget) return;
  const position = controls.getPosition(new THREE.Vector3(), false);
  const target = controls.getTarget(new THREE.Vector3(), false);
  if (!position || !target || ![...position.toArray(), ...target.toArray()].every(Number.isFinite)) return;
  const stored: StoredViewState = {
    position: position.toArray(),
    target: target.toArray(),
    selectedPath: selectedPath(),
    expandedPaths: findExpandedPaths(),
    updatedAt: Date.now(),
  };
  try { localStorage.setItem(storageKey(state), JSON.stringify(stored)); } catch { /* ignore */ }
}

function loadStored(state: AppState): StoredViewState | null {
  try {
    const raw = localStorage.getItem(storageKey(state));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredViewState;
    if (!Array.isArray(parsed.position) || !Array.isArray(parsed.target)) return null;
    return parsed;
  } catch { return null; }
}

function findNode(root: CbmNode | null, path: string): CbmNode | null {
  if (!root) return null;
  const queue: CbmNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.path === path) return node;
    queue.push(...node.children);
  }
  return null;
}

/**
 * Restore camera + tree state after the first usable IFC.
 * Returns true when a stored camera was applied, so the caller must skip fit.
 */
export async function restoreViewState(ctx: ViewerContext, state: AppState): Promise<boolean> {
  const stored = loadStored(state);
  if (!stored) return false;
  let restoredCamera = false;
  const controls = ctx.world.camera.controls;
  if (controls?.setLookAt
    && stored.position.every(Number.isFinite)
    && stored.target.every(Number.isFinite)) {
    try {
      await controls.setLookAt(
        stored.position[0], stored.position[1], stored.position[2],
        stored.target[0], stored.target[1], stored.target[2],
        false,
      );
      state.hasFittedCamera = true;
      restoredCamera = true;
    } catch (error) {
      console.warn('[ViewState] camera restore failed:', error);
    }
  }
  const { expandTreeToPaths, selectTreeRowByPath } = await import('../ui/cbmTreeView.js');
  await expandTreeToPaths(stored.expandedPaths ?? []);
  if (stored.selectedPath) {
    selectTreeRowByPath(stored.selectedPath);
    const node = findNode(state.currentCbmTree, stored.selectedPath);
    if (node) {
      // Rebuild the inspector content without forcing the drawer open; the
      // user's auto-show-props setting remains authoritative.
      void import('../ui/propsDrawer.js').then(({ showNodePropertiesBasic }) =>
        showNodePropertiesBasic(state, node, state.beginSelection({ kind: 'cbm', key: node.path })))
        .catch(() => { /* selection restore is best effort */ });
    }
  }
  return restoredCamera;
}
