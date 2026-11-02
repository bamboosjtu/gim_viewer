const pending = new WeakMap<HTMLInputElement, () => void>();

/** Open the chooser while the click still owns browser user activation.
 * Replacing/cancelling a chooser does not invalidate the currently open project. */
export function chooseBrowserGimFile(input: HTMLInputElement): Promise<File | null> {
  pending.get(input)?.();
  return new Promise((resolve, reject) => {
    const detach = () => {
      input.removeEventListener('change', changed); input.removeEventListener('cancel', cancelled);
      if (pending.get(input) === cancelled) pending.delete(input);
    };
    const cancelled = () => { detach(); resolve(null); };
    const changed = () => { const file = input.files?.[0] ?? null; detach(); resolve(file); };
    pending.set(input, cancelled);
    input.addEventListener('change', changed); input.addEventListener('cancel', cancelled);
    try { input.click(); } catch (error) { detach(); reject(error); }
  });
}
