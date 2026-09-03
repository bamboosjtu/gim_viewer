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
  /** 已测得的请求 + 响应字节数；普通对象不会为测量而重复序列化。 */
  bytes: number;
  /** 该 command 的所有调用是否都得到了完整字节测量。 */
  bytesMeasured: boolean;
  /** 完整测得字节数的调用次数。 */
  measuredCalls: number;
  /** 因普通对象/未知响应而未完整测量字节数的调用次数。 */
  unmeasuredCalls: number;
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

/** 变电加载的产品时刻；名称保持稳定，供 Tauri 采集脚本和报告使用。 */
export type PerfProductMoment = 'semanticReady' | 'firstGeometryReady' | 'fullModelReady';

export interface PerfProductMomentInfo {
  atMs: number;
  meta?: Record<string, unknown>;
  sessionId: number;
}

/** 分阶段内存样本。RSS 与 JS heap 必须分别标注来源，不能互相替代。 */
export interface PerfMemorySample {
  label: string;
  atMs: number;
  sessionId: number;
  rssBytes: number | null;
  rssSource?: string;
  jsHeapUsedBytes: number | null;
  jsHeapTotalBytes: number | null;
  jsHeapLimitBytes: number | null;
  meta?: Record<string, unknown>;
}

/** 单个 IFC 的磁盘读取与文本解码 profile。 */
export interface PerfSubstationIfcReadProfile {
  modelId: string;
  entryPath: string;
  bytes: number;
  readMs: number;
  decodeMs: number;
  found: boolean;
  error?: string;
}

/** 单个 IFC 的 Spatial Semantic 分阶段 profile。 */
export interface PerfSubstationIfcProfile {
  modelId: string;
  entryPath: string;
  sourceBytes: number;
  totalMs: number;
  stepScanMs: number;
  rawEntityCount: number;
  detailEntityCount: number;
  placementEntityCount: number;
  placementDetailMs: number;
  spatialEntityCount: number;
  spatialEntityMs: number;
  propertyEntityCount: number;
  quantityEntityCount: number;
  propertyValueCount: number;
  quantityValueCount: number;
  materialEntityCount: number;
  classificationEntityCount: number;
  propertyMs: number;
  relationshipRecordCount: number;
  relationshipReferenceCount: number;
  relationshipMs: number;
  finalizeMs: number;
  objectCount: number;
  containedObjectCount: number;
  parseError?: string;
}

export interface PerfSubstationFinalizeProfile {
  durationMs: number;
  modelCount: number;
  spatialNodeCount: number;
  objectCount: number;
  linkCount: number;
  cbmLinkCount: number;
  uncontainedIfcObjects: number;
}

export interface PerfSubstationStats {
  ifcReads: PerfSubstationIfcReadProfile[];
  ifcParses: PerfSubstationIfcProfile[];
  finalize: PerfSubstationFinalizeProfile[];
}

