/**
 * M4-B1：线路几何与导线语义审计服务（只读、纯内存）。
 *
 * 用于审计当前线路工程的几何数据覆盖度，识别可用于悬链线 / 导线增强的
 * 原始字段，输出结构化报告供 Ctrl+Shift+D 诊断或后续 UI 调用。
 *
 * 边界（强制）：
 * - 只读现有内存数据（graph / mapData / attrIndex），不读 DB、不读 GIM 文件
 * - 不影响渲染、不修改 state、不修改 SQLite
 * - 样本数量限制（每类最多 MAX_SAMPLES 条），避免报告体积爆炸
 * - 入参使用 unknown 类型，由本服务内部进行类型收窄，调用方无需强转
 *
 * 调用点建议：
 * - 暂不强制 UI 接入；可在 lineProjectView 渲染完成后通过 debugLog 输出
 * - 或在 Ctrl+Shift+D 诊断 JSON 中按需附加（当前未集成，避免诊断体积过大）
 */
import type { GimGraph, GimGraphNode } from '../gim/gimGraphTypes.js';
import type { LineMapData } from '../gim/lineMapData.js';
import type { LineAttributeIndex } from '../gim/lineAttributeTypes.js';

/** 单类样本上限（避免报告体积爆炸） */
const MAX_SAMPLES = 10;

/** 线路几何审计报告 */
export interface LineGeometryAuditReport {
  /** 节点类型计数（ENTITYNAME → 出现次数） */
  nodeTypeCounts: Record<string, number>;
  /** 导线类型计数（wireType → 段数，来源于 mapData.wires） */
  wireTypeCounts: Record<string, number>;
  /** CONDUCTOR / GROUNDWIRE / OPGW 导线节点样本（最多 MAX_SAMPLES 条） */
  conductorLikeSamples: WireSample[];
  /** 塔位 F4(TOWER) 节点样本（最多 MAX_SAMPLES 条） */
  towerLikeSamples: TowerSample[];
  /** 跨越点 F4(CROSS) 节点样本（最多 MAX_SAMPLES 条） */
  crossLikeSamples: CrossSample[];
  /** 在 WIRE 节点 rawProps 中发现的悬链线候选字段名（去重 + 出现次数） */
  possibleSagFields: SagFieldStat[];
  /** 期望出现但未在 WIRE 节点中出现的字段（按检查清单） */
  missingFields: string[];
  /** 给 M4-B2 的可执行建议 */
  recommendations: string[];
}

/** 导线样本（精简字段，用于诊断输出） */
export interface WireSample {
  path: string;
  wireType: string;
  /** 是否有 POINT0.BLHA / POINT1.BLHA */
  hasPoint0Blha: boolean;
  hasPoint1Blha: boolean;
  /** 是否有 BACKSTRING / FRONTSTRING（端点兜底引用） */
  hasBackString: boolean;
  hasFrontString: boolean;
  /** 悬链线候选字段样本值（仅取存在的） */
  sagFieldValues: Record<string, string>;
  /** 父 F4(WIRE) 路径（若能反查到） */
  parentWireF4Path: string | null;
}

/** 塔位样本 */
export interface TowerSample {
  path: string;
  classifyName: string;
  hasBlha: boolean;
  blhaValue: string | null;
  /** FAM 命中的关键属性样本（towerNumber/towerType/towerHeight/turnAngle） */
  famAttrs: Record<string, string>;
  /** DEV 命中的 DEVICETYPE */
  devDeviceType: string | null;
}

/** 跨越点样本 */
export interface CrossSample {
  path: string;
  classifyName: string;
  hasBlha: boolean;
  blhaValue: string | null;
}

/** 悬链线候选字段统计 */
export interface SagFieldStat {
  /** 字段名（如 KVALUE / SPLIT / POINT0.MATRIX0） */
  field: string;
  /** 在 WIRE 节点样本中出现的次数 */
  count: number;
  /** 一个样本值（便于人工确认含义） */
  sampleValue: string | null;
}

/** WIRE 节点中可能的悬链线 / 几何增强候选字段清单 */
const WIRE_SAG_CANDIDATE_FIELDS = [
  'KVALUE',            // 张力系数 / 弧垂参数候选
  'SPLIT',             // 分裂因子
  'POINT0.BLHA',       // 起点 BLHA（已有）
  'POINT1.BLHA',       // 终点 BLHA（已有）
  'POINT0.MATRIX0',    // 起点变换矩阵（悬链线参数候选）
  'POINT1.MATRIX0',    // 终点变换矩阵
  'WIRETYPE',          // 导线类型
  'BACKSTRING',        // 起塔引用（端点兜底）
  'FRONTSTRING',       // 终塔引用
  'ISJUMPER',          // 跳线标志
  'MATERIALSHEET',     // 材料表
  'TRANSFORMMATRIX',   // 节点变换矩阵
];

