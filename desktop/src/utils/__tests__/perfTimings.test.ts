/**
 * 性能埋点单测（acc-plan P0-1）。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  perfReset,
  perfBegin,
  perfMark,
  perfSnapshot,
  perfSummary,
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
});