/** Rust batch_read_cached_files 的内部阶段统计（不含 WebView IPC 往返）。 */
export interface PerfBatchReadStats {
  count: number;
  requestedEntries: number;
  hitEntries: number;
  missEntries: number;
  bytes: number;
  totalReadMs: number;
  totalResolveMs: number;
  totalEncodeMs: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface InvokeAccumulator {
  count: number;
  bytes: number;
  measuredCalls: number;
  unmeasuredCalls: number;
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
const productMoments = new Map<PerfProductMoment, PerfProductMomentInfo>();
let memorySamples: PerfMemorySample[] = [];
let substationIfcReads: PerfSubstationIfcReadProfile[] = [];
let substationIfcParses: PerfSubstationIfcProfile[] = [];
let substationFinalizes: PerfSubstationFinalizeProfile[] = [];
interface BatchReadAccumulator {
  count: number;
  requestedEntries: number;
  hitEntries: number;
  missEntries: number;
  bytes: number;
  totalReadMs: number;
  totalResolveMs: number;
  totalEncodeMs: number;
  totalMs: number;
  maxMs: number;
  durations: number[];
}
let batchReadStats: BatchReadAccumulator = {
  count: 0,
  requestedEntries: 0,
  hitEntries: 0,
  missEntries: 0,
  bytes: 0,
  totalReadMs: 0,
  totalResolveMs: 0,
  totalEncodeMs: 0,
  totalMs: 0,
  maxMs: 0,
  durations: [],
};
let longTaskObserver: PerformanceObserver | null = null;
let longTaskObserverEnabled = false;

function cloneSession(session: PerfSession): PerfSession {
  return { ...session };
}

/** 当前性能会话快照。异步任务应在启动时捕获并在写入时传回。 */
export function perfCurrentSession(): PerfSession {
  return cloneSession(currentSession);
}

/**
 * 更新当前性能会话的工程身份，但不清空已经采集的 span。
 *
 * 打开 GIM 时，文件信息/缓存校验发生在拿到 SQLite project_id 之前；如果
 * 此处再次调用 perfReset，会把冷启动前半段（尤其是原生解压前的准备时间）
 * 丢掉。身份更新仍然保留同一个 session id，因此在途旧任务继续受到原有
 * session 隔离规则保护。
 */
export function perfUpdateSessionIdentity(identity: PerfSessionIdentity): PerfSession {
  currentSession = { ...currentSession, ...identity };
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
  batchReadStats = {
    count: 0,
    requestedEntries: 0,
    hitEntries: 0,
    missEntries: 0,
    bytes: 0,
    totalReadMs: 0,
    totalResolveMs: 0,
    totalEncodeMs: 0,
    totalMs: 0,
    maxMs: 0,
    durations: [],
  };
  longTaskStats = { count: 0, totalBlockingTimeMs: 0, maxMs: 0 };
  productMoments.clear();
  if (import.meta.env?.DEV) {
    (globalThis as { __GIM_DEV_SUBSTATION_PRODUCT_MOMENTS__?: Record<string, unknown> })
      .__GIM_DEV_SUBSTATION_PRODUCT_MOMENTS__ = {};
  }
  memorySamples = [];
  substationIfcReads = [];
  substationIfcParses = [];
  substationFinalizes = [];
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
 * 记录一个已经在其它运行时完成的计时区间（例如 Rust/同步解析器）。
 * startMs 是按“完成时刻 - duration”反推的近似时间轴位置；精确阶段数据
 * 同时保存在 meta/结构化 profile 中，不依赖该近似位置。
 */
export function perfRecordExternalSpan(
  label: string,
  durationMs: number,
  meta?: Record<string, unknown>,
  session: PerfSession = currentSession,
): void {
  if (!perfIsCurrentSession(session)) return;
  const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  const completedAt = performance.now();
  const span: PerfSpan = {
    label,
    startMs: Math.max(0, completedAt - sessionStartMs - safeDuration),
    durationMs: safeDuration,
    meta,
    sessionId: session.id,
  };
  spans.push(span);
  debugPerf(span);
}

/** 记录稳定的产品时刻；同一时刻只保留第一次提交。 */
export function perfMarkProductMoment(
  moment: PerfProductMoment,
  meta?: Record<string, unknown>,
  session: PerfSession = currentSession,
): void {
  if (!perfIsCurrentSession(session) || productMoments.has(moment)) return;
  const atMs = performance.now() - sessionStartMs;
  productMoments.set(moment, { atMs, meta, sessionId: session.id });
  perfMark(moment, meta, session);
  // 开发期采集器可轮询该只读快照，不影响生产构建行为。
  if (import.meta.env?.DEV) {
    const target = globalThis as { __GIM_DEV_SUBSTATION_PRODUCT_MOMENTS__?: Record<string, unknown> };
    target.__GIM_DEV_SUBSTATION_PRODUCT_MOMENTS__ = Object.fromEntries(
      [...productMoments.entries()].map(([key, value]) => [key, { ...value }]),
    );
  }
}

export function perfProductMomentSnapshot(): Record<PerfProductMoment, PerfProductMomentInfo | null> {
  return {
    semanticReady: productMoments.get('semanticReady') ?? null,
    firstGeometryReady: productMoments.get('firstGeometryReady') ?? null,
    fullModelReady: productMoments.get('fullModelReady') ?? null,
  };
}

/** 记录一个变电阶段的 RSS/JS heap 样本；缺失值统一为 null。 */
export function perfRecordMemorySample(
  label: string,
  sample: {
    rssBytes?: number | null;
    rssSource?: string;
    jsHeapUsedBytes?: number | null;
    jsHeapTotalBytes?: number | null;
    jsHeapLimitBytes?: number | null;
    meta?: Record<string, unknown>;
  },
  session: PerfSession = currentSession,
): void {
  if (!perfIsCurrentSession(session)) return;
  const finiteOrNull = (value: number | null | undefined): number | null =>
    value != null && Number.isFinite(value) && value >= 0 ? value : null;
  memorySamples.push({
    label,
    atMs: performance.now() - sessionStartMs,
    sessionId: session.id,
    rssBytes: finiteOrNull(sample.rssBytes),
    ...(sample.rssSource ? { rssSource: sample.rssSource } : {}),
    jsHeapUsedBytes: finiteOrNull(sample.jsHeapUsedBytes),
    jsHeapTotalBytes: finiteOrNull(sample.jsHeapTotalBytes),
    jsHeapLimitBytes: finiteOrNull(sample.jsHeapLimitBytes),
    meta: sample.meta,
  });
}

export function perfMemorySnapshot(): PerfMemorySample[] {
  return memorySamples.map((sample) => ({ ...sample, meta: sample.meta ? { ...sample.meta } : undefined }));
}

/** 记录变电 IFC 读取 profile，并单列 read/decode 阶段。 */
export function perfRecordSubstationIfcRead(
  profile: PerfSubstationIfcReadProfile,
  session: PerfSession = currentSession,
): void {
  if (!perfIsCurrentSession(session)) return;
  const normalized = { ...profile };
  substationIfcReads.push(normalized);
  perfRecordExternalSpan(
    `变电 IFC read/decode · ${profile.entryPath}`,
    Math.max(0, profile.readMs) + Math.max(0, profile.decodeMs),
    normalized,
    session,
  );
}

/** 记录单 IFC Spatial Semantic 分阶段 profile。 */
export function perfRecordSubstationIfcProfile(
  profile: PerfSubstationIfcProfile,
  session: PerfSession = currentSession,
): void {
  if (!perfIsCurrentSession(session)) return;
  const normalized = { ...profile };
  substationIfcParses.push(normalized);
  const prefix = `变电 IFC Spatial Semantic · ${profile.entryPath}`;
  perfRecordExternalSpan(`${prefix} · total`, profile.totalMs, normalized, session);
  perfRecordExternalSpan(`${prefix} · STEP scan`, profile.stepScanMs, { rawEntityCount: profile.rawEntityCount }, session);
  perfRecordExternalSpan(`${prefix} · placement/detail`, profile.placementDetailMs, {
    detailEntityCount: profile.detailEntityCount,
    placementEntityCount: profile.placementEntityCount,
  }, session);
  perfRecordExternalSpan(`${prefix} · spatial entity`, profile.spatialEntityMs, { spatialEntityCount: profile.spatialEntityCount }, session);
  perfRecordExternalSpan(`${prefix} · property/quantity/material/classification`, profile.propertyMs, {
    propertyEntityCount: profile.propertyEntityCount,
    quantityEntityCount: profile.quantityEntityCount,
    propertyValueCount: profile.propertyValueCount,
    quantityValueCount: profile.quantityValueCount,
    materialEntityCount: profile.materialEntityCount,
    classificationEntityCount: profile.classificationEntityCount,
  }, session);
  perfRecordExternalSpan(`${prefix} · relationships`, profile.relationshipMs, {
    relationshipRecordCount: profile.relationshipRecordCount,
    relationshipReferenceCount: profile.relationshipReferenceCount,
  }, session);
  perfRecordExternalSpan(`${prefix} · finalize`, profile.finalizeMs, {
    objectCount: profile.objectCount,
    containedObjectCount: profile.containedObjectCount,
  }, session);
}

export function perfRecordSubstationFinalizeProfile(
  profile: PerfSubstationFinalizeProfile,
  session: PerfSession = currentSession,
): void {
  if (!perfIsCurrentSession(session)) return;
  const normalized = { ...profile };
  substationFinalizes.push(normalized);
  perfRecordExternalSpan('变电 spatial finalize / CBM linkage', profile.durationMs, normalized, session);
}

export function perfSubstationSnapshot(): PerfSubstationStats {
  return {
    ifcReads: substationIfcReads.map((item) => ({ ...item })),
    ifcParses: substationIfcParses.map((item) => ({ ...item })),
    finalize: substationFinalizes.map((item) => ({ ...item })),
  };
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
  bytesMeasured = true,
): void {
  if (sessionId !== currentSession.id) return;
  const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  const safeBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  const current = invokeStats.get(command) ?? {
    count: 0,
    bytes: 0,
    measuredCalls: 0,
    unmeasuredCalls: 0,
    totalMs: 0,
    maxMs: 0,
    failures: 0,
    durations: [],
  } satisfies InvokeAccumulator;
  current.count += 1;
  current.bytes += safeBytes;
  if (bytesMeasured) current.measuredCalls += 1;
  else current.unmeasuredCalls += 1;
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
      bytesMeasured: value.unmeasuredCalls === 0,
      measuredCalls: value.measuredCalls,
      unmeasuredCalls: value.unmeasuredCalls,
      totalMs: Math.round(value.totalMs * 100) / 100,
      p50Ms: Math.round(percentile(value.durations, 0.5) * 100) / 100,
      p95Ms: Math.round(percentile(value.durations, 0.95) * 100) / 100,
      maxMs: Math.round(value.maxMs * 100) / 100,
      failures: value.failures,
    }));
}

