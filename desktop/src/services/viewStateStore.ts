import * as THREE from 'three';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';

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
  const controls = ctx.world?.camera?.controls;
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

/** Apply the saved camera immediately; never await camera control work here. */
export function restoreCameraState(ctx: ViewerContext, state: AppState): boolean {
  const stored = loadStored(state);
  const controls = ctx.world?.camera?.controls;
  if (!stored || !controls?.setLookAt
    || !stored.position.every(Number.isFinite)
    || !stored.target.every(Number.isFinite)) return false;
  try {
    void controls.setLookAt(
      stored.position[0], stored.position[1], stored.position[2],
      stored.target[0], stored.target[1], stored.target[2],
      false,
    );
    state.hasFittedCamera = true;
    return true;
  } catch (error) {
    console.warn('[ViewState] camera restore failed:', error);
    return false;
  }
}

/**
 * Tree expansion/selection is best effort and runs after the first usable
 * frame. It must not read FAM/DEV or delay `hideLoading`.
 */
export function restoreTreeState(state: AppState): void {
  const stored = loadStored(state);
  if (!stored) return;
  void import('../ui/cbmTreeView.js').then(async ({ expandTreeToPaths, selectTreeRowByPath }) => {
    await expandTreeToPaths((stored.expandedPaths ?? []).slice(0, 48));
    if (stored.selectedPath) selectTreeRowByPath(stored.selectedPath);
  }).catch(() => { /* tree restore is best effort */ });
}
