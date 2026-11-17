import {afterEach,expect,it,vi} from 'vitest';
import {chooseBrowserGimFile} from '../browserGimChooser.js';
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
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
