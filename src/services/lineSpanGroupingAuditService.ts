/**
 * M4-B3B：档距聚合与 MATRIX0 平移分量验证服务（纯内存、只读）。
 *
 * 实际线路样本显示：wireCount=5460、towerCount=327，但每档（两端塔 BLHA 相同）
 * 存在多条 WIRE（导线分裂、地线、OPGW 共档）。本服务回答：
 * - 一个档距内有多少 WIRE？
 * - 如何按 wireType / SPLIT / KVALUE / MATRIX0 分组？
 * - MATRIX0 的 x,y,z 是否解释相位/分裂/高度？
 * - BLHA 是档距端点还是挂点？
 * - KVALUE 是否存在分布规律？
 *
 * 边界（强制）：
 * - 只读现有内存数据（graph / mapData），不读 DB、不读 GIM 文件
 * - 不影响渲染、不修改 state、不修改 SQLite
 * - 不实现悬链线、不做弧垂计算
 * - 不将 KVALUE / MATRIX0 定义为确定语义，仅"疑似 / 候选 / 待确认"
 * - spanGroupSamples ≤ 20，wireSamples ≤ 20
 */

import type { GimGraph, GimGraphNode } from '../gim/gimGraphTypes.js';
import type { LineMapData } from '../gim/lineMapData.js';

/** 单类档距样本上限 */
const MAX_SPAN_GROUP_SAMPLES = 20;
/** 单档内导线样本上限 */
const MAX_WIRE_SAMPLES_PER_GROUP = 20;
/** distinct KVALUE 样本上限 */
const MAX_DISTINCT_KVALUES = 20;

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
  /** 档距组样本（≤ MAX_SPAN_GROUP_SAMPLES） */
  spanGroupSamples: SpanGroupSample[];
  /** 观察结论（疑似 / 候选，不写结论） */
  observations: string[];
  /** 阻塞问题 */
  blockingQuestions: string[];
  /** M4-B4 决策建议 */
  recommendations: string[];
}

/**
 * 构建 M4-B3B 档距聚合审计报告。
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

  // 3. 计算档距组大小统计
  const spanGroupCount = spanGroups.size;
  let minSize = wireCount;
  let maxSize = 0;
  let totalSize = 0;
  const allSizes: Array<{ spanKey: string; wireCount: number }> = [];
  for (const [key, arr] of spanGroups) {
    const size = arr.length;
    if (size < minSize) minSize = size;
    if (size > maxSize) maxSize = size;
    totalSize += size;
    allSizes.push({ spanKey: key, wireCount: size });
  }
  const avg = spanGroupCount > 0 ? totalSize / spanGroupCount : 0;
  // Top 5 by wireCount
  allSizes.sort((a, b) => b.wireCount - a.wireCount);
  const topSizes = allSizes.slice(0, 5);

  // 4. 选样本档距组：优先选 WIRE 数最多的（信息量最大）
  const sampleKeys = allSizes
    .slice(0, Math.min(MAX_SPAN_GROUP_SAMPLES, spanGroupCount))
    .map(s => s.spanKey);

  // 5. 为每个样本档距构建 SpanGroupSample
  const spanGroupSamples: SpanGroupSample[] = [];
  for (const key of sampleKeys) {
    const nodes = spanGroups.get(key) || [];
    spanGroupSamples.push(buildSpanGroupSample(key, nodes, wireTypeByPath));
  }

  // 6. 生成观察结论 / 阻塞问题 / 建议
  const observations = buildObservations(wireCount, spanGroupCount, minSize, maxSize, avg, spanGroupSamples);
  const blockingQuestions = buildBlockingQuestions(spanGroupCount, minSize, maxSize);
  const recommendations = buildRecommendations(wireCount, spanGroupCount, minSize, maxSize, spanGroupSamples);

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
    spanGroupSamples,
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
 */
