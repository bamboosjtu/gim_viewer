/**
 * 性能埋点单测（acc-plan P0-1）。
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  perfReset,
  perfUpdateSessionIdentity,
  perfBegin,
  perfMark,
  perfSnapshot,
  perfSummary,
  perfCurrentSession,
  perfRecordInvoke,
  perfRecordBatchRead,
  perfMarkProductMoment,
  perfProductMomentSnapshot,
  perfRecordMemorySample,
  perfRecordExternalSpan,
  perfRecordSubstationIfcRead,
  perfRecordSubstationIfcProfile,
  perfRecordSubstationFinalizeProfile,
  perfSetFragmentsCacheEnabled,
  perfRecordFragmentsCacheOperation,
  perfRecordFragmentsCacheOutcome,
  perfFragmentsCacheSnapshot,
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

  it('更新工程身份时保留同一性能会话及既有冷启动 span', () => {
    const initial = perfCurrentSession();
    perfMark('冷启动：读取 GIM 文件信息', { bytes: 123 }, initial);
    const updated = perfUpdateSessionIdentity({
      generation: 8,
      projectId: 42,
      sourceSha256: 'sha-42',
    });
    const snapshot = perfSnapshot();
    expect(updated.id).toBe(initial.id);
    expect(snapshot.session).toMatchObject({ id: initial.id, generation: 8, projectId: 42, sourceSha256: 'sha-42' });
    expect(snapshot.spans.map((span) => span.label)).toContain('冷启动：读取 GIM 文件信息');
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

  it('batch Rust 内部计时按 session 隔离并汇总命中/字节', () => {
    const oldSession = perfCurrentSession();
    perfRecordBatchRead({
      readMs: 4,
      resolveMs: 1,
      encodeMs: 2,
      totalMs: 8,
      bytes: 1024,
      entryCount: 4,
      hitCount: 3,
    }, oldSession.id);
    perfReset({ generation: 2 });
    perfRecordBatchRead({
      readMs: 5,
      resolveMs: 1,
      encodeMs: 1,
      totalMs: 9,
      bytes: 2048,
      entryCount: 2,
      hitCount: 2,
    }, oldSession.id);
    const snapshot = perfSnapshot().batchReads;
    expect(snapshot).toMatchObject({
      count: 0,
      requestedEntries: 0,
      hitEntries: 0,
      bytes: 0,
    });
    const current = perfCurrentSession();
    perfRecordBatchRead({
      readMs: 5,
      resolveMs: 1,
      encodeMs: 1,
      totalMs: 9,
      bytes: 2048,
      entryCount: 2,
      hitCount: 2,
    }, current.id);
    expect(perfSnapshot().batchReads).toMatchObject({
      count: 1,
      requestedEntries: 2,
      hitEntries: 2,
      missEntries: 0,
      bytes: 2048,
      totalReadMs: 5,
      totalResolveMs: 1,
      totalEncodeMs: 1,
      totalMs: 9,
    });
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

  it('产品时刻每个会话只记录第一次，迟到时刻不污染新会话', () => {
    const oldSession = perfCurrentSession();
    perfMarkProductMoment('semanticReady', { source: 'old-first' }, oldSession);
    perfMarkProductMoment('semanticReady', { source: 'old-second' }, oldSession);
    expect(perfProductMomentSnapshot().semanticReady?.meta).toEqual({ source: 'old-first' });

    perfReset({ generation: 11 });
    perfMarkProductMoment('semanticReady', { source: 'late-old' }, oldSession);
    expect(perfProductMomentSnapshot().semanticReady).toBeNull();
    perfMarkProductMoment('semanticReady', { source: 'new' });
    expect(perfProductMomentSnapshot().semanticReady?.meta).toEqual({ source: 'new' });
  });

  it('内存样本、外部 span 和变电 IFC profile 按 session 隔离', () => {
    const oldSession = perfCurrentSession();
    perfRecordMemorySample('old', { rssBytes: 10, jsHeapUsedBytes: 5 }, oldSession);
    perfRecordExternalSpan('old external', 7, undefined, oldSession);
    perfRecordSubstationIfcRead({
      modelId: 'old', entryPath: 'old.ifc', bytes: 100, readMs: 1, decodeMs: 2, found: true,
    }, oldSession);
    perfRecordSubstationIfcProfile({
      modelId: 'old', entryPath: 'old.ifc', sourceBytes: 100, totalMs: 3,
      stepScanMs: 1, rawEntityCount: 2, detailEntityCount: 1, placementEntityCount: 1,
      placementDetailMs: 0.1, spatialEntityMs: 0.2, spatialEntityCount: 1,
      propertyMs: 0.3, propertyEntityCount: 1, quantityEntityCount: 0,
      propertyValueCount: 1, quantityValueCount: 0, materialEntityCount: 0,
      classificationEntityCount: 0, relationshipMs: 0.4, relationshipRecordCount: 1,
      relationshipReferenceCount: 1, finalizeMs: 0.1, objectCount: 1,
      containedObjectCount: 1,
    }, oldSession);
    perfRecordSubstationFinalizeProfile({
      durationMs: 1, modelCount: 1, spatialNodeCount: 1, objectCount: 1,
      linkCount: 1, cbmLinkCount: 1, uncontainedIfcObjects: 0,
    }, oldSession);
    perfReset({ generation: 12 });
    perfRecordMemorySample('late-old', { rssBytes: 20 }, oldSession);
    perfRecordExternalSpan('late-old external', 9, undefined, oldSession);
    expect(perfSnapshot().memory).toHaveLength(0);
    expect(perfSnapshot().substation.ifcReads).toHaveLength(0);
    expect(perfSnapshot().substation.ifcParses).toHaveLength(0);
    expect(perfSnapshot().substation.finalize).toHaveLength(0);
    expect(perfSnapshot().spans).toHaveLength(0);
  });

  it('Fragments cache 操作、字节和命中/未命中/回退按会话汇总', () => {
    const oldSession = perfCurrentSession();
    perfSetFragmentsCacheEnabled(true, oldSession.id);
    perfRecordFragmentsCacheOutcome('attempt', oldSession.id);
    perfRecordFragmentsCacheOperation('validate', 4, 0, false, oldSession.id);
    perfRecordFragmentsCacheOutcome('hit', oldSession.id);
    perfRecordFragmentsCacheOperation('read', 8, 1024, false, oldSession.id);
    perfRecordFragmentsCacheOperation('load', 12, 1024, false, oldSession.id);
    perfRecordFragmentsCacheOperation('serialize', 3, 2048, false, oldSession.id);
    perfRecordFragmentsCacheOperation('write', 5, 2048, false, oldSession.id);
    perfRecordFragmentsCacheOperation('upsert', 1, 0, true, oldSession.id);
    perfRecordFragmentsCacheOutcome('attempt', oldSession.id);
    perfRecordFragmentsCacheOutcome('miss', oldSession.id);
    perfRecordFragmentsCacheOutcome('fallback', oldSession.id);

    const snapshot = perfFragmentsCacheSnapshot();
    expect(snapshot).toMatchObject({
      enabled: true,
      attempts: 2,
      hits: 1,
      misses: 1,
      fallbacks: 1,
      readBytes: 1024,
      serializedBytes: 2048,
      writtenBytes: 2048,
    });
    expect(snapshot.operations.read).toMatchObject({ count: 1, bytes: 1024, totalMs: 8 });
    expect(snapshot.operations.upsert).toMatchObject({ count: 1, failures: 1 });

    perfReset({ generation: 2 });
    perfRecordFragmentsCacheOperation('read', 99, 999, false, oldSession.id);
    perfRecordFragmentsCacheOutcome('hit', oldSession.id);
    expect(perfSnapshot().fragmentsCache).toMatchObject({
      enabled: null,
      attempts: 0,
      hits: 0,
      readBytes: 0,
    });
  });

  it('cache disabled 只记录 bypass 条目且不虚构 miss/fallback', () => {
    const session = perfCurrentSession();
    perfSetFragmentsCacheEnabled(false, session.id);
    perfSetFragmentsCacheEnabled(false, session.id);
    expect(perfFragmentsCacheSnapshot()).toMatchObject({
      enabled: false,
      disabled: 2,
      attempts: 0,
      misses: 0,
      fallbacks: 0,
      hits: 0,
    });
  });
});