/** 记录 Rust batch_read_cached_files v2 的内部阶段计时。 */
export function perfRecordBatchRead(
  profile: {
    readMs: number;
    resolveMs: number;
    encodeMs: number;
    totalMs: number;
    bytes: number;
    entryCount: number;
    hitCount: number;
  },
  sessionId: number = currentSession.id,
): void {
  if (sessionId !== currentSession.id) return;
  const safe = (value: number): number => Number.isFinite(value) && value >= 0 ? value : 0;
  const totalMs = safe(profile.totalMs);
  const entryCount = Math.max(0, Math.floor(safe(profile.entryCount)));
  const hitCount = Math.min(entryCount, Math.max(0, Math.floor(safe(profile.hitCount))));
  batchReadStats.count += 1;
  batchReadStats.requestedEntries += entryCount;
  batchReadStats.hitEntries += hitCount;
  batchReadStats.missEntries += entryCount - hitCount;
  batchReadStats.bytes += safe(profile.bytes);
  batchReadStats.totalReadMs += safe(profile.readMs);
  batchReadStats.totalResolveMs += safe(profile.resolveMs);
  batchReadStats.totalEncodeMs += safe(profile.encodeMs);
  batchReadStats.totalMs += totalMs;
  batchReadStats.maxMs = Math.max(batchReadStats.maxMs, totalMs);
  batchReadStats.durations.push(totalMs);
}

