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
  /** 生成该 span 的性能会话身份，便于诊断迟到结果。 */
  sessionId?: number;
}

export interface PerfSessionIdentity {
  /** 与工程加载代次对应的快照；仅用于诊断，不参与 sessionId 生成。 */
  generation?: number;
  projectId?: number | null;
  sourceSha256?: string | null;
}

export interface PerfSession extends PerfSessionIdentity {
  /** 每次 perfReset 递增；迟到的异步回调只能提交到创建时的 id。 */
  readonly id: number;
}

export interface PerfInvokeCommandStats {
  command: string;
  count: number;
  /** 请求 + 响应的估算字节数。二进制响应按实际 byteLength 统计。 */
  bytes: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  failures: number;
}

export interface PerfLongTaskStats {
  count: number;
  /** blocking time = max(0, duration - 50ms)，符合 Long Tasks API 口径。 */
  totalBlockingTimeMs: number;
  maxMs: number;
}

interface InvokeAccumulator {
  count: number;
  bytes: number;
  totalMs: number;
  maxMs: number;
  failures: number;
  durations: number[];
}

let sessionStartMs = performance.now();
let sessionSequence = 0;
let currentSession: PerfSession = { id: 0 };
let spans: PerfSpan[] = [];
const invokeStats = new Map<string, InvokeAccumulator>();
let longTaskStats: PerfLongTaskStats = { count: 0, totalBlockingTimeMs: 0, maxMs: 0 };
let longTaskObserver: PerformanceObserver | null = null;
let longTaskObserverEnabled = false;

function cloneSession(session: PerfSession): PerfSession {
  return { ...session };
}

/** 当前性能会话快照。异步任务应在启动时捕获并在写入时传回。 */
export function perfCurrentSession(): PerfSession {
  return cloneSession(currentSession);
}

/** 判断一个性能会话是否仍是当前会话。 */
export function perfIsCurrentSession(session: PerfSession | number | undefined): boolean {
  if (session === undefined) return true;
  return typeof session === 'number'
    ? session === currentSession.id
    : session.id === currentSession.id;
}

/** 重置会话（打开新工程时调用） */
export function perfReset(identity: PerfSessionIdentity = {}): void {
  sessionSequence += 1;
  currentSession = { id: sessionSequence, ...identity };
  sessionStartMs = performance.now();
  spans = [];
  invokeStats.clear();
  longTaskStats = { count: 0, totalBlockingTimeMs: 0, maxMs: 0 };
  // PerformanceObserver 回调可能在旧工程 reset 后才到达。重建 observer，
  // 让回调闭包绑定新 session id，避免旧 Long Task 计入新工程。
  if (longTaskObserverEnabled) installLongTaskObserver();
}

/**
 * 开始一个计时区间。
 * @returns 结束函数，可传后缀细化标签（如 end('（缓存命中）')）
 */
export function perfBegin(
  label: string,
  meta?: Record<string, unknown>,
  session: PerfSession = currentSession,
): (labelSuffix?: string, endMeta?: Record<string, unknown>) => void {
  const t0 = performance.now();
  return (labelSuffix?: string, endMeta?: Record<string, unknown>) => {
    if (!perfIsCurrentSession(session)) return;
    spans.push({
      label: labelSuffix ? `${label}${labelSuffix}` : label,
      startMs: t0 - sessionStartMs,
      durationMs: performance.now() - t0,
      meta: endMeta ?? meta,
      sessionId: session.id,
    });
    const s = spans[spans.length - 1];
    debugPerf(s);
  };
}

/** 记录瞬时事件（durationMs=0） */
export function perfMark(
  label: string,
  meta?: Record<string, unknown>,
  session: PerfSession = currentSession,
): void {
  if (!perfIsCurrentSession(session)) return;
  const span: PerfSpan = {
    label,
    startMs: performance.now() - sessionStartMs,
    durationMs: 0,
    meta,
    sessionId: session.id,
  };
  spans.push(span);
  debugPerf(span);
}

/**
 * 记录一次 Tauri invoke。由 bridge/invokeTimed.ts 调用，不能把旧 session
 * 的迟到响应写入新工程。bytes 为请求和响应的估算总和。
 */
export function perfRecordInvoke(
  command: string,
  durationMs: number,
  bytes: number,
  sessionId: number = currentSession.id,
  failed = false,
): void {
  if (sessionId !== currentSession.id) return;
  const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  const safeBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  const current = invokeStats.get(command) ?? {
    count: 0,
    bytes: 0,
    totalMs: 0,
    maxMs: 0,
    failures: 0,
    durations: [],
  } satisfies InvokeAccumulator;
  current.count += 1;
  current.bytes += safeBytes;
  current.totalMs += safeDuration;
  current.maxMs = Math.max(current.maxMs, safeDuration);
  if (failed) current.failures += 1;
  current.durations.push(safeDuration);
  invokeStats.set(command, current);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 0;
}

