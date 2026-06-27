/**
 * M4-B3B / M4-B3C：档距聚合与 MATRIX0 平移分量验证服务（纯内存、只读）。
 *
 * 实际线路样本显示：wireCount=5460、towerCount=327，但每档（两端塔 BLHA 相同）
 * 存在多条 WIRE（导线分裂、地线、OPGW 共档）。本服务回答：
 * - 一个档距内有多少 WIRE？
 * - 如何按 wireType / SPLIT / KVALUE / MATRIX0 分组？
 * - MATRIX0 的 x,y,z 是否解释相位/分裂/高度？
 * - BLHA 是档距端点还是挂点？
 * - KVALUE 是否存在分布规律？
 *
 * M4-B3C 新增：WIRE 拓扑分类收口
 * - same-point：POINT0.BLHA 归一化后等于 POINT1.BLHA（同点内部连接候选）
 * - inter-point：两端 BLHA 不同（真实跨点档距候选）
 * - missing-endpoint：端点缺失
 * - same-point 不应直接进入悬链线渲染；inter-point 才是未来悬链线候选
 *
 * 边界（强制）：
 * - 只读现有内存数据（graph / mapData），不读 DB、不读 GIM 文件
 * - 不影响渲染、不修改 state、不修改 SQLite
 * - 不实现悬链线、不做弧垂计算
 * - 不将 KVALUE / MATRIX0 定义为确定语义，仅"疑似 / 候选 / 待确认"
 * - spanGroupSamples ≤ 20，每类 groupKindSamples ≤ 10，wireSamples ≤ 20
 * - blhaDistanceMeters 仅用于审计分类，不用于渲染
 */

import type { GimGraph, GimGraphNode } from '../gim/gimGraphTypes.js';
import type { LineMapData } from '../gim/lineMapData.js';

/** 单类档距样本上限（整体 Top） */
const MAX_SPAN_GROUP_SAMPLES = 20;
/** M4-B3C：每类 groupKind 样本上限 */
const MAX_PER_KIND_SAMPLES = 10;
/** 单档内导线样本上限 */
const MAX_WIRE_SAMPLES_PER_GROUP = 20;
/** distinct KVALUE 样本上限 */
const MAX_DISTINCT_KVALUES = 20;

/** M4-B3C：WIRE 拓扑分类 */
export type SpanGroupKind = 'same-point' | 'inter-point' | 'missing-endpoint';

/** MATRIX0 平移分量解析结果 */
export interface MatrixTranslation {
  /** x 平移分量（4x4 矩阵中 values[12]），疑似横担偏移 */
  x: number | null;
  /** y 平移分量（values[13]），疑似横担偏移 */
  y: number | null;
  /** z 平移分量（values[14]），疑似高度层级 */
  z: number | null;
  /** 原始元素数（16/12/9/6/4/3/1） */
  rawLength: number | null;
  /** 推断格式 */
  likelyFormat: string;
}

/** 单条 WIRE 在档距聚合中的样本 */
export interface SpanWireSample {
  /** WIRE 节点路径 */
  path: string;
  /** 导线类型 CONDUCTOR / GROUNDWIRE / OPGW / UNKNOWN */
  wireType: string;
  /** SPLIT 数值 */
  split: number | null;
  /** KVALUE 数值 */
  kValue: number | null;
  /** KVALUE 原始字符串 */
  rawKValue: string | null;
  /** POINT0.MATRIX0 平移分量 */
  point0Translation: MatrixTranslation;
  /** POINT1.MATRIX0 平移分量 */
  point1Translation: MatrixTranslation;
}

/** 单个档距聚合样本 */
export interface SpanGroupSample {
  /** 档距键 `min(p0, p1) -> max(p0, p1)` */
  spanKey: string;
  /** M4-B3C：拓扑分类 */
  groupKind: SpanGroupKind;
  /** M4-B3C：两端 BLHA 近似距离（米），same-point=0，missing-endpoint=null */
  blhaDistanceMeters: number | null;
  /** 起点 BLHA 原始字符串 */
  point0Blha: string;
  /** 终点 BLHA 原始字符串 */
  point1Blha: string;
  /** 该档距 WIRE 数 */
  wireCount: number;
  /** 按导线类型计数 */
  wireTypeCounts: Record<string, number>;
  /** 按 SPLIT 值计数（key 为字符串形式） */
  splitCounts: Record<string, number>;
  /** KVALUE 数值统计 */
  kValueStats: {
    min: number | null;
    max: number | null;
    /** KVALUE === 0 的数量 */
    zeroCount: number;
    /** KVALUE !== 0 的数量 */
    nonZeroCount: number;
    /** distinct 原始值样本（≤ MAX_DISTINCT_KVALUES） */
    distinctSampleValues: string[];
  };
  /** POINT0.MATRIX0 平移分量范围 */
  point0TranslationStats: TranslationRangeStats;
  /** POINT1.MATRIX0 平移分量范围 */
  point1TranslationStats: TranslationRangeStats;
  /** 该档距的 WIRE 样本（≤ MAX_WIRE_SAMPLES_PER_GROUP） */
  wireSamples: SpanWireSample[];
}

