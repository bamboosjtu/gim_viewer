import { expect, it, vi } from 'vitest';
import { AppState } from '../../../../app/state.js';
import { perfCurrentSession } from '../../../../utils/perfTimings.js';
import { SubstationBackgroundCoordinator } from '../substationBackgroundRuntime.js';
import { createSubstationIfcCompletion } from '../substationIfcCompletion.js';
import { createSubstationIfcLoadProgress } from '../substationIfcLoadProgress.js';

it('leaves the next session untouched when the old IFC tail is waiting on coordinate alignment', async () => {
  const state = new AppState();
  const session = state.captureProjectSession();
  const perfSession = perfCurrentSession();
  let current = true;
  let finishAnchor!: () => void;
  const anchor = new Promise<void>((resolve) => { finishAnchor = resolve; });
  const isCurrent = () => current;
  const progress = createSubstationIfcLoadProgress({
    total: 1, isCurrent, loadedCount: () => 0, skippedCount: () => 0,
  });
  const settle = vi.spyOn(progress, 'settle');
  const enqueueDevGeometry = vi.fn();
  const startDeferredAfterPaint = vi.fn();
  const completed = createSubstationIfcCompletion({
    state, ctx: {} as never, entries: [], session, perfSession,
    background: new SubstationBackgroundCoordinator({ session: perfSession, isCurrent }),
    progress, measureGeometryTracks: false, isCurrent, isInteractive: () => false,
    syncCoordinateAnchor: () => anchor, enqueueDevGeometry, startDeferredAfterPaint,
    initializeInteractiveAfterFirstIfc: vi.fn(),
  });
  state.ifcLoading.pending = true;
  const pending = completed.settle(0);
  current = false;
  finishAnchor();
  await expect(pending).resolves.toBe(false);
  expect(settle).not.toHaveBeenCalled();
  expect(enqueueDevGeometry).not.toHaveBeenCalled();
  expect(startDeferredAfterPaint).not.toHaveBeenCalled();
  expect(state.ifcLoading.pending).toBe(true);
});
