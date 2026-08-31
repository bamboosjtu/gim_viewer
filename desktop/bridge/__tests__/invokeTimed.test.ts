import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { invokeTimed } from '../invokeTimed.js';
import { perfReset, perfSnapshot } from '../../src/utils/perfTimings.js';

describe('invokeTimed', () => {
  beforeEach(() => {
    perfReset();
    invokeMock.mockReset();
  });

  it('记录 command、请求/响应字节和耗时', async () => {
    const response = new Uint8Array([1, 2, 3, 4]).buffer;
    invokeMock.mockResolvedValue(response);
    await expect(invokeTimed<ArrayBuffer>('read_cached_entry', { projectId: 7, entryPath: 'CBM/a.cbm' }))
      .resolves.toBe(response);
    const stat = perfSnapshot().invokes.find((item) => item.command === 'read_cached_entry');
    expect(stat?.count).toBe(1);
    expect(stat?.bytes).toBeGreaterThanOrEqual(response.byteLength);
    expect(stat?.failures).toBe(0);
  });

  it('失败 command 继续抛错但纳入 failures', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));
    await expect(invokeTimed('batch_read_cached_files', { projectId: 7, entryPaths: [] }))
      .rejects.toThrow('boom');
    const stat = perfSnapshot().invokes.find((item) => item.command === 'batch_read_cached_files');
    expect(stat).toMatchObject({ count: 1, failures: 1 });
  });

  it('工程切换后迟到的 command 结果不写入新 session', async () => {
    let resolveInvoke: ((value: ArrayBuffer) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise<ArrayBuffer>((resolve) => {
      resolveInvoke = resolve;
    }));
    const oldCall = invokeTimed<ArrayBuffer>('read_cached_entry', {
      projectId: 1,
      entryPath: 'CBM/old.cbm',
    });
    perfReset({ generation: 2, projectId: 2, sourceSha256: 'new' });
    resolveInvoke?.(new ArrayBuffer(8));
    await expect(oldCall).resolves.toBeInstanceOf(ArrayBuffer);
    expect(perfSnapshot().invokes).toEqual([]);
  });
});