/** 供诊断 JSON / 性能报告使用的 invoke 汇总。 */
export function perfInvokeSnapshot(): PerfInvokeCommandStats[] {
  return Array.from(invokeStats.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([command, value]) => ({
      command,
      count: value.count,
      bytes: Math.round(value.bytes),
      totalMs: Math.round(value.totalMs * 100) / 100,
      p50Ms: Math.round(percentile(value.durations, 0.5) * 100) / 100,
      p95Ms: Math.round(percentile(value.durations, 0.95) * 100) / 100,
      maxMs: Math.round(value.maxMs * 100) / 100,
      failures: value.failures,
    }));
}

/**
 * 启用 WebView Long Task 统计。浏览器/测试环境没有 PerformanceObserver 时
 * 安全降级为 no-op。返回的函数只停止 observer，不清空当前快照。
 */
export function installLongTaskObserver(): () => void {
  longTaskObserverEnabled = true;
  longTaskObserver?.disconnect();
  longTaskObserver = null;
  if (typeof PerformanceObserver === 'undefined') {
    longTaskObserverEnabled = false;
    return () => {};
  }

  const observerSessionId = currentSession.id;
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      // 旧 observer 的回调即使晚到，也不能污染新 session。
      if (observerSessionId !== currentSession.id) return;
      for (const entry of list.getEntries()) {
        const duration = Math.max(0, entry.duration);
        longTaskStats.count += 1;
        longTaskStats.totalBlockingTimeMs += Math.max(0, duration - 50);
        longTaskStats.maxMs = Math.max(longTaskStats.maxMs, duration);
      }
    });
    observer.observe({ type: 'longtask', buffered: false });
    longTaskObserver = observer;
  } catch {
    // WebView2 某些版本声明 PerformanceObserver 但不支持 longtask 类型。
    longTaskObserver = null;
    longTaskObserverEnabled = false;
  }
  return () => {
    // 该 stop 函数只属于创建它的 observer。perfReset 会重建 observer，
    // 旧调用方随后 stop 时不能把新 session 的 observer 一并关掉。
    observer?.disconnect();
    if (observer && longTaskObserver === observer) {
      longTaskObserver = null;
      longTaskObserverEnabled = false;
    }
  };
}

export function perfLongTaskSnapshot(): PerfLongTaskStats {
  return {
    count: longTaskStats.count,
    totalBlockingTimeMs: Math.round(longTaskStats.totalBlockingTimeMs * 100) / 100,
    maxMs: Math.round(longTaskStats.maxMs * 100) / 100,
  };
}

function debugPerf(span: PerfSpan): void {
  // 控制台即时可见（不受 DEBUG 开关限制——打点本身极廉价，且是排障关键线索）
  console.log(
    `[perf] ${span.label}: ${span.durationMs > 0 ? `${Math.round(span.durationMs)}ms` : '事件'} @ +${Math.round(span.startMs)}ms`,
    span.meta ?? '',
  );
}

/** 诊断 JSON 用快照 */
export function perfSnapshot(): {
  sessionStartMs: number;
  totalMs: number;
  sessionId: number;
  session: PerfSession;
  spans: PerfSpan[];
  invokes: PerfInvokeCommandStats[];
  longTasks: PerfLongTaskStats;
} {
  return {
    sessionStartMs,
    totalMs: Math.round(performance.now() - sessionStartMs),
    sessionId: currentSession.id,
    session: perfCurrentSession(),
    spans: spans.slice(),
    invokes: perfInvokeSnapshot(),
    longTasks: perfLongTaskSnapshot(),
  };
}

/** 人类可读摘要（对齐文本表） */
export function perfSummary(): string {
  const invokes = perfInvokeSnapshot();
  const longTasks = perfLongTaskSnapshot();
  if (spans.length === 0 && invokes.length === 0 && longTasks.count === 0) return '(无性能埋点数据)';
  const lines = ['阶段耗时（相对会话起点）:', '─'.repeat(64)];
  for (const s of spans) {
    const dur = s.durationMs > 0 ? `${Math.round(s.durationMs)}ms`.padEnd(8) : '  事件 ';
    lines.push(`${`+${Math.round(s.startMs)}ms`.padStart(10)}  ${dur}  ${s.label}`);
  }
  lines.push('─'.repeat(64));
  lines.push(`总时长: ${(performance.now() - sessionStartMs).toFixed(0)}ms`);
  if (invokes.length > 0) {
    lines.push(`Tauri IPC: ${invokes.reduce((sum, item) => sum + item.count, 0)} 次, ${Math.round(invokes.reduce((sum, item) => sum + item.bytes, 0))} B`);
  }
  lines.push(`Long Task: ${longTasks.count} 次, blocking ${Math.round(longTasks.totalBlockingTimeMs)}ms, max ${Math.round(longTasks.maxMs)}ms`);
  return lines.join('\n');
}