/** MATRIX0 平移分量范围统计 */
export interface TranslationRangeStats {
  /** x 分量最小最大值 */
  xRange: [number, number] | null;
  /** y 分量最小最大值 */
  yRange: [number, number] | null;
  /** z 分量最小最大值 */
  zRange: [number, number] | null;
}

/** M4-B3C：每类 groupKind 的大小统计 */
export interface GroupKindSizeStats {
  min: number;
  max: number;
  avg: number;
  /** 该类 WIRE 数 Top 档距（≤ MAX_PER_KIND_SAMPLES） */
  topSizes: Array<{ spanKey: string; wireCount: number }>;
}

/** 档距聚合审计报告 */
export interface LineSpanGroupingAuditReport {
  /** 生成时间（ISO 8601） */
  generatedAt: string;
  /** WIRE 节点总数 */
  wireCount: number;
  /** 唯一档距组数 */
  spanGroupCount: number;
  /** 档距组大小统计 */
  spanGroupSizeStats: {
    min: number;
    max: number;
    avg: number;
    /** WIRE 数 Top 5 档距 */
    topSizes: Array<{ spanKey: string; wireCount: number }>;
  };
  /** M4-B3C：按拓扑分类的组数 */
  groupKindCounts: Record<SpanGroupKind, number>;
  /** M4-B3C：按拓扑分类的 WIRE 总数 */
  groupKindWireCounts: Record<SpanGroupKind, number>;
  /** M4-B3C：按拓扑分类的大小统计 */
  groupKindSizeStats: Record<SpanGroupKind, GroupKindSizeStats>;
  /** 档距组样本（≤ MAX_SPAN_GROUP_SAMPLES，整体 Top，向后兼容） */
  spanGroupSamples: SpanGroupSample[];
  /** M4-B3C：same-point 同点内部连接样本（≤ MAX_PER_KIND_SAMPLES） */
  samePointGroupSamples: SpanGroupSample[];
  /** M4-B3C：inter-point 真实跨点档距样本（≤ MAX_PER_KIND_SAMPLES） */
  interPointSpanSamples: SpanGroupSample[];
  /** M4-B3C：missing-endpoint 端点缺失样本（≤ MAX_PER_KIND_SAMPLES） */
  missingEndpointGroupSamples: SpanGroupSample[];
  /** 观察结论（疑似 / 候选，不写结论） */
  observations: string[];
  /** 阻塞问题 */
  blockingQuestions: string[];
  /** M4-B4 决策建议 */
  recommendations: string[];
}

/**
 * 构建 M4-B3B / M4-B3C 档距聚合审计报告。
 *
 * @param args.graph 已构建的线路工程图
 * @param args.mapData 已提取的地图数据（用于 wireType 反查）
 */
