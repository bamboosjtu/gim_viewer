// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createEngineeringWorkerSources } from '../engineeringWorkerSources.js';

it('shares demand reads and clears resolved documents when the source inventory is replaced', async () => {
  const path = 'CBM/Project.cbm';
  let value = 'PROJECTNAME=First';
  const load = vi.fn(async (paths: string[]) => ({
    batches: [],
    errors: [],
    files: paths.map((path) => ({ path, blob: new Blob([value]) })),
  }));
  const inputs = createEngineeringWorkerSources(load);
  const firstIndex = inputs.resolveIndex([path]);
  expect(firstIndex.resolve('project.cbm')).toBe(path);
  const [first, concurrent] = await Promise.all([
    inputs.documents.read(path),
    inputs.documents.read(path),
  ]);
  expect(first).toBe(concurrent);
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledWith([path]);
  inputs.resetForInit();
  value = 'PROJECTNAME=Next';
  expect(inputs.resolveIndex([path])).not.toBe(firstIndex);
  const next = await inputs.documents.read(path);
  expect(next).not.toBe(first);
  expect(next.fields[0].value).toBe('Next');
  expect(load).toHaveBeenCalledTimes(2);
});

it('rejects an outstanding request and keeps a late reply out of the replacement inventory', async () => {
  const path = 'CBM/Project.cbm';
  const input = (name: string) => ({
    batches: [],
    errors: [],
    files: [{ path, blob: new Blob(['PROJECTNAME=' + name]) }],
  });
  let finishOld!: (payload: ReturnType<typeof input>) => void;
  const oldReply = new Promise<ReturnType<typeof input>>((resolve) => { finishOld = resolve; });
  const load = vi.fn(async () => input('Next')).mockReturnValueOnce(oldReply);
  const sources = createEngineeringWorkerSources(load);
  const staleRead = expect(sources.documents.read(path)).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  sources.resetForInit();
  await staleRead;
  expect((await sources.documents.read(path)).fields[0].value).toBe('Next');
  finishOld(input('Stale'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect(sources.readFamily(path)).resolves.toBe('PROJECTNAME=Next');
});