/** WIRE 节点期望字段（缺失时进 missingFields） */
const WIRE_EXPECTED_FIELDS = [
  'KVALUE',
  'SPLIT',
  'POINT0.BLHA',
  'POINT1.BLHA',
  'WIRETYPE',
];

/** 塔位 FAM 属性候选键（与 lineMapData.TOWER_*_KEYS 对齐） */
const TOWER_FAM_ATTR_KEYS: Record<string, string[]> = {
  towerNumber: ['N0', 'TOWERNO', 'TOWERNUMBER', 'TOWERNUM', 'NUM', 'BH'],
  towerType: ['TOWERTYPE', 'TOWERMODEL', 'MODEL', 'TOWERKIND', 'TYPE'],
  towerHeight: ['TOWERHEIGHT', 'HEIGHT', 'HEIGHTVALUE', 'CALLHEIGHT', 'HOUGAO'],
  turnAngle: ['TURNANGLE', 'ANGLE', 'AZIMUTH'],
};

/** DEV 设备类型候选键 */
const DEV_TYPE_KEYS = ['DEVICETYPE', 'TYPE', 'CLASSIFY', 'TOWERTYPE'];

/**
 * 构建线路几何审计报告。
 *
 * @param args.graph 已构建的线路工程图（GimGraph）
 * @param args.mapData extractLineMapData 输出的扁平地图数据
 * @param args.attrIndex FAM/DEV 属性查找索引（可选，缓存命中时由 buildLineAttributeIndex 提供）
 */
