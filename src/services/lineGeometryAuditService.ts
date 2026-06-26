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
