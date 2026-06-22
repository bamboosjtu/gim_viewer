/**
 * 性能埋点体系（acc-plan.md P0-1）。
 *
 * 记录「打开 GIM → 可交互」各阶段耗时，供 Ctrl+Shift+D 诊断 JSON 的
 * `timings` 字段与控制台摘要输出。测量先行：所有加载优化的量化依据。
 *
 * 使用方式：
 * - `perfReset()` 在每次打开工程入口处调用（清空上一工程数据）
 * - `const end = perfBegin('解压'); ... end();` 记录区间耗时（支持异步区间）
 * - `perfMark(label)` 记录瞬时事件（如"首个 IFC 就绪"）
 * - `perfSnapshot()` 供诊断 JSON 输出；`perfSummary()` 供控制台人类可读摘要
 *
 * 设计约束：
 * - 纯内存、零依赖，不打点时无任何开销
 * - startMs 为相对会话起点（perfReset 时）的毫秒偏移，便于看时间轴
 */

export interface PerfSpan {
  /** 阶段标签，如 "解压" / "线路图构建" / "IFC 全部就绪" */
  label: string;
  /** 相对会话起点的开始时刻（ms） */
  startMs: number;
  /** 区间耗时（ms），瞬时事件为 0 */
  durationMs: number;
  /** 附加信息（如文件数、节点数） */
  meta?: Record<string, unknown>;
}

let sessionStartMs = performance.now();
let spans: PerfSpan[] = [];

/** 重置会话（打开新工程时调用） */
export function perfReset(): void {
  sessionStartMs = performance.now();
  spans = [];
}

/**
 * 开始一个计时区间。
 * @returns 结束函数，可传后缀细化标签（如 end('（缓存命中）')）
 */
export function perfBegin(
  label: string,
  meta?: Record<string, unknown>,
): (labelSuffix?: string, endMeta?: Record<string, unknown>) => void {
  const t0 = performance.now();
  return (labelSuffix?: string, endMeta?: Record<string, unknown>) => {
    spans.push({
      label: labelSuffix ? `${label}${labelSuffix}` : label,
      startMs: t0 - sessionStartMs,
      durationMs: performance.now() - t0,
      meta: endMeta ?? meta,
    });
    const s = spans[spans.length - 1];
    debugPerf(s);
  };
}

/** 记录瞬时事件（durationMs=0） */
export function perfMark(label: string, meta?: Record<string, unknown>): void {
  const span: PerfSpan = {
    label,
    startMs: performance.now() - sessionStartMs,
    durationMs: 0,
    meta,
  };
  spans.push(span);
  debugPerf(span);
}

function debugPerf(span: PerfSpan): void {
  // 控制台即时可见（不受 DEBUG 开关限制——打点本身极廉价，且是排障关键线索）
  console.log(
    `[perf] ${span.label}: ${span.durationMs > 0 ? `${Math.round(span.durationMs)}ms` : '事件'} @ +${Math.round(span.startMs)}ms`,
    span.meta ?? '',
  );
}

/** 诊断 JSON 用快照 */
export function perfSnapshot(): { sessionStartMs: number; totalMs: number; spans: PerfSpan[] } {
  return {
    sessionStartMs,
    totalMs: Math.round(performance.now() - sessionStartMs),
    spans,
  };
}

/** 人类可读摘要（对齐文本表） */
export function perfSummary(): string {
  if (spans.length === 0) return '(无性能埋点数据)';
  const lines = ['阶段耗时（相对会话起点）:', '─'.repeat(64)];
  for (const s of spans) {
    const dur = s.durationMs > 0 ? `${Math.round(s.durationMs)}ms`.padEnd(8) : '  事件 ';
    lines.push(`${`+${Math.round(s.startMs)}ms`.padStart(10)}  ${dur}  ${s.label}`);
  }
  lines.push('─'.repeat(64));
  lines.push(`总时长: ${(performance.now() - sessionStartMs).toFixed(0)}ms`);
  return lines.join('\n');
}
