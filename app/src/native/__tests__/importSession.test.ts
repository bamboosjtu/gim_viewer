import { beforeEach, expect, it, vi } from 'vitest';
import type { PowerlineProject } from '@gim/powerline-core';
import type { Prepared } from '../bridge';
import { NativeImportSession } from '../importSession';

const bridge = vi.hoisted(() => ({
  prepareNative: vi.fn(),
  commit: vi.fn(),
  deleteProject: vi.fn(),
}));
vi.mock('../bridge', () => bridge);

const input = { path: 'staged.gim', name: 'test', sha256: 'same-sha', size: 1, copyMs: 0 };
const meta: Prepared['meta'] = {
  id: input.sha256, name: input.name, sha256: input.sha256, size: input.size,
  importedAt: 0, lastOpenedAt: 0, parserVersion: '', counts: {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  bridge.deleteProject.mockResolvedValue(undefined);
});

it('keeps cancellation pending through a late prepare reply and its cleanup before same-source retry', async () => {
  const prepareReply = deferred<Prepared>();
  const deleteReply = deferred<void>();
  bridge.prepareNative.mockReturnValueOnce(prepareReply.promise);
  bridge.deleteProject.mockReturnValueOnce(deleteReply.promise);
  const old = new NativeImportSession();
  const opening = old.prepare(input);
  const cancelled = vi.fn();
  const cleanup = old.rollback();
  expect(old.rollback()).toBe(cleanup);
  void cleanup.then(cancelled);
  await Promise.resolve();
  expect(cancelled).not.toHaveBeenCalled();
  expect(bridge.deleteProject).not.toHaveBeenCalled();

  prepareReply.resolve({ meta, duplicate: false, cache: null });
  await opening;
  await vi.waitFor(() => expect(bridge.deleteProject).toHaveBeenCalledWith(meta.id));
  expect(cancelled).not.toHaveBeenCalled();
  deleteReply.resolve();
  await cleanup;

  bridge.prepareNative.mockResolvedValueOnce({ meta, duplicate: false, cache: null });
  const retry = new NativeImportSession();
  await expect(retry.prepare(input)).resolves.toMatchObject({ meta, duplicate: false });
  expect(bridge.deleteProject).toHaveBeenCalledTimes(1);
});

it.each([false, true])('waits for an in-flight cache commit and only deletes an owned source (duplicate=%s)', async duplicate => {
  bridge.prepareNative.mockResolvedValue({ meta, duplicate, cache: null });
  const commitReply = deferred<void>();
  bridge.commit.mockReturnValue(commitReply.promise);
  const attempt = new NativeImportSession();
  await attempt.prepare(input);
  const project = { id: meta.id } as PowerlineProject;
  const pending = attempt.commit(project);
  const cancelled = vi.fn();
  const cleanup = attempt.rollback().then(cancelled);
  await Promise.resolve();
  expect(cancelled).not.toHaveBeenCalled();
  expect(bridge.deleteProject).not.toHaveBeenCalled();
  commitReply.resolve();
  await pending;
  await cleanup;
  expect(bridge.deleteProject).toHaveBeenCalledTimes(duplicate ? 0 : 1);
});