/** 供诊断 JSON / 性能报告使用的 batch 内部统计。 */
export function perfBatchReadSnapshot(): PerfBatchReadStats {
  return {
    count: batchReadStats.count,
    requestedEntries: batchReadStats.requestedEntries,
    hitEntries: batchReadStats.hitEntries,
    missEntries: batchReadStats.missEntries,
    bytes: Math.round(batchReadStats.bytes),
    totalReadMs: Math.round(batchReadStats.totalReadMs * 100) / 100,
    totalResolveMs: Math.round(batchReadStats.totalResolveMs * 100) / 100,
    totalEncodeMs: Math.round(batchReadStats.totalEncodeMs * 100) / 100,
    totalMs: Math.round(batchReadStats.totalMs * 100) / 100,
    p50Ms: Math.round(percentile(batchReadStats.durations, 0.5) * 100) / 100,
    p95Ms: Math.round(percentile(batchReadStats.durations, 0.95) * 100) / 100,
    maxMs: Math.round(batchReadStats.maxMs * 100) / 100,
  };
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
  batchReads: PerfBatchReadStats;
  longTasks: PerfLongTaskStats;
  productMoments: Record<PerfProductMoment, PerfProductMomentInfo | null>;
  memory: PerfMemorySample[];
  substation: PerfSubstationStats;
} {
  return {
    sessionStartMs,
    totalMs: Math.round(performance.now() - sessionStartMs),
    sessionId: currentSession.id,
    session: perfCurrentSession(),
    spans: spans.slice(),
    invokes: perfInvokeSnapshot(),
    batchReads: perfBatchReadSnapshot(),
    longTasks: perfLongTaskSnapshot(),
    productMoments: perfProductMomentSnapshot(),
    memory: perfMemorySnapshot(),
    substation: perfSubstationSnapshot(),
  };
}