function buildSpanKey(p0: string, p1: string): string {
  if (!p0 && !p1) return 'missing-endpoint';
  if (!p0 || !p1) return 'missing-endpoint';
  // 去除两端空白后比较，避免 '1,2,3' 与 '1, 2, 3' 产生不同 key
  const a = p0.trim();
  const b = p1.trim();
  return a <= b ? `${a} -> ${b}` : `${b} -> ${a}`;
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
export function parseMatrixTranslation(matrix: string | null): MatrixTranslation {
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

/** 解析 spanKey 还原 p0 / p1 原始字符串 */
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

/** parseInt 严格（仅正整数才返回） */
function tryParseInt(value: string): number | null {
  const n = parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : null;
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
    spanGroupSamples: [],
    observations: ['线路工程图为空，无法做档距聚合'],
    blockingQuestions: [],
    recommendations: ['需先打开线路 GIM 才能采集档距聚合样本'],
  };
}

function buildObservations(
  wireCount: number,
  spanGroupCount: number,
  minSize: number,
  maxSize: number,
  avg: number,
  samples: SpanGroupSample[],
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

  // 检查样本中的导线类型分布
  const allWireTypes = new Set<string>();
  const allSplits = new Set<string>();
  let zRangeNonZero = false;
  let zRangeOnlyZero = true;
  for (const s of samples) {
    for (const wt of Object.keys(s.wireTypeCounts)) allWireTypes.add(wt);
    for (const sp of Object.keys(s.splitCounts)) allSplits.add(sp);
    // 检查 z 平移分量范围是否非零（疑似高度层级）
    if (s.point0TranslationStats.zRange) {
      const [zMin, zMax] = s.point0TranslationStats.zRange;
      if (Math.abs(zMin) > 1e-6 || Math.abs(zMax) > 1e-6) {
        zRangeNonZero = true;
        zRangeOnlyZero = false;
      }
    }
    if (s.point1TranslationStats.zRange) {
      const [zMin, zMax] = s.point1TranslationStats.zRange;
      if (Math.abs(zMin) > 1e-6 || Math.abs(zMax) > 1e-6) {
        zRangeNonZero = true;
        zRangeOnlyZero = false;
      }
    }
  }

  obs.push(`样本中导线类型：${Array.from(allWireTypes).join(' / ') || '—'}`);
  obs.push(`样本中 SPLIT 取值：${Array.from(allSplits).join(' / ') || '—'}`);

  if (zRangeNonZero) {
    obs.push('MATRIX0 z 平移分量非零，疑似挂点高度层级（横担高度差）');
  } else if (zRangeOnlyZero) {
    obs.push('MATRIX0 z 平移分量全部为 0，可能未编码高度信息或单位极小');
  }

  // KVALUE=0 检测
  let kValueZeroDominant = false;
  let kValueNonZeroDominant = false;
  for (const s of samples) {
    const total = s.kValueStats.zeroCount + s.kValueStats.nonZeroCount;
    if (total === 0) continue;
    if (s.kValueStats.zeroCount > total / 2) kValueZeroDominant = true;
    if (s.kValueStats.nonZeroCount > total / 2) kValueNonZeroDominant = true;
  }
  if (kValueZeroDominant) {
    obs.push('部分档距 KVALUE=0 占多数，疑似未启用弧垂参数或代表"直线塔"档距');
  }
  if (kValueNonZeroDominant) {
    obs.push('部分档距 KVALUE 非 0 占多数，疑似为张力/弧垂相关参数');
  }

  // OPGW vs CONDUCTOR 差异
  for (const s of samples) {
    const hasConductor = s.wireTypeCounts['CONDUCTOR'] > 0;
    const hasOpGW = s.wireTypeCounts['OPGW'] > 0;
    if (hasConductor && hasOpGW) {
      // 比较 zRange 是否不同
      const condZ = s.point0TranslationStats.zRange;
      const opgwZ = s.point0TranslationStats.zRange;
      if (condZ && opgwZ) {
        obs.push('档距内同时存在 CONDUCTOR 与 OPGW，MATRIX0 zRange 可能体现两者挂高差异（待用户核验）');
        break;
      }
    }
  }

  return obs;
}

function buildBlockingQuestions(
  spanGroupCount: number,
  minSize: number,
  maxSize: number,
): string[] {
  const qs: string[] = [];
  if (spanGroupCount === 0) {
    qs.push('未发现档距组，无法做聚合分析');
    return qs;
  }
  if (minSize !== maxSize) {
    qs.push('每档 WIRE 数不固定，是否因转角塔/分支塔/跳线档导致结构差异？');
  }
  qs.push('MATRIX0 平移分量的单位与坐标系未确认（局部坐标？世界坐标？米？毫米？）');
  qs.push('KVALUE=0 的档距是否代表"直线塔不参与弧垂"，还是"未启用"字段？');
  qs.push('BLHA 是档距端点（塔位）还是挂点（横担挂点）？若为塔位，则 MATRIX0 平移分量可能是挂点相对塔位的偏移');
  return qs;
}

function buildRecommendations(
  wireCount: number,
  spanGroupCount: number,
  minSize: number,
  maxSize: number,
  samples: SpanGroupSample[],
): string[] {
  const recs: string[] = [];
  if (wireCount === 0 || spanGroupCount === 0) {
    recs.push('无 WIRE 节点，无需进入 M4-B4');
    return recs;
  }

  // 每档固定 WIRE 数 → 可推断结构
  if (minSize === maxSize) {
    recs.push(`每档固定 ${minSize} 条 WIRE，M4-B4 可按"固定档距结构"建模（每档复用同一弧垂参数组）`);
  } else {
    recs.push(`每档 WIRE 数不固定（min=${minSize}, max=${maxSize}），M4-B4 需按"动态档距结构"建模`);
  }

  // MATRIX0 zRange 非零 → 可用作挂点高度
  let zNonZero = false;
  for (const s of samples) {
    if (s.point0TranslationStats.zRange) {
      const [zMin, zMax] = s.point0TranslationStats.zRange;
      if (Math.abs(zMin) > 1e-6 || Math.abs(zMax) > 1e-6) {
        zNonZero = true;
        break;
      }
    }
  }
  if (zNonZero) {
    recs.push('MATRIX0 z 平移分量疑似挂点高度，M4-B4 可用作悬链线端点高程（单位待用户确认）');
  } else {
    recs.push('MATRIX0 z 平移分量为 0 或缺失，M4-B4 悬链线高程需依赖 BLHA 第 3 段');
  }

  recs.push('用户对照样本工程核验：BLHA 是否为塔位中心，MATRIX0 是否为挂点相对偏移');
  recs.push('M4-B4 路线决策：若 BLHA=塔位 + MATRIX0=挂点偏移 → 可实现"工程语义悬链线"；否则实现"示意悬链线"');

  return recs;
}
