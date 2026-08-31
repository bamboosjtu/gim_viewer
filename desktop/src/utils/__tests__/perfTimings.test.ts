/**
 * 性能埋点单测（acc-plan P0-1）。
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  perfReset,
  perfBegin,
  perfMark,
  perfSnapshot,
  perfSummary,
  perfCurrentSession,
  perfRecordInvoke,
  installLongTaskObserver,
  perfLongTaskSnapshot,
} from '../perfTimings.js';

describe('perfTimings', () => {
  beforeEach(() => perfReset());

  it('perfBegin 记录区间耗时与元数据', async () => {
    const end = perfBegin('解压', { note: 'start' });
    await new Promise((r) => setTimeout(r, 20));
    end('（首开）', { files: 123 });

    const { spans } = perfSnapshot();
    const span = spans.find((s) => s.label === '解压（首开）');
    expect(span).toBeTruthy();
    expect(span!.durationMs).toBeGreaterThanOrEqual(15);
    expect(span!.meta).toEqual({ files: 123 });
  });

  it('perfMark 记录瞬时事件', () => {
    perfMark('首个 IFC 就绪', { name: 'a.ifc' });
    const { spans } = perfSnapshot();
    const ev = spans.find((s) => s.label === '首个 IFC 就绪');
    expect(ev).toBeTruthy();
    expect(ev!.durationMs).toBe(0);
    expect(ev!.meta).toEqual({ name: 'a.ifc' });
  });

  it('perfReset 清空会话并重置起点', () => {
    perfMark('旧数据');
    perfReset();
    perfMark('新会话');
    const { spans } = perfSnapshot();
    expect(spans.length).toBe(1);
    expect(spans[0].label).toBe('新会话');
  });

  it('perfSummary 输出包含全部标签', () => {
    const end = perfBegin('线路图构建');
    end();
    perfMark('线路工程可交互');
    const summary = perfSummary();
    expect(summary).toContain('线路图构建');
    expect(summary).toContain('线路工程可交互');
  });

  it('perfSnapshot.totalMs 为正数', () => {
    expect(perfSnapshot().totalMs).toBeGreaterThanOrEqual(0);
  });

  it('旧性能会话的迟到 span 不会写入新会话', () => {
    const oldSession = perfCurrentSession();
    const end = perfBegin('旧工程异步阶段', undefined, oldSession);
    perfReset({ generation: 2, projectId: 2 });
    end();
    perfMark('旧工程迟到事件', undefined, oldSession);
    const snapshot = perfSnapshot();
    expect(snapshot.session.generation).toBe(2);
    expect(snapshot.spans).toHaveLength(0);
  });

  it('invoke 汇总按 command 统计次数、字节和分位耗时', () => {
    const sessionId = perfCurrentSession().id;
    perfRecordInvoke('read_cached_entry', 10, 100, sessionId);
    perfRecordInvoke('read_cached_entry', 20, 200, sessionId);
    perfRecordInvoke('read_cached_entry', 30, 300, sessionId, true);
    const item = perfSnapshot().invokes.find((entry) => entry.command === 'read_cached_entry');
    expect(item).toMatchObject({ count: 3, bytes: 600, failures: 1, totalMs: 60, p50Ms: 20, p95Ms: 30, maxMs: 30 });
  });

  it('Long Task 统计 blocking time，旧 observer 回调不污染新会话', () => {
    type Callback = (list: { getEntries: () => Array<{ duration: number }> }) => void;
    class FakeObserver {
      static instances: FakeObserver[] = [];
      constructor(private readonly callback: Callback) { FakeObserver.instances.push(this); }
      observe(): void { /* no-op */ }
      disconnect(): void { /* no-op */ }
      emit(duration: number): void { this.callback({ getEntries: () => [{ duration }] }); }
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    const stop = installLongTaskObserver();
    const oldObserver = FakeObserver.instances[0];
    oldObserver.emit(80);
    expect(perfLongTaskSnapshot()).toMatchObject({ count: 1, totalBlockingTimeMs: 30, maxMs: 80 });
    perfReset({ generation: 99 });
    oldObserver.emit(100);
    expect(perfLongTaskSnapshot()).toMatchObject({ count: 0, totalBlockingTimeMs: 0, maxMs: 0 });
    // 旧 session 的 stop 不能误关掉 perfReset 后重建的新 observer。
    stop();
    FakeObserver.instances[FakeObserver.instances.length - 1].emit(60);
    expect(perfLongTaskSnapshot()).toMatchObject({ count: 1, totalBlockingTimeMs: 10, maxMs: 60 });
    vi.unstubAllGlobals();
  });
});