export function buildLineGeometryAuditReport(args: {
  graph: unknown;
  mapData: unknown;
  attrIndex?: unknown;
}): LineGeometryAuditReport {
  const graph = args.graph as GimGraph | null;
  const mapData = args.mapData as LineMapData | null;
  const attrIndex = (args.attrIndex as LineAttributeIndex | null | undefined) ?? undefined;

  // 兜底：graph 缺失时返回空报告
  if (!graph || !graph.nodesByPath) {
    return emptyReport();
  }

  // 1. 节点类型计数
  const nodeTypeCounts: Record<string, number> = {};
  for (const node of graph.nodesByPath.values()) {
    const key = node.entityName || '(unknown)';
    nodeTypeCounts[key] = (nodeTypeCounts[key] || 0) + 1;
  }

  // 2. 导线类型计数（来自 mapData.wires）
  const wireTypeCounts: Record<string, number> = {};
  if (mapData && Array.isArray(mapData.wires)) {
    for (const w of mapData.wires) {
      const key = w.wireType || 'UNKNOWN';
      wireTypeCounts[key] = (wireTypeCounts[key] || 0) + 1;
    }
  }

  // 3. 构建拓扑反查（WIRE → 父 F4(WIRE)）—— 复用 lineMapData 的思路但简化
  const parentByPath = buildParentIndex(graph);

  // 4. 收集 WIRE 样本（按 wireType 分桶，每类取前 N 条）
  const conductorSamples: WireSample[] = [];
  const groundwireSamples: WireSample[] = [];
  const opgwSamples: WireSample[] = [];
  const otherWireSamples: WireSample[] = [];

  /** 按 wireType 路由到对应样本桶（闭包持有上方 4 个局部数组） */
  const pickBucket = (wireType: string): WireSample[] => {
    if (wireType === 'CONDUCTOR') return conductorSamples;
    if (wireType === 'GROUNDWIRE') return groundwireSamples;
    if (wireType === 'OPGW') return opgwSamples;
    return otherWireSamples;
  };

  const sagFieldStatMap = new Map<string, SagFieldStat>();

  for (const node of graph.nodesByPath.values()) {
    if (node.entityName !== 'WIRE') continue;
    const wireType = resolveWireType(node, parentByPath);
    const sample = buildWireSample(node, wireType, parentByPath);

    // 累加候选字段统计
    for (const field of WIRE_SAG_CANDIDATE_FIELDS) {
      const val = node.rawProps[field];
      if (val !== undefined && val !== null && val !== '') {
        let stat = sagFieldStatMap.get(field);
        if (!stat) {
          stat = { field, count: 0, sampleValue: null };
          sagFieldStatMap.set(field, stat);
        }
        stat.count++;
        if (stat.sampleValue === null && val.length < 200) {
          stat.sampleValue = val;
        }
      }
    }

    // 分桶
    const bucket = pickBucket(wireType);
    if (bucket.length < MAX_SAMPLES) bucket.push(sample);
  }

  // 5. 收集塔位 F4(TOWER) 样本
  const towerSamples: TowerSample[] = [];
  if (graph.root) {
    for (const node of graph.nodesByPath.values()) {
      if (towerSamples.length >= MAX_SAMPLES) break;
      if (node.entityName !== 'F4System') continue;
      if (node.rawProps['GROUPTYPE'] !== 'TOWER') continue;
      towerSamples.push(buildTowerSample(node, attrIndex));
    }
  }

  // 6. 收集 CROSS 样本
  const crossSamples: CrossSample[] = [];
  for (const node of graph.nodesByPath.values()) {
    if (crossSamples.length >= MAX_SAMPLES) break;
    if (node.entityName !== 'F4System') continue;
    if (node.rawProps['GROUPTYPE'] !== 'CROSS') continue;
    crossSamples.push({
      path: node.path,
      classifyName: node.classifyName || '',
      hasBlha: !!node.rawProps['BLHA'],
      blhaValue: node.rawProps['BLHA'] || null,
    });
  }

  // 7. 检查 WIRE 期望字段缺失
  const missingFields: string[] = [];
  if (sagFieldStatMap.size === 0) {
    // 没有 WIRE 节点，无法判断
  } else {
    for (const expected of WIRE_EXPECTED_FIELDS) {
      const stat = sagFieldStatMap.get(expected);
      if (!stat || stat.count === 0) {
        missingFields.push(expected);
      }
    }
  }

  // 8. 生成建议
  const recommendations = buildRecommendations({
    nodeTypeCounts,
    wireTypeCounts,
    sagFieldStats: Array.from(sagFieldStatMap.values()),
    missingFields,
  });

  // 合并导线样本（CONDUCTOR 优先，其他作为补充）
  const conductorLikeSamples = [
    ...conductorSamples,
    ...groundwireSamples,
    ...opgwSamples,
    ...otherWireSamples,
  ].slice(0, MAX_SAMPLES);

  return {
    nodeTypeCounts,
    wireTypeCounts,
    conductorLikeSamples,
    towerLikeSamples: towerSamples,
    crossLikeSamples: crossSamples,
    possibleSagFields: Array.from(sagFieldStatMap.values()).sort((a, b) => b.count - a.count),
    missingFields,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

function emptyReport(): LineGeometryAuditReport {
  return {
    nodeTypeCounts: {},
    wireTypeCounts: {},
    conductorLikeSamples: [],
    towerLikeSamples: [],
    crossLikeSamples: [],
    possibleSagFields: [],
    missingFields: [],
    recommendations: ['线路工程图为空，无法审计'],
  };
}

/** 构建 path → parent 索引（一次 DFS） */
function buildParentIndex(graph: GimGraph): Map<string, GimGraphNode> {
  const parentByPath = new Map<string, GimGraphNode>();
  function walk(node: GimGraphNode): void {
    for (const child of node.children) {
      parentByPath.set(child.path, node);
      walk(child);
    }
  }
  if (graph.root) walk(graph.root);
  return parentByPath;
}

/** 解析导线类型：优先自身 WIRETYPE，回退父 F4(WIRE) 的 WIRETYPE */
function resolveWireType(node: GimGraphNode, parentByPath: Map<string, GimGraphNode>): string {
  const own = node.rawProps['WIRETYPE'];
  if (own) return own.toUpperCase();
  let cur = parentByPath.get(node.path) || null;
  while (cur) {
    if (cur.entityName === 'F4System' && cur.rawProps['GROUPTYPE'] === 'WIRE') {
      const wt = cur.rawProps['WIRETYPE'];
      if (wt) return wt.toUpperCase();
      break;
    }
    cur = parentByPath.get(cur.path) || null;
  }
  return 'UNKNOWN';
}

/** 按 wireType 选择样本桶（已内联到 buildLineGeometryAuditReport 内的 pickBucket 闭包） */

function buildWireSample(
  node: GimGraphNode,
  wireType: string,
  parentByPath: Map<string, GimGraphNode>,
): WireSample {
  const sagFieldValues: Record<string, string> = {};
  for (const field of WIRE_SAG_CANDIDATE_FIELDS) {
    const val = node.rawProps[field];
    if (val !== undefined && val !== null && val !== '' && val.length < 200) {
      sagFieldValues[field] = val;
    }
  }
  // 反查父 F4(WIRE)
  let parentWireF4Path: string | null = null;
  let cur = parentByPath.get(node.path) || null;
  while (cur) {
    if (cur.entityName === 'F4System' && cur.rawProps['GROUPTYPE'] === 'WIRE') {
      parentWireF4Path = cur.path;
      break;
    }
    cur = parentByPath.get(cur.path) || null;
  }
  return {
    path: node.path,
    wireType,
    hasPoint0Blha: !!node.rawProps['POINT0.BLHA'],
    hasPoint1Blha: !!node.rawProps['POINT1.BLHA'],
    hasBackString: !!node.rawProps['BACKSTRING'],
    hasFrontString: !!node.rawProps['FRONTSTRING'],
    sagFieldValues,
    parentWireF4Path,
  };
}

function buildTowerSample(node: GimGraphNode, attrIndex?: LineAttributeIndex): TowerSample {
  const famAttrs: Record<string, string> = {};
  // 在 attrIndex 中按 famFiles 反查属性
  if (attrIndex) {
    const famRefs = collectFamRefs(node);
    const famMap = lookupPropMap(famRefs, attrIndex.famBySourcePath, attrIndex.famByFileNameLower);
    if (famMap) {
      for (const [attrKey, candidates] of Object.entries(TOWER_FAM_ATTR_KEYS)) {
        const val = findAttrValue(famMap, candidates);
        if (val) famAttrs[attrKey] = val;
      }
    }
    const devRefs = collectDevRefs(node);
    const devMap = lookupPropMap(devRefs, attrIndex.devBySourcePath, attrIndex.devByFileNameLower);
    if (devMap) {
      const devType = findAttrValue(devMap, DEV_TYPE_KEYS);
      if (devType) famAttrs.__devDeviceType = devType;
    }
  }
  const blha = node.rawProps['BLHA'] || null;
  return {
    path: node.path,
    classifyName: node.classifyName || '',
    hasBlha: !!blha,
    blhaValue: blha,
    famAttrs,
    devDeviceType: famAttrs.__devDeviceType || null,
  };
}

function collectFamRefs(node: GimGraphNode): string[] {
  const set = new Set<string>();
  for (const f of node.refs.famFiles) if (f) set.add(f);
  for (const child of node.children) {
    if (child.entityName === 'Tower_Device') {
      for (const f of child.refs.famFiles) if (f) set.add(f);
    }
  }
  return Array.from(set);
}

function collectDevRefs(node: GimGraphNode): string[] {
  const set = new Set<string>();
  for (const d of node.refs.devFiles) if (d) set.add(d);
  for (const child of node.children) {
    if (child.entityName === 'Tower_Device') {
      for (const d of child.refs.devFiles) if (d) set.add(d);
    }
  }
  return Array.from(set);
}

function lookupPropMap<T extends { prop_value?: string | null }>(
  refs: string[],
  bySourcePath: Map<string, Map<string, T[]>>,
  byFileNameLower: Map<string, Map<string, T[]>>,
): Map<string, T[]> | undefined {
  for (const ref of refs) {
    if (!ref) continue;
    // 简化：直接用 ref 作为 key（实际 lineMapData 中有归一化，此处宽松匹配）
    const m1 = bySourcePath.get(ref);
    if (m1) return m1;
    const lower = ref.toLowerCase();
    const m2 = byFileNameLower.get(lower);
    if (m2) return m2;
  }
  return undefined;
}

function findAttrValue<T extends { prop_value?: string | null }>(
  propMap: Map<string, T[]>,
  candidates: string[],
): string | undefined {
  for (const cand of candidates) {
    const list = propMap.get(cand);
    if (list && list.length > 0 && list[0].prop_value) return list[0].prop_value!;
  }
  // 大小写不敏感
  for (const cand of candidates) {
    const lower = cand.toLowerCase();
    for (const [key, list] of propMap) {
      if (key.toLowerCase() === lower && list.length > 0 && list[0].prop_value) {
        return list[0].prop_value!;
      }
    }
  }
  return undefined;
}

function buildRecommendations(args: {
  nodeTypeCounts: Record<string, number>;
  wireTypeCounts: Record<string, number>;
  sagFieldStats: SagFieldStat[];
  missingFields: string[];
}): string[] {
  const recs: string[] = [];
  const wireCount = args.nodeTypeCounts['WIRE'] || 0;

  if (wireCount === 0) {
    recs.push('未发现 WIRE 节点，无法做导线几何增强');
    return recs;
  }

  // 候选字段覆盖度
  const kvalueStat = args.sagFieldStats.find((s) => s.field === 'KVALUE');
  const splitStat = args.sagFieldStats.find((s) => s.field === 'SPLIT');
  const matrix0Stat = args.sagFieldStats.find((s) => s.field === 'POINT0.MATRIX0');

  if (kvalueStat && kvalueStat.count > 0) {
    recs.push(`KVALUE 出现 ${kvalueStat.count}/${wireCount} 次，可作为悬链线张力参数候选（M4-B2 验证语义）`);
  } else {
    recs.push('KVALUE 缺失，悬链线计算缺少张力参数，需先确认字段来源');
  }

  if (splitStat && splitStat.count > 0) {
    recs.push(`SPLIT 出现 ${splitStat.count}/${wireCount} 次，可用于分裂导线渲染（M4-B2）`);
  }

  if (matrix0Stat && matrix0Stat.count > 0) {
    recs.push(`POINT0.MATRIX0 出现 ${matrix0Stat.count}/${wireCount} 次，需人工确认是否为悬链线参数`);
  }

  if (args.missingFields.length > 0) {
    recs.push(`WIRE 节点缺失期望字段：${args.missingFields.join(', ')}（影响几何提取）`);
  }

  // 导线类型分布
  const knownTypes = ['CONDUCTOR', 'GROUNDWIRE', 'OPGW'];
  const unknownCount = args.wireTypeCounts['UNKNOWN'] || 0;
  if (unknownCount > 0) {
    recs.push(`存在 ${unknownCount} 条 UNKNOWN 导线，建议补 WIRETYPE 兜底逻辑（M4-B2）`);
  }
  const knownTotal = knownTypes.reduce((s, t) => s + (args.wireTypeCounts[t] || 0), 0);
  if (knownTotal > 0) {
    recs.push(`已识别 ${knownTotal} 条导线（CONDUCTOR/GROUNDWIRE/OPGW），可按类型做样式分层（M4-B2）`);
  }

  // 顺序建议
  recs.push('M4-B2 建议顺序：(1) 导线属性面板增强 (2) 导线样式分层 (3) 悬链线预研');

  return recs;
}

// ===========================================================================
// M4-B3：悬链线参数语义验证（新增报告）
// ===========================================================================

/** 悬链线参数审计样本上限（高于通用 MAX_SAMPLES，便于格式判断） */
const MAX_CATENARY_SAMPLES = 20;

/** 悬链线候选字段全覆盖清单（用于覆盖率统计） */
const CATENARY_CANDIDATE_FIELDS = [
  'KVALUE',
  'SPLIT',
  'POINT0.BLHA',
  'POINT1.BLHA',
  'POINT0.MATRIX0',
  'POINT1.MATRIX0',
  'ISJUMPER',
  'MATERIALSHEET',
  'TRANSFORMMATRIX',
  'BACKSTRING',
  'FRONTSTRING',
];

/** 悬链线参数审计报告 */
export interface LineCatenaryParamAuditReport {
  /** WIRE 节点总数（覆盖率分母） */
  wireCount: number;
  /** 各候选字段的覆盖率统计 */
  coverage: Record<string, {
    /** 出现次数 */
    count: number;
    /** 占 wireCount 比例（0~1） */
    ratio: number;
    /** 样本值（最多 MAX_CATENARY_SAMPLES 条） */
    sampleValues: string[];
  }>;
  /** MATRIX0 格式样本（POINT0.MATRIX0 / POINT1.MATRIX0 各取部分样本） */
  matrix0FormatSamples: Matrix0FormatSample[];
  /** KVALUE 数字分布样本 */
  kValueSamples: KValueSample[];
  /** SPLIT 整数分布样本 */
  splitSamples: SplitSample[];
  /** BLHA 高程样本（起终点高程及高差） */
  blhaElevationSamples: BlhaElevationSample[];
  /** 语义假设（疑似 / 候选 / 待确认，禁止写成结论） */
  semanticHypotheses: string[];
  /** 阻塞问题（需人工或样本核验才能推进 M4-B4） */
  blockingQuestions: string[];
  /** M4-B4 决策建议 */
  recommendations: string[];
}

/** MATRIX0 格式样本 */
export interface Matrix0FormatSample {
  path: string;
  point0Matrix0: string | null;
  point1Matrix0: string | null;
  /** 逗号分隔后的元素数量（用于推断矩阵维度） */
  parsedLength: number | null;
  /** 推断的格式（'4x4-matrix' / '3x4-matrix' / 'triplet' / 'scalar' / 'unknown'） */
  likelyFormat: string;
}

/** KVALUE 样本 */
export interface KValueSample {
  path: string;
  wireType: string;
  kValue: string | null;
  /** 尝试 parseFloat 的结果，失败为 null */
  numericValue: number | null;
}

/** SPLIT 样本 */
export interface SplitSample {
  path: string;
  split: string | null;
  /** 尝试 parseInt 的结果，失败为 null */
  numericValue: number | null;
  /** 是否为整数 */
  isInteger: boolean;
}

/** BLHA 高程样本 */
export interface BlhaElevationSample {
  path: string;
  /** POINT0.BLHA 解析出的高程（第 3 段） */
  point0Elevation: number | null;
  /** POINT1.BLHA 解析出的高程 */
  point1Elevation: number | null;
  /** 高差（米）：point1 - point0，两端缺失为 null */
  elevationDelta: number | null;
}

/**
 * 构建 M4-B3 悬链线参数语义验证报告。
 *
 * 只读内存数据，不读 DB、不改 schema、不影响渲染。
 * 字段含义全部以"疑似 / 候选 / 待确认"措辞，不写成结论。
 *
 * @param args.graph 已构建的线路工程图
 * @param args.mapData extractLineMapData 输出（用于 wireType 反查）
 */
export function buildLineCatenaryParamAuditReport(args: {
  graph: unknown;
  mapData: unknown;
}): LineCatenaryParamAuditReport {
  const graph = args.graph as GimGraph | null;
  const mapData = args.mapData as LineMapData | null;

  // 兜底：graph 缺失时返回空报告
  if (!graph || !graph.nodesByPath) {
    return emptyCatenaryReport();
  }

  // 1. 收集 WIRE 节点（用于统计与采样）
  const wireNodes: GimGraphNode[] = [];
  for (const node of graph.nodesByPath.values()) {
    if (node.entityName === 'WIRE') wireNodes.push(node);
  }
  const wireCount = wireNodes.length;

  // 2. 覆盖率统计
  const coverage: LineCatenaryParamAuditReport['coverage'] = {};
  for (const field of CATENARY_CANDIDATE_FIELDS) {
    coverage[field] = { count: 0, ratio: 0, sampleValues: [] };
  }

  // 3. 采样桶
  const matrix0Samples: Matrix0FormatSample[] = [];
  const kValueSamples: KValueSample[] = [];
  const splitSamples: SplitSample[] = [];
  const blhaSamples: BlhaElevationSample[] = [];

  // 4. 构建 path → wireType 反查（来自 mapData.wires.nodeRef）
  const wireTypeByPath = new Map<string, string>();
  if (mapData && Array.isArray(mapData.wires)) {
    for (const w of mapData.wires) {
      if (w.nodeRef?.path) wireTypeByPath.set(w.nodeRef.path, w.wireType || 'UNKNOWN');
    }
  }

  // 5. 遍历采样
  for (const node of wireNodes) {
    const raw = node.rawProps;

    // 覆盖率 + 样本值
    for (const field of CATENARY_CANDIDATE_FIELDS) {
      const val = raw[field];
      if (val !== undefined && val !== null && val !== '') {
        const c = coverage[field];
        c.count++;
        if (c.sampleValues.length < MAX_CATENARY_SAMPLES && val.length < 200) {
          c.sampleValues.push(val);
        }
      }
    }

    // MATRIX0 格式样本（POINT0.MATRIX0 优先）
    const p0m0 = raw['POINT0.MATRIX0'] || null;
    const p1m0 = raw['POINT1.MATRIX0'] || null;
    if ((p0m0 || p1m0) && matrix0Samples.length < MAX_CATENARY_SAMPLES) {
      matrix0Samples.push({
        path: node.path,
        point0Matrix0: p0m0,
        point1Matrix0: p1m0,
        parsedLength: guessMatrix0Length(p0m0 || p1m0),
        likelyFormat: guessMatrix0Format(p0m0 || p1m0),
      });
    }

    // KVALUE 样本
    const kValue = raw['KVALUE'] || null;
    if (kValue && kValueSamples.length < MAX_CATENARY_SAMPLES) {
      kValueSamples.push({
        path: node.path,
        wireType: wireTypeByPath.get(node.path) || 'UNKNOWN',
        kValue,
        numericValue: tryParseFloat(kValue),
      });
    }

    // SPLIT 样本
    const split = raw['SPLIT'] || null;
    if (split && splitSamples.length < MAX_CATENARY_SAMPLES) {
      const num = tryParseInt(split);
      splitSamples.push({
        path: node.path,
        split,
        numericValue: num,
        isInteger: num !== null && Number.isInteger(num) && num > 0,
      });
    }

    // BLHA 高程样本
    const p0Blha = raw['POINT0.BLHA'] || null;
    const p1Blha = raw['POINT1.BLHA'] || null;
    if ((p0Blha || p1Blha) && blhaSamples.length < MAX_CATENARY_SAMPLES) {
      const p0e = parseBlhaElevation(p0Blha);
      const p1e = parseBlhaElevation(p1Blha);
      blhaSamples.push({
        path: node.path,
        point0Elevation: p0e,
        point1Elevation: p1e,
        elevationDelta: (p0e !== null && p1e !== null) ? (p1e - p0e) : null,
      });
    }
  }

  // 6. 计算覆盖率 ratio
  for (const field of CATENARY_CANDIDATE_FIELDS) {
    const c = coverage[field];
    c.ratio = wireCount > 0 ? c.count / wireCount : 0;
  }

  // 7. 生成语义假设、阻塞问题、建议
  const semanticHypotheses = buildSemanticHypotheses(coverage, wireCount);
  const blockingQuestions = buildBlockingQuestions(coverage, wireCount);
  const recommendations = buildCatenaryRecommendations(coverage, wireCount);

  return {
    wireCount,
    coverage,
    matrix0FormatSamples: matrix0Samples,
    kValueSamples,
    splitSamples,
    blhaElevationSamples: blhaSamples,
    semanticHypotheses,
    blockingQuestions,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// M4-B3 内部辅助
// ---------------------------------------------------------------------------

function emptyCatenaryReport(): LineCatenaryParamAuditReport {
  return {
    wireCount: 0,
    coverage: {},
    matrix0FormatSamples: [],
    kValueSamples: [],
    splitSamples: [],
    blhaElevationSamples: [],
    semanticHypotheses: ['线路工程图为空，无法做悬链线参数验证'],
    blockingQuestions: [],
    recommendations: ['需先打开线路 GIM 才能采集悬链线参数样本'],
  };
}

/** 尝试 parseFloat，失败返回 null */
function tryParseFloat(value: string): number | null {
  const n = parseFloat(value.trim());
  return Number.isFinite(n) ? n : null;
}

/** 尝试 parseInt（10 进制），失败返回 null */
function tryParseInt(value: string): number | null {
  const n = parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析 BLHA 第 3 段（高程，米）。
 * BLHA 格式：纬度,经度,高程,方位角（lat,lng,h,azimuth）
 * 失败返回 null。
 */
function parseBlhaElevation(blha: string | null): number | null {
  if (!blha) return null;
  const parts = blha.split(',');
  if (parts.length < 3) return null;
  const h = parseFloat(parts[2].trim());
  return Number.isFinite(h) ? h : null;
}

/**
 * 推断 MATRIX0 字符串中逗号分隔的元素数量。
 * 用于判断是 4x4 矩阵（16）、3x4 矩阵（12）、三元组（3）、标量（1）还是其他。
 */
function guessMatrix0Length(value: string | null): number | null {
  if (!value) return null;
  // 可能是逗号或空格分隔
  const commaCount = (value.match(/,/g) || []).length;
  if (commaCount > 0) {
    return commaCount + 1;
  }
  const spaceCount = (value.match(/\s+/g) || []).length;
  if (spaceCount > 0) {
    return spaceCount + 1;
  }
  // 单个数字
  const n = parseFloat(value.trim());
  return Number.isFinite(n) ? 1 : null;
}

/** 推断 MATRIX0 的可能格式 */
function guessMatrix0Format(value: string | null): string {
  const len = guessMatrix0Length(value);
  if (len === null) return 'unknown';
  if (len === 16) return '4x4-matrix';
  if (len === 12) return '3x4-matrix';
  if (len === 9) return '3x3-matrix';
  if (len === 4) return 'quaternion';
  if (len === 3) return 'triplet';
  if (len === 1) return 'scalar';
  if (len === 6) return '6-tuple';
  return `unknown(${len})`;
}

/** 生成语义假设（疑似 / 候选，不写结论） */
function buildSemanticHypotheses(
  coverage: LineCatenaryParamAuditReport['coverage'],
  wireCount: number,
): string[] {
  const hyp: string[] = [];
  if (wireCount === 0) return hyp;

  const kvalueCov = coverage['KVALUE'];
  if (kvalueCov && kvalueCov.count > 0) {
    hyp.push(`KVALUE 疑似张力 / 弧垂相关参数（覆盖率 ${(kvalueCov.ratio * 100).toFixed(1)}%），但物理含义待 M4-B3 样本核验`);
  } else {
    hyp.push('KVALUE 缺失，疑似为可选字段或来自父 F4(WIRE)');
  }

  const splitCov = coverage['SPLIT'];
  if (splitCov && splitCov.count > 0) {
    hyp.push(`SPLIT 疑似分裂导线数（覆盖率 ${(splitCov.ratio * 100).toFixed(1)}%），需验证是否为正整数`);
  }

  const p0m0Cov = coverage['POINT0.MATRIX0'];
  const p1m0Cov = coverage['POINT1.MATRIX0'];
  if ((p0m0Cov && p0m0Cov.count > 0) || (p1m0Cov && p1m0Cov.count > 0)) {
    hyp.push('POINT0/1.MATRIX0 疑似挂点或端点局部变换参数（坐标系与单位待确认）');
  }

  const p0BlhaCov = coverage['POINT0.BLHA'];
  if (p0BlhaCov && p0BlhaCov.count > 0) {
    hyp.push('POINT0.BLHA 第 3 段可作为高程候选（与 POINT1.BLHA 高差参与弧垂计算）');
  }

  const isJumperCov = coverage['ISJUMPER'];
  if (isJumperCov && isJumperCov.count > 0) {
    hyp.push(`ISJUMPER 疑似跳线标识（覆盖率 ${(isJumperCov.ratio * 100).toFixed(1)}%），跳线可能不需要悬链线计算`);
  }

  const matSheetCov = coverage['MATERIALSHEET'];
  if (matSheetCov && matSheetCov.count > 0) {
    hyp.push(`MATERIALSHEET 疑似导线材料表（覆盖率 ${(matSheetCov.ratio * 100).toFixed(1)}%），可能参与弧垂计算（线规/截面积）`);
  }

  const transformCov = coverage['TRANSFORMMATRIX'];
  if (transformCov && transformCov.count > 0) {
    hyp.push(`TRANSFORMMATRIX 疑似节点整体变换矩阵（覆盖率 ${(transformCov.ratio * 100).toFixed(1)}%），与 POINT0/1.MATRIX0 关系待确认`);
  }

  return hyp;
}

/** 生成阻塞问题（需人工或样本核验才能推进 M4-B4） */
function buildBlockingQuestions(
  coverage: LineCatenaryParamAuditReport['coverage'],
  wireCount: number,
): string[] {
  const qs: string[] = [];
  if (wireCount === 0) {
    qs.push('未发现 WIRE 节点，无法采集悬链线参数样本');
    return qs;
  }

  const kvalueCov = coverage['KVALUE'];
  if (!kvalueCov || kvalueCov.count === 0) {
    qs.push('KVALUE 在所有 WIRE 节点中缺失，是否来自父 F4(WIRE) 或 FAM 文件？');
  } else {
    qs.push('KVALUE 物理含义未确认（张力系数？弧垂参数？应力？是否单位无关？）');
  }

  const p0m0Cov = coverage['POINT0.MATRIX0'];
  if (!p0m0Cov || p0m0Cov.count === 0) {
    qs.push('POINT0.MATRIX0 缺失，悬链线挂点高程是否可仅依赖 BLHA 第 3 段？');
  } else {
    qs.push('POINT0/1.MATRIX0 坐标系与单位未确认（局部坐标？世界坐标？米？毫米？）');
  }

  const matSheetCov = coverage['MATERIALSHEET'];
  if (matSheetCov && matSheetCov.count > 0) {
    qs.push('是否需要 MATERIALSHEET 参与弧垂计算（导线截面/单位长度重量/张力等级）？');
  }

  qs.push('GIM 标准文档是否有 KVALUE/SPLIT/MATRIX0 的明确字段定义？');

  return qs;
}

/** 生成 M4-B4 决策建议 */
function buildCatenaryRecommendations(
  coverage: LineCatenaryParamAuditReport['coverage'],
  wireCount: number,
): string[] {
  const recs: string[] = [];
  if (wireCount === 0) {
    recs.push('无 WIRE 节点，无需进入 M4-B4');
    return recs;
  }

  const kvalueCov = coverage['KVALUE'];
  const p0BlhaCov = coverage['POINT0.BLHA'];
  const p1BlhaCov = coverage['POINT1.BLHA'];

  // 数据齐备性评估
  const kvalueReady = !!(kvalueCov && kvalueCov.count > 0);
  const blhaReady = !!(p0BlhaCov && p0BlhaCov.count > 0 && p1BlhaCov && p1BlhaCov.count > 0);

  if (kvalueReady && blhaReady) {
    recs.push('M4-B4 可先做"示意悬链线"：基于 KVALUE + BLHA 高程差，假设公式 f(x) = k * x * (L - x)（抛物线近似）');
    recs.push('M4-B4 不建议直接做"工程语义悬链线"：KVALUE 物理含义未确认，可能产生误导');
  } else {
    recs.push('M4-B4 数据齐备性不足：' + (!kvalueReady ? 'KVALUE 缺失 ' : '') + (!blhaReady ? 'BLHA 端点缺失' : ''));
  }

  recs.push('是否需要更多样本：当前每类最多 20 条样本，若 GIM 标准文档无字段定义，需收集 2-3 个不同电压等级 / 不同塔型的样本工程');
  recs.push('是否需要用户人工确认字段含义：建议在 M4-B3 报告输出后由用户对照样本工程确认');
  recs.push('是否继续保持直线段作为默认：建议是，悬链线作为可选增强（feature flag 控制）');

  return recs;
}