/** 人类可读摘要（对齐文本表） */
export function perfSummary(): string {
  const invokes = perfInvokeSnapshot();
  const batchReads = perfBatchReadSnapshot();
  const longTasks = perfLongTaskSnapshot();
  if (spans.length === 0 && invokes.length === 0 && batchReads.count === 0 && longTasks.count === 0 && memorySamples.length === 0) return '(无性能埋点数据)';
  const lines = ['阶段耗时（相对会话起点）:', '─'.repeat(64)];
  for (const s of spans) {
    const dur = s.durationMs > 0 ? `${Math.round(s.durationMs)}ms`.padEnd(8) : '  事件 ';
    lines.push(`${`+${Math.round(s.startMs)}ms`.padStart(10)}  ${dur}  ${s.label}`);
  }
  lines.push('─'.repeat(64));
  lines.push(`总时长: ${(performance.now() - sessionStartMs).toFixed(0)}ms`);
  if (invokes.length > 0) {
    const measured = invokes.reduce((sum, item) => sum + item.bytes, 0);
    const unmeasured = invokes.reduce((sum, item) => sum + item.unmeasuredCalls, 0);
    lines.push(`Tauri IPC: ${invokes.reduce((sum, item) => sum + item.count, 0)} 次, ${Math.round(measured)} B${unmeasured > 0 ? `（${unmeasured} 次字节未测量）` : ''}`);
  }
  if (batchReads.count > 0) {
    lines.push(`Batch Rust: ${batchReads.count} 批, ${batchReads.requestedEntries} 条（命中 ${batchReads.hitEntries}）, ${Math.round(batchReads.bytes)} B, read ${Math.round(batchReads.totalReadMs)}ms, encode ${Math.round(batchReads.totalEncodeMs)}ms, total ${Math.round(batchReads.totalMs)}ms`);
  }
  lines.push(`Long Task: ${longTasks.count} 次, blocking ${Math.round(longTasks.totalBlockingTimeMs)}ms, max ${Math.round(longTasks.maxMs)}ms`);
  const moments = perfProductMomentSnapshot();
  const momentText = (Object.entries(moments) as Array<[PerfProductMoment, PerfProductMomentInfo | null]>)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=+${Math.round(value!.atMs)}ms`)
    .join(', ');
  if (momentText) lines.push(`产品时刻: ${momentText}`);
  const rssSamples = memorySamples.filter((sample) => sample.rssBytes != null);
  const heapSamples = memorySamples.filter((sample) => sample.jsHeapUsedBytes != null);
  if (rssSamples.length > 0) {
    const peak = Math.max(...rssSamples.map((sample) => sample.rssBytes!));
    lines.push(`RSS 样本: ${rssSamples.length} 个, 峰值 ${(peak / 1024 / 1024).toFixed(1)}MB（来源以 sample.rssSource 标注）`);
  }
  if (heapSamples.length > 0) {
    const peak = Math.max(...heapSamples.map((sample) => sample.jsHeapUsedBytes!));
    lines.push(`JS heap 样本: ${heapSamples.length} 个, used 峰值 ${(peak / 1024 / 1024).toFixed(1)}MB（不等同 RSS）`);
  }
  return lines.join('\n');
}
