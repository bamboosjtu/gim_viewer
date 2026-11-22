import { expect, it, vi } from 'vitest';
import { AppState } from '../../state.js';
import { cleanupProject, type ProjectCleanupPorts } from '../projectCleanup.js';

it('does not reset state or publish the close when the Viewer still owns resources', async () => {
  const state = new AppState();
  const previous = state.activateProject(5, 'source');
  const presentation = {
    resetIdentity: vi.fn(async () => {}),
    resetStatus: vi.fn(),
    clearProjectViews: vi.fn(async () => {}),
    closed: vi.fn(async () => {}),
  };
  const ports: ProjectCleanupPorts = {
    markCancellation: vi.fn(),
    cancelPending: vi.fn(),
    prepareRelease: vi.fn(async () => {}),
    viewer: { releaseProject: vi.fn(async () => false as const) },
    presentation,
  };
  await expect(cleanupProject(state, ports)).resolves.toBe(false);
  expect(state.isCurrentSession(previous)).toBe(false);
  expect(state.currentProjectId).toBe(5);
  expect(presentation.clearProjectViews).not.toHaveBeenCalled();
  expect(presentation.closed).not.toHaveBeenCalled();
});
