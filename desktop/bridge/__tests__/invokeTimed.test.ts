import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { estimateInvokeByteMeasurement, invokeTimed } from '../invokeTimed.js';
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

  it('普通对象不为埋点重复 JSON 序列化，并标记 bytesMeasured=false', async () => {
    const request = { graphPayload: { nodes: Array.from({ length: 10 }, (_, index) => ({ index })) }, toJSON: () => { throw new Error('must not stringify'); } };
    invokeMock.mockResolvedValue({ ok: true });
    await expect(invokeTimed('save_line_graph_begin', request)).resolves.toEqual({ ok: true });
    const stat = perfSnapshot().invokes.find((item) => item.command === 'save_line_graph_begin');
    expect(stat).toMatchObject({ count: 1, bytes: 0, bytesMeasured: false, measuredCalls: 0, unmeasuredCalls: 1 });
    expect(estimateInvokeByteMeasurement(request, { ok: true })).toEqual({ bytes: 0, measured: false });
  });

  it('调用方显式提供请求/响应字节数时完整记录，不触发对象序列化', async () => {
    const request = { graphPayload: { huge: true }, toJSON: () => { throw new Error('must not stringify'); } };
    invokeMock.mockResolvedValue({ saved: true });
    await invokeTimed('save_line_graph_begin', request, { requestBytes: 1234, responseBytes: 16 });
    const stat = perfSnapshot().invokes.find((item) => item.command === 'save_line_graph_begin');
    expect(stat).toMatchObject({ bytes: 1250, bytesMeasured: true, measuredCalls: 1, unmeasuredCalls: 0 });
  });
});
