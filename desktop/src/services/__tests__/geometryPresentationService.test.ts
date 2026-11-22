import { expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import type { ViewerContext } from '../../viewer/viewerEngine.js';
import { observeFirstGeometry } from '../geometryPresentationService.js';

const viewer = vi.hoisted(() => ({ observe: vi.fn(), dispose: vi.fn(), watch: vi.fn() }));
vi.mock('../../viewer/modelPresentation.js', () => ({ observeModelPresentation: viewer.observe }));

it('releases frame observation on session cancellation and ignores an already queued draw', async () => {
  const state = new AppState(), session = state.activateProject(1, 'a');
  const scope = state.sessionScope(session);
  const presented = vi.fn();
  let draw!: () => void;
  viewer.observe.mockImplementation((_ctx, _current, onPresented: () => void) => {
    draw = onPresented;
    return { watch: viewer.watch, dispose: viewer.dispose };
  });
  await observeFirstGeometry(state, {} as ViewerContext, {} as never, session, presented);
  expect(viewer.watch).toHaveBeenCalledOnce();
  scope.dispose();
  await vi.waitFor(() => expect(viewer.dispose).toHaveBeenCalledOnce());
  draw();
  expect(presented).not.toHaveBeenCalled();
});
