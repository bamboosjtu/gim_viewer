import { afterEach, expect, it, vi } from 'vitest';
import { chooseBrowserGimFile } from '../browserGimChooser.js';
import { AppState } from '../../app/state.js';

vi.mock('@desktop/runtime.js', () => ({ isTauri: () => false }));
vi.mock('../substationRuntime.js', () => ({ openSubstationProject: vi.fn(), onGimExtracted: vi.fn(), loadAllIfcFiles: vi.fn() }));
vi.mock('../powerlineRuntime.js', () => ({ openPowerlineProject: vi.fn() }));
vi.mock('../gimOpenCore.js', async () => ({ ...await vi.importActual('../gimOpenCore.js'), showLoading: vi.fn(), hideLoading: vi.fn() }));
vi.mock('../../ui/dom.js', async () => ({ ...await vi.importActual('../../ui/dom.js'),
  gimFileInput: document.createElement('input'), btnLoadGim: document.createElement('button') }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('opens synchronously and settles cancellation without reading a file', async () => {
  const input = document.createElement('input'), click = vi.spyOn(input, 'click').mockImplementation(() => {});
  const chosen = chooseBrowserGimFile(input); expect(click).toHaveBeenCalledTimes(1);
  input.dispatchEvent(new Event('cancel')); await expect(chosen).resolves.toBeNull();
});

it('replaces a pending chooser and consumes a selected file only once', async () => {
  const input = document.createElement('input'); vi.spyOn(input, 'click').mockImplementation(() => {});
  const first = chooseBrowserGimFile(input), second = chooseBrowserGimFile(input);
  await expect(first).resolves.toBeNull();
  const file = new File(['source'], 'sample.gim'); Object.defineProperty(input, 'files', { value: [file] });
  input.dispatchEvent(new Event('change')); await expect(second).resolves.toBe(file);
  input.dispatchEvent(new Event('cancel'));
});

it('keeps an active project and its renderer alive while the browser chooser is open or cancelled', async () => {
  const { openGimWithDialog } = await import('../openGimService.js'), { gimFileInput, btnLoadGim } = await import('../../ui/dom.js');
  const app = new AppState(); app.activateProject(7, 'a'.repeat(64));
  const generation = app.projectGeneration, release = vi.fn(); app.deviceLodRuntime = { release } as any;
  const invalidate = vi.spyOn(app, 'invalidatePendingLoads');
  vi.spyOn(gimFileInput, 'click').mockImplementation(() => {});
  const request = openGimWithDialog(app, vi.fn());
  expect(invalidate).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); expect(btnLoadGim.disabled).toBe(false);
  gimFileInput.dispatchEvent(new Event('cancel')); await request;
  expect(app.projectGeneration).toBe(generation); expect(release).not.toHaveBeenCalled();
});

it('starts cancellation and source reading once after the latest chooser receives a file', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const { openGimWithDialog } = await import('../openGimService.js'), { gimFileInput, btnLoadGim } = await import('../../ui/dom.js');
  const app = new AppState(), invalidate = vi.spyOn(app, 'invalidatePendingLoads');
  vi.spyOn(gimFileInput, 'click').mockImplementation(() => {});
  const first = openGimWithDialog(app, vi.fn()), latest = openGimWithDialog(app, vi.fn());
  await first; expect(invalidate).not.toHaveBeenCalled();
  const read = vi.fn(async () => { throw Error('source read failed'); });
  const file = new File(['source'], 'sample.gim'); Object.defineProperty(file, 'arrayBuffer', { value: read });
  Object.defineProperty(gimFileInput, 'files', { configurable: true, value: [file] });
  gimFileInput.dispatchEvent(new Event('change')); await latest;
  expect(invalidate).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(1); expect(btnLoadGim.disabled).toBe(false);
});
