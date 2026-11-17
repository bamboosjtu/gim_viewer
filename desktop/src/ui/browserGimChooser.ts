const pending = new WeakMap<HTMLInputElement, () => void>();

/** Open the chooser while the click still owns browser user activation.
 * Replacing/cancelling a chooser does not invalidate the currently open project. */
export function chooseBrowserFiles(input: HTMLInputElement): Promise<File[]> {
  pending.get(input)?.();
  return new Promise((resolve, reject) => {
    const detach = () => {
      input.removeEventListener('change', changed); input.removeEventListener('cancel', cancelled);
      if (pending.get(input) === cancelled) pending.delete(input);
    };
    const cancelled = () => { detach(); resolve([]); };
    const changed = () => { const files=Array.from(input.files??[]);detach();resolve(files); };
    pending.set(input, cancelled);
    input.addEventListener('change', changed); input.addEventListener('cancel', cancelled);
    try { input.click(); } catch (error) { detach(); reject(error); }
  });
}

export function chooseBrowserGimFile(input:HTMLInputElement):Promise<File|null>{return chooseBrowserFiles(input).then(files=>files[0]??null);}
