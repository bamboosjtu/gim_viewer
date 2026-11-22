import type { AppState } from '../state.js';
import { perfReset } from '../../utils/perfTimings.js';
import { logger } from '../../utils/logger.js';

type CleanupGuard = () => boolean;

export interface ProjectViewerLifecycle {
  /** A successful release returns a callback for observations after state reset. */
  releaseProject(current: CleanupGuard, generation: number): Promise<(() => void) | false>;
}

export interface ProjectCleanupPorts {
  markCancellation(closing: boolean): void;
  cancelPending(): void;
  prepareRelease(current: CleanupGuard): Promise<void>;
  viewer: ProjectViewerLifecycle;
  presentation: {
    resetIdentity(current: CleanupGuard): Promise<void>;
    resetStatus(): void;
    clearProjectViews(current: CleanupGuard): Promise<void>;
    closed(current: CleanupGuard): Promise<void>;
  };
}

/** Invalidate synchronously and serialize the release of the shared Viewer. */
export function cleanupProject(
  state: AppState,
  ports: ProjectCleanupPorts,
  expectedGeneration?: number,
): Promise<boolean> {
  if (expectedGeneration !== undefined && state.projectGeneration !== expectedGeneration)
    return Promise.resolve(false);
  const closing = expectedGeneration === undefined;
  let generation: number;
  try {
    ports.markCancellation(closing);
  } finally {
    generation = state.invalidatePendingLoads();
  }
  const current = () => state.projectGeneration === generation;
  if (!current()) return Promise.resolve(false);
  ports.cancelPending();
  return state.projectSession.queueCleanup(() =>
    finishCleanup(state, ports, generation, closing, current),
  );
}

async function finishCleanup(
  state: AppState,
  ports: ProjectCleanupPorts,
  generation: number,
  closing: boolean,
  current: CleanupGuard,
): Promise<boolean> {
  if (!current()) return false;
  await ports.prepareRelease(current);
  if (!current()) return false;
  // The open workflow retains its own timing session.
  if (closing) perfReset({ generation, projectId: null, sourceSha256: null });
  try {
    await ports.presentation.resetIdentity(current);
  } catch {
    /* A presentation failure does not block resource release. */
  }
  if (!current()) return false;
  ports.presentation.resetStatus();

  const afterReset = await ports.viewer.releaseProject(current, generation);
  if (!afterReset || !current()) return false;
  try {
    await ports.presentation.clearProjectViews(current);
  } catch (error) {
    logger.warn('[Cleanup] clear project views failed:', error);
  }

  if (!state.finishProjectCleanup(generation, closing)) return false;
  if (closing) await ports.presentation.closed(current);
  if (!current()) return false;
  afterReset();
  return true;
}