export function buildLineSpanGroupingAuditReport(args: {
  graph: unknown;
  mapData: unknown;
}): LineSpanGroupingAuditReport {
  const graph = args.graph as GimGraph | null;
  const mapData = args.mapData as LineMapData | null;

  // 兜底：graph 缺失时返回空报告
  if (!graph || !graph.nodesByPath) {
    return emptySpanGroupingReport();
  }

  // 1. 收集 WIRE 节点 + path → wireType 反查
  const wireNodes: GimGraphNode[] = [];
  const wireTypeByPath = new Map<string, string>();
  for (const node of graph.nodesByPath.values()) {
    if (node.entityName === 'WIRE') wireNodes.push(node);
  }
  if (mapData && Array.isArray(mapData.wires)) {
    for (const w of mapData.wires) {
      if (w.nodeRef?.path) wireTypeByPath.set(w.nodeRef.path, w.wireType || 'UNKNOWN');
    }
  }
  const wireCount = wireNodes.length;

  // 2. 按 spanKey 分组（POINT0.BLHA + POINT1.BLHA 去方向）
  const spanGroups = new Map<string, GimGraphNode[]>();
  for (const node of wireNodes) {
    const p0 = node.rawProps['POINT0.BLHA'] || '';
    const p1 = node.rawProps['POINT1.BLHA'] || '';
    const key = buildSpanKey(p0, p1);
    let arr = spanGroups.get(key);
    if (!arr) {
      arr = [];
      spanGroups.set(key, arr);
    }
    arr.push(node);
  }

  // 3. 分类每个 group 并计算距离 + 聚合 per-kind 统计
  const spanGroupCount = spanGroups.size;
  let minSize = wireCount;
  let maxSize = 0;
  let totalSize = 0;
  const allSizes: Array<{ spanKey: string; wireCount: number; kind: SpanGroupKind }> = [];

  // per-kind 聚合
  const kindCounts: Record<SpanGroupKind, number> = { 'same-point': 0, 'inter-point': 0, 'missing-endpoint': 0 };
  const kindWireCounts: Record<SpanGroupKind, number> = { 'same-point': 0, 'inter-point': 0, 'missing-endpoint': 0 };
  const kindSizes: Record<SpanGroupKind, number[]> = { 'same-point': [], 'inter-point': [], 'missing-endpoint': [] };
  const kindAllSizes: Record<SpanGroupKind, Array<{ spanKey: string; wireCount: number }>> = {
    'same-point': [], 'inter-point': [], 'missing-endpoint': [],
  };
  // per-kind KVALUE / zRange 聚合（用于观察项）
  const kindKValue: Record<SpanGroupKind, { zero: number; nonZero: number }> = {
    'same-point': { zero: 0, nonZero: 0 },
    'inter-point': { zero: 0, nonZero: 0 },
    'missing-endpoint': { zero: 0, nonZero: 0 },
  };
  const kindP0Z: Record<SpanGroupKind, number[]> = { 'same-point': [], 'inter-point': [], 'missing-endpoint': [] };
  const kindP1Z: Record<SpanGroupKind, number[]> = { 'same-point': [], 'inter-point': [], 'missing-endpoint': [] };

  // 为每个 group 预计算 sample（含 groupKind + distance）
  const groupSamplesByKey = new Map<string, SpanGroupSample>();

  for (const [key, nodes] of spanGroups) {
    const size = nodes.length;
    if (size < minSize) minSize = size;
    if (size > maxSize) maxSize = size;
    totalSize += size;

    const kind = classifySpanGroup(key);
    const distance = computeBlhaDistanceMeters(key, kind);

    kindCounts[kind]++;
    kindWireCounts[kind] += size;
    kindSizes[kind].push(size);
    kindAllSizes[kind].push({ spanKey: key, wireCount: size });

    // 构建 sample（同时累加 per-kind KVALUE / zRange）
    const sample = buildSpanGroupSample(key, nodes, wireTypeByPath, kind, distance);
    groupSamplesByKey.set(key, sample);

    // 累加 per-kind KVALUE
    kindKValue[kind].zero += sample.kValueStats.zeroCount;
    kindKValue[kind].nonZero += sample.kValueStats.nonZeroCount;
    // 累加 per-kind zRange（从 translationStats 取所有 z 值）
    if (sample.point0TranslationStats.zRange) {
      kindP0Z[kind].push(sample.point0TranslationStats.zRange[0], sample.point0TranslationStats.zRange[1]);
    }
    if (sample.point1TranslationStats.zRange) {
      kindP1Z[kind].push(sample.point1TranslationStats.zRange[0], sample.point1TranslationStats.zRange[1]);
    }

    allSizes.push({ spanKey: key, wireCount: size, kind });
  }

  const avg = spanGroupCount > 0 ? totalSize / spanGroupCount : 0;

  // 4. 整体 Top 5（向后兼容 spanGroupSizeStats.topSizes）
  allSizes.sort((a, b) => b.wireCount - a.wireCount);
  const topSizes = allSizes.slice(0, 5).map(s => ({ spanKey: s.spanKey, wireCount: s.wireCount }));

  // 5. 整体 Top 20 样本（向后兼容 spanGroupSamples）
  const sampleKeys = allSizes
    .slice(0, Math.min(MAX_SPAN_GROUP_SAMPLES, spanGroupCount))
    .map(s => s.spanKey);
  const spanGroupSamples: SpanGroupSample[] = [];
  for (const key of sampleKeys) {
    const s = groupSamplesByKey.get(key);
    if (s) spanGroupSamples.push(s);
  }

  // 6. M4-B3C：每类 Top 10 样本
  const samePointGroupSamples = pickTopKindSamples(kindAllSizes['same-point'], groupSamplesByKey, MAX_PER_KIND_SAMPLES);
  const interPointSpanSamples = pickTopKindSamples(kindAllSizes['inter-point'], groupSamplesByKey, MAX_PER_KIND_SAMPLES);
  const missingEndpointGroupSamples = pickTopKindSamples(kindAllSizes['missing-endpoint'], groupSamplesByKey, MAX_PER_KIND_SAMPLES);

  // 7. per-kind size stats
  const groupKindSizeStats: Record<SpanGroupKind, GroupKindSizeStats> = {
    'same-point': buildKindSizeStats(kindSizes['same-point'], kindAllSizes['same-point']),
    'inter-point': buildKindSizeStats(kindSizes['inter-point'], kindAllSizes['inter-point']),
    'missing-endpoint': buildKindSizeStats(kindSizes['missing-endpoint'], kindAllSizes['missing-endpoint']),
  };

  // 8. per-kind zRange 聚合
  const kindP0ZRange: Record<SpanGroupKind, [number, number] | null> = {
    'same-point': rangeOf(kindP0Z['same-point']),
    'inter-point': rangeOf(kindP0Z['inter-point']),
    'missing-endpoint': rangeOf(kindP0Z['missing-endpoint']),
  };
  const kindP1ZRange: Record<SpanGroupKind, [number, number] | null> = {
    'same-point': rangeOf(kindP1Z['same-point']),
    'inter-point': rangeOf(kindP1Z['inter-point']),
    'missing-endpoint': rangeOf(kindP1Z['missing-endpoint']),
  };

  // 9. 生成观察结论 / 阻塞问题 / 建议
  const observations = buildObservations(
    wireCount, spanGroupCount, minSize, maxSize, avg,
    spanGroupSamples, kindCounts, kindWireCounts, groupKindSizeStats,
    kindKValue, kindP0ZRange, kindP1ZRange,
  );
  const blockingQuestions = buildBlockingQuestions(spanGroupCount, minSize, maxSize, kindCounts);
  const recommendations = buildRecommendations(
    wireCount, spanGroupCount, minSize, maxSize, kindCounts,
  );

  return {
    generatedAt: new Date().toISOString(),
    wireCount,
    spanGroupCount,
    spanGroupSizeStats: {
      min: spanGroupCount > 0 ? minSize : 0,
      max: maxSize,
      avg,
      topSizes,
    },
    groupKindCounts: kindCounts,
    groupKindWireCounts: kindWireCounts,
    groupKindSizeStats,
    spanGroupSamples,
    samePointGroupSamples,
    interPointSpanSamples,
    missingEndpointGroupSamples,
    observations,
    blockingQuestions,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// spanKey 规则
// ---------------------------------------------------------------------------

/**
 * 构建 spanKey：`min(p0, p1) -> max(p0, p1)`。
 *
 * - 排序去方向：A→B 与 B→A 视为同一档距
 * - 缺失端点 → 'missing-endpoint'
 * - 不使用 BACKSTRING / FRONTSTRING（保持本轮范围聚焦）
 * - 归一化：按逗号分割后逐段 trim 再 join，避免 '1,2,3' 与 '1, 2, 3' 产生不同 key
 */
function buildSpanKey(p0: string, p1: string): string {
  if (!p0 && !p1) return 'missing-endpoint';
  if (!p0 || !p1) return 'missing-endpoint';
  const a = normalizeBlha(p0);
  const b = normalizeBlha(p1);
  return a <= b ? `${a} -> ${b}` : `${b} -> ${a}`;
}

/** BLHA 归一化：按逗号分割后逐段 trim 再 join（用于 spanKey 与 same-point 比较） */
function normalizeBlha(blha: string): string {
  return blha.split(',').map(s => s.trim()).filter(s => s.length > 0).join(',');
}

// ---------------------------------------------------------------------------
// M4-B3C：拓扑分类
// ---------------------------------------------------------------------------

/**
 * M4-B3C：分类档距组。
 *
 * - spanKey === 'missing-endpoint' → missing-endpoint
 * - 归一化后 p0 === p1 → same-point（同点内部连接候选）
 * - 否则 → inter-point（真实跨点档距候选）
 */
function classifySpanGroup(spanKey: string): SpanGroupKind {
  if (spanKey === 'missing-endpoint') return 'missing-endpoint';
  const [p0, p1] = parseSpanKey(spanKey);
  if (!p0 || !p1) return 'missing-endpoint';
  if (p0 === p1) return 'same-point';
  return 'inter-point';
}

/**
 * M4-B3C：计算两端 BLHA 近似距离（Haversine，米）。
 *
 * - same-point → 0
 * - missing-endpoint → null
 * - inter-point → Haversine（仅用 lat/lng，不含高程）
 *
 * 注意：仅用于审计分类，不用于渲染；不引入坐标转换 / GCJ-02。
 */
function computeBlhaDistanceMeters(spanKey: string, kind: SpanGroupKind): number | null {
  if (kind === 'missing-endpoint') return null;
  if (kind === 'same-point') return 0;
  const [p0, p1] = parseSpanKey(spanKey);
  const c0 = parseBlhaLatlng(p0);
  const c1 = parseBlhaLatlng(p1);
  if (!c0 || !c1) return null;
  return haversineMeters(c0.lat, c0.lng, c1.lat, c1.lng);
}

/** 解析 BLHA 的 lat / lng（前两段） */
function parseBlhaLatlng(blha: string): { lat: number; lng: number } | null {
  if (!blha) return null;
  const parts = blha.split(',');
  if (parts.length < 2) return null;
  const lat = parseFloat(parts[0].trim());
  const lng = parseFloat(parts[1].trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/** Haversine 距离（米），地球半径 6371000m */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// MATRIX0 解析
// ---------------------------------------------------------------------------

/**
 * 解析 MATRIX0 字符串为平移分量。
 *
 * 规则：
 * - 分隔符：逗号或空格
 * - 长度 = 16：4x4 矩阵，平移分量为 values[12]/[13]/[14]
 * - 长度 = 12：3x4 矩阵，平移分量为 values[3]/[7]/[11]
 * - 其他长度：x/y/z = null，仅记录 rawLength 与 likelyFormat
 *
 * 注意：不确认单位或坐标系，仅称为"疑似平移分量"。
 */
function parseMatrixTranslation(matrix: string | null): MatrixTranslation {
  const empty: MatrixTranslation = {
    x: null, y: null, z: null,
    rawLength: null,
    likelyFormat: 'unknown',
  };
  if (!matrix) return empty;

  // 分隔符：优先逗号，回退空格
  let parts = matrix.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length <= 1) {
    parts = matrix.trim().split(/\s+/).filter(s => s.length > 0);
  }
  if (parts.length === 0) return empty;

  const len = parts.length;
  const likelyFormat = guessMatrixFormatByLength(len);

  // 4x4 矩阵：平移在 [12][13][14]
  if (len === 16) {
    return {
      x: tryParse(parts[12]),
      y: tryParse(parts[13]),
      z: tryParse(parts[14]),
      rawLength: len,
      likelyFormat,
    };
  }
  // 3x4 矩阵：行优先 [R0 R1 R2 T]，平移在 [3][7][11]
  if (len === 12) {
    return {
      x: tryParse(parts[3]),
      y: tryParse(parts[7]),
      z: tryParse(parts[11]),
      rawLength: len,
      likelyFormat,
    };
  }
  // 其他格式：仅记录长度与格式，不解析平移
  return {
    x: null, y: null, z: null,
    rawLength: len,
    likelyFormat,
  };
}

/** 根据元素数推断格式 */
function guessMatrixFormatByLength(len: number): string {
  if (len === 16) return '4x4-matrix';
  if (len === 12) return '3x4-matrix';
  if (len === 9) return '3x3-matrix';
  if (len === 6) return '6-tuple';
  if (len === 4) return 'quaternion';
  if (len === 3) return 'triplet';
  if (len === 1) return 'scalar';
  return `unknown(${len})`;
}

/** 安全 parseFloat，失败返回 null */
function tryParse(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = parseFloat(value.trim());
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// 档距组样本构建
// ---------------------------------------------------------------------------

function buildSpanGroupSample(
  spanKey: string,
  nodes: GimGraphNode[],
  wireTypeByPath: Map<string, string>,
  groupKind: SpanGroupKind,
  blhaDistanceMeters: number | null,
): SpanGroupSample {
  // 拆分 spanKey 取原始 BLHA（注意：spanKey 是 'min -> max' 形式）
  const [p0, p1] = parseSpanKey(spanKey);

  const wireTypeCounts: Record<string, number> = {};
  const splitCounts: Record<string, number> = {};
  const kValues: number[] = [];
  let kValueZeroCount = 0;
  let kValueNonZeroCount = 0;
  const distinctKValues = new Set<string>();
  let distinctKValueArray: string[] = [];

  const p0Xs: number[] = [], p0Ys: number[] = [], p0Zs: number[] = [];
  const p1Xs: number[] = [], p1Ys: number[] = [], p1Zs: number[] = [];
  const wireSamples: SpanWireSample[] = [];

  for (const node of nodes) {
    const raw = node.rawProps;
    const wireType = wireTypeByPath.get(node.path) || 'UNKNOWN';
    wireTypeCounts[wireType] = (wireTypeCounts[wireType] || 0) + 1;

    const splitRaw = raw['SPLIT'] || null;
    const splitNum = splitRaw ? tryParseInt(splitRaw) : null;
    if (splitRaw) {
      splitCounts[splitRaw] = (splitCounts[splitRaw] || 0) + 1;
    }

    const kValueRaw = raw['KVALUE'] || null;
    const kValueNum = kValueRaw ? tryParse(kValueRaw) : null;
    if (kValueNum !== null) {
      kValues.push(kValueNum);
      if (kValueNum === 0) kValueZeroCount++;
      else kValueNonZeroCount++;
    }
    if (kValueRaw && distinctKValues.size < MAX_DISTINCT_KVALUES) {
      if (!distinctKValues.has(kValueRaw)) {
        distinctKValues.add(kValueRaw);
        distinctKValueArray.push(kValueRaw);
      }
    }

    const p0m0 = parseMatrixTranslation(raw['POINT0.MATRIX0'] || null);
    const p1m0 = parseMatrixTranslation(raw['POINT1.MATRIX0'] || null);
    if (p0m0.x !== null) p0Xs.push(p0m0.x);
    if (p0m0.y !== null) p0Ys.push(p0m0.y);
    if (p0m0.z !== null) p0Zs.push(p0m0.z);
    if (p1m0.x !== null) p1Xs.push(p1m0.x);
    if (p1m0.y !== null) p1Ys.push(p1m0.y);
    if (p1m0.z !== null) p1Zs.push(p1m0.z);

    // 仅取前 MAX_WIRE_SAMPLES_PER_GROUP 条样本
    if (wireSamples.length < MAX_WIRE_SAMPLES_PER_GROUP) {
      wireSamples.push({
        path: node.path,
        wireType,
        split: splitNum,
        kValue: kValueNum,
        rawKValue: kValueRaw,
        point0Translation: p0m0,
        point1Translation: p1m0,
      });
    }
  }

  const kValueMin = kValues.length > 0 ? Math.min(...kValues) : null;
  const kValueMax = kValues.length > 0 ? Math.max(...kValues) : null;

  return {
    spanKey,
    groupKind,
    blhaDistanceMeters,
    point0Blha: p0,
    point1Blha: p1,
    wireCount: nodes.length,
    wireTypeCounts,
    splitCounts,
    kValueStats: {
      min: kValueMin,
      max: kValueMax,
      zeroCount: kValueZeroCount,
      nonZeroCount: kValueNonZeroCount,
      distinctSampleValues: distinctKValueArray,
    },
    point0TranslationStats: buildRangeStats(p0Xs, p0Ys, p0Zs),
    point1TranslationStats: buildRangeStats(p1Xs, p1Ys, p1Zs),
    wireSamples,
  };
}

/** 解析 spanKey 还原 p0 / p1 原始字符串（归一化后的） */
function parseSpanKey(spanKey: string): [string, string] {
  if (spanKey === 'missing-endpoint') return ['', ''];
  const idx = spanKey.indexOf(' -> ');
  if (idx < 0) return ['', ''];
  return [spanKey.slice(0, idx), spanKey.slice(idx + 4)];
}

function buildRangeStats(xs: number[], ys: number[], zs: number[]): TranslationRangeStats {
  return {
    xRange: xs.length > 0 ? [Math.min(...xs), Math.max(...xs)] : null,
    yRange: ys.length > 0 ? [Math.min(...ys), Math.max(...ys)] : null,
    zRange: zs.length > 0 ? [Math.min(...zs), Math.max(...zs)] : null,
  };
}

/** 数组取 [min, max]，空数组返回 null */
function rangeOf(vals: number[]): [number, number] | null {
  if (vals.length === 0) return null;
  return [Math.min(...vals), Math.max(...vals)];
}

/** parseInt 严格（仅正整数才返回） */
function tryParseInt(value: string): number | null {
  const n = parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** 从已排序的 kindAllSizes 中取 Top N 样本 */
function pickTopKindSamples(
  kindAllSizes: Array<{ spanKey: string; wireCount: number }>,
  groupSamplesByKey: Map<string, SpanGroupSample>,
  limit: number,
): SpanGroupSample[] {
  const sorted = [...kindAllSizes].sort((a, b) => b.wireCount - a.wireCount);
  const result: SpanGroupSample[] = [];
  for (const s of sorted.slice(0, limit)) {
    const sample = groupSamplesByKey.get(s.spanKey);
    if (sample) result.push(sample);
  }
  return result;
}

/** 构建 per-kind size stats */
function buildKindSizeStats(
  sizes: number[],
  allSizes: Array<{ spanKey: string; wireCount: number }>,
): GroupKindSizeStats {
  if (sizes.length === 0) {
    return { min: 0, max: 0, avg: 0, topSizes: [] };
  }
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const topSizes = [...allSizes]
    .sort((a, b) => b.wireCount - a.wireCount)
    .slice(0, MAX_PER_KIND_SAMPLES);
  return { min, max, avg, topSizes };
}

// ---------------------------------------------------------------------------
// 观察 / 阻塞 / 建议
// ---------------------------------------------------------------------------

function emptySpanGroupingReport(): LineSpanGroupingAuditReport {
  return {
    generatedAt: new Date().toISOString(),
    wireCount: 0,
    spanGroupCount: 0,
    spanGroupSizeStats: { min: 0, max: 0, avg: 0, topSizes: [] },
    groupKindCounts: { 'same-point': 0, 'inter-point': 0, 'missing-endpoint': 0 },
    groupKindWireCounts: { 'same-point': 0, 'inter-point': 0, 'missing-endpoint': 0 },
    groupKindSizeStats: {
      'same-point': { min: 0, max: 0, avg: 0, topSizes: [] },
      'inter-point': { min: 0, max: 0, avg: 0, topSizes: [] },
      'missing-endpoint': { min: 0, max: 0, avg: 0, topSizes: [] },
    },
    spanGroupSamples: [],
    samePointGroupSamples: [],
    interPointSpanSamples: [],
    missingEndpointGroupSamples: [],
    observations: ['线路工程图为空，无法做档距聚合'],
    blockingQuestions: [],
    recommendations: ['需先打开线路 GIM 才能采集档距聚合样本'],
  };
}

/** M4-B3C：per-kind zRange 格式化为可读字符串 */
function formatZRange(range: [number, number] | null): string {
  if (!range) return '—';
  return `[${range[0].toFixed(2)}, ${range[1].toFixed(2)}]`;
}

function buildObservations(
  wireCount: number,
  spanGroupCount: number,
  minSize: number,
  maxSize: number,
  avg: number,
  samples: SpanGroupSample[],
  kindCounts: Record<SpanGroupKind, number>,
  kindWireCounts: Record<SpanGroupKind, number>,
  groupKindSizeStats: Record<SpanGroupKind, GroupKindSizeStats>,
  kindKValue: Record<SpanGroupKind, { zero: number; nonZero: number }>,
  kindP0ZRange: Record<SpanGroupKind, [number, number] | null>,
  kindP1ZRange: Record<SpanGroupKind, [number, number] | null>,
): string[] {
  const obs: string[] = [];
  if (wireCount === 0 || spanGroupCount === 0) return obs;

  obs.push(`WIRE 总数 ${wireCount}，唯一档距 ${spanGroupCount}，平均每档 ${(avg).toFixed(2)} 条 WIRE`);

  // 每档 WIRE 数是否固定
  if (minSize === maxSize) {
    obs.push(`每档 WIRE 数固定为 ${minSize}（疑似结构化分裂导线 + 地线 + OPGW 共档）`);
  } else {
    obs.push(`每档 WIRE 数不固定（min=${minSize}, max=${maxSize}），可能因转角塔/分支塔/跳线档差异`);
  }

  // M4-B3C：拓扑分类占比
  const sameCount = kindCounts['same-point'];
  const interCount = kindCounts['inter-point'];
  const missingCount = kindCounts['missing-endpoint'];
  const samePct = spanGroupCount > 0 ? ((sameCount / spanGroupCount) * 100).toFixed(1) : '0';
  const interPct = spanGroupCount > 0 ? ((interCount / spanGroupCount) * 100).toFixed(1) : '0';
  const missingPct = spanGroupCount > 0 ? ((missingCount / spanGroupCount) * 100).toFixed(1) : '0';
  obs.push(`M4-B3C 拓扑分类：same-point ${sameCount}（${samePct}%）/ inter-point ${interCount}（${interPct}%）/ missing-endpoint ${missingCount}（${missingPct}%）`);

  // M4-B3C：WIRE 数按分类
  obs.push(`M4-B3C WIRE 分布：same-point ${kindWireCounts['same-point']} / inter-point ${kindWireCounts['inter-point']} / missing-endpoint ${kindWireCounts['missing-endpoint']}`);

  // M4-B3C：最大 same-point / inter-point group WIRE 数
  const maxSameSize = groupKindSizeStats['same-point'].max;
  const maxInterSize = groupKindSizeStats['inter-point'].max;
  obs.push(`M4-B3C 最大 same-point group WIRE 数：${maxSameSize}；最大 inter-point span WIRE 数：${maxInterSize}`);

  // 检查样本中的导线类型分布
  const allWireTypes = new Set<string>();
  const allSplits = new Set<string>();
  for (const s of samples) {
    for (const wt of Object.keys(s.wireTypeCounts)) allWireTypes.add(wt);
    for (const sp of Object.keys(s.splitCounts)) allSplits.add(sp);
  }
  obs.push(`样本中导线类型：${Array.from(allWireTypes).join(' / ') || '—'}`);
  obs.push(`样本中 SPLIT 取值：${Array.from(allSplits).join(' / ') || '—'}`);

  // M4-B3C：same-point vs inter-point KVALUE 分布
  const sameK = kindKValue['same-point'];
  const interK = kindKValue['inter-point'];
  const sameTotal = sameK.zero + sameK.nonZero;
  const interTotal = interK.zero + interK.nonZero;
  if (sameTotal > 0) {
    const sameZeroPct = ((sameK.zero / sameTotal) * 100).toFixed(1);
    obs.push(`M4-B3C KVALUE（same-point）：zero=${sameK.zero}（${sameZeroPct}%）/ nonZero=${sameK.nonZero}（${(100 - parseFloat(sameZeroPct)).toFixed(1)}%）`);
  }
  if (interTotal > 0) {
    const interZeroPct = ((interK.zero / interTotal) * 100).toFixed(1);
    obs.push(`M4-B3C KVALUE（inter-point）：zero=${interK.zero}（${interZeroPct}%）/ nonZero=${interK.nonZero}（${(100 - parseFloat(interZeroPct)).toFixed(1)}%）`);
  }
  // same-point 是否集中 KVALUE=0
  if (sameTotal > 0 && sameK.zero > sameTotal / 2) {
    obs.push('M4-B3C same-point 中 KVALUE=0 占多数，疑似同点内部连接未启用弧垂参数');
  }
  // inter-point 中 KVALUE 是否更像弧垂候选
  if (interTotal > 0 && interK.nonZero > interTotal / 2) {
    obs.push('M4-B3C inter-point 中 KVALUE 非 0 占多数，疑似弧垂/张力候选参数（待用户核验）');
  } else if (interTotal > 0 && interK.zero > interTotal / 2) {
    obs.push('M4-B3C inter-point 中 KVALUE=0 占多数，弧垂参数含义未确认');
  }

  // M4-B3C：MATRIX0 zRange 在 same-point / inter-point 中的差异
  const sameP0Z = formatZRange(kindP0ZRange['same-point']);
  const interP0Z = formatZRange(kindP0ZRange['inter-point']);
  const sameP1Z = formatZRange(kindP1ZRange['same-point']);
  const interP1Z = formatZRange(kindP1ZRange['inter-point']);
  obs.push(`M4-B3C MATRIX0 P0 zRange：same-point=${sameP0Z} / inter-point=${interP0Z}`);
  obs.push(`M4-B3C MATRIX0 P1 zRange：same-point=${sameP1Z} / inter-point=${interP1Z}`);

  // 检查 zRange 是否非零（疑似高度层级）
  let zRangeNonZero = false;
  for (const s of samples) {
    if (s.point0TranslationStats.zRange) {
      const [zMin, zMax] = s.point0TranslationStats.zRange;
      if (Math.abs(zMin) > 1e-6 || Math.abs(zMax) > 1e-6) zRangeNonZero = true;
    }
    if (s.point1TranslationStats.zRange) {
      const [zMin, zMax] = s.point1TranslationStats.zRange;
      if (Math.abs(zMin) > 1e-6 || Math.abs(zMax) > 1e-6) zRangeNonZero = true;
    }
  }
  if (zRangeNonZero) {
    obs.push('MATRIX0 z 平移分量非零，疑似挂点高度层级（横担高度差）');
  }

  // KVALUE=0 整体检测
  let kValueZeroDominant = false;
  for (const s of samples) {
    const total = s.kValueStats.zeroCount + s.kValueStats.nonZeroCount;
    if (total === 0) continue;
    if (s.kValueStats.zeroCount > total / 2) kValueZeroDominant = true;
  }
  if (kValueZeroDominant) {
    obs.push('部分档距 KVALUE=0 占多数，疑似未启用弧垂参数或代表"直线塔"档距');
  }

  return obs;
}

function buildBlockingQuestions(
  spanGroupCount: number,
  minSize: number,
  maxSize: number,
  kindCounts: Record<SpanGroupKind, number>,
): string[] {
  const qs: string[] = [];
  if (spanGroupCount === 0) {
    qs.push('未发现档距组，无法做聚合分析');
    return qs;
  }
  if (minSize !== maxSize) {
    qs.push('每档 WIRE 数不固定，是否因转角塔/分支塔/跳线档导致结构差异？');
  }
  // M4-B3C：same-point 占比过高
  const sameCount = kindCounts['same-point'];
  if (spanGroupCount > 0 && sameCount > spanGroupCount * 0.5) {
    qs.push('M4-B3C：same-point group 占比 > 50%，当前 spanKey 会把"同点内部连接"与"真实跨塔档距"混淆，悬链线实现前必须分离');
  }
  qs.push('M4-B3C：inter-point span 的 BLHA 是塔位中心还是挂点？same-point 是否为跳线/同塔内部连接？');
  qs.push('MATRIX0 平移分量的单位与坐标系未确认（局部坐标？世界坐标？米？毫米？）');
  qs.push('KVALUE=0 的档距是否代表"直线塔不参与弧垂"，还是"未启用"字段？');
  return qs;
}

function buildRecommendations(
  wireCount: number,
  spanGroupCount: number,
  minSize: number,
  maxSize: number,
  kindCounts: Record<SpanGroupKind, number>,
): string[] {
  const recs: string[] = [];
  if (wireCount === 0 || spanGroupCount === 0) {
    recs.push('无 WIRE 节点，无需进入 M4-B4');
    return recs;
  }

  // M4-B3C：决策收口
  recs.push('M4-B3C 收口结论：当前 MVP 不实现悬链线，地图继续保持直线段显示');
  recs.push('same-point group 不应直接进入悬链线渲染（同点内部连接，非跨塔档距）');
  recs.push('inter-point span 才是未来悬链线候选，但需用户对照样本工程核验 BLHA / MATRIX0 / KVALUE 语义');

  // same-point 占比
  const sameCount = kindCounts['same-point'];
  const sameRatio = spanGroupCount > 0 ? sameCount / spanGroupCount : 0;
  if (sameRatio > 0.5) {
    recs.push(`M4-B3C：same-point 占比 ${(sameRatio * 100).toFixed(1)}% > 50%，后续悬链线实现必须先过滤 same-point`);
  }

  // 每档固定 WIRE 数 → 可推断结构
  if (minSize === maxSize) {
    recs.push(`每档固定 ${minSize} 条 WIRE，后续可按"固定档距结构"建模（每档复用同一弧垂参数组）`);
  } else {
    recs.push(`每档 WIRE 数不固定（min=${minSize}, max=${maxSize}），后续需按"动态档距结构"建模`);
  }

  recs.push('后续若需要真实导线几何，应另起 M5 或专项任务（不做悬链线、不做 3D 线路、不解析 MOD）');
  recs.push('当前 Ctrl+Shift+C 审计导出保留，作为后续研究工具');

  return recs;
}
