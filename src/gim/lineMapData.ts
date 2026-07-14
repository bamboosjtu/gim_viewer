/**
 * M3-4：线路工程地图数据提取层（纯逻辑）。
 *
 * 从 GimGraph + LineAttributeIndex 提取地图展示所需的扁平数据结构 LineMapData，
 * 供 M3-5 的 lineMapView.ts 渲染。
 *
 * 分层边界（强制）：
 * - extractLineMapData(graph, attrs) => LineMapData，只接收这两个入参
 * - 禁止 import AppState、禁止读 state.currentFiles
 * - 不碰 DOM、不碰 DB
 * - attrs 由调用方（lineProjectView）通过 buildLineAttributeIndex(state) 组装后传入
 *
 * 坐标约定：BLHA = 纬度,经度,高程,方位角（lat 在前 lng 在后，不可颠倒）。
 * 缓存命中（currentFiles=null）时 attrs 由 SQLite 恢复，与 currentFiles 无关，
 * 仍能生成完整 LineMapData，不抛错、不读原 GIM。
 */

import type { GimGraph, GimGraphNode } from './gimGraphTypes.js';
import type { LineAttributeIndex } from './lineAttributeTypes.js';
import { normalizeGimPath, getFileNameLower } from './linePathNormalize.js';
import { DEBUG_LINE_MAP } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 杆塔标记 */
export interface TowerMarker {
  cbmPath: string;
  lat: number;
  lng: number;
  elev: number | null;
  azimuth: number | null;
  towerNumber?: string;
  towerType?: string;
  towerHeight?: string;
  turnAngle?: string;
  dataQuality: 'full' | 'partial' | 'coords-only';
  /** 命中的 FAM 源标识（用于诊断/UI） */
  famSource?: string;
  /** 命中的 DEV 源标识 */
  devSource?: string;
  /** 回指图节点，供点击回调使用 */
  nodeRef: GimGraphNode;
}

/** 导线段 */
export interface WireSegment {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  wireType: string;
  kValue?: string;
  split?: string;
  nodeRef: GimGraphNode;
  // ── 悬链线渲染（M4-B3C，ENABLE_CATENARY=true 时使用） ──
  /** 端点 0 高程（米，来自 BLHA 第 3 段）；缺失为 null */
  startElev: number | null;
  /** 端点 1 高程（米，来自 BLHA 第 3 段）；缺失为 null */
  endElev: number | null;
  /** 档距（米，Haversine 公式计算）；无效为 null */
  spanMeters: number | null;
  /** 拓扑分组：'inter-point'（跨塔，真实档距）/ 'same-point'（同塔内部连接）/ 'unknown' */
  groupKind: 'inter-point' | 'same-point' | 'unknown';
}

/** 跨越点标记 */
export interface CrossMarker {
  cbmPath: string;
  lat: number | null;
  lng: number | null;
  crossType?: string;
  name?: string;
  nodeRef: GimGraphNode;
}

/** 覆盖率诊断统计 */
export interface LineMapStats {
  towerTotal: number;
  towerWithBlha: number;
  towerWithFam: number;
  wireTotal: number;
  wireWithEndpoints: number;
  crossTotal: number;
  crossWithCoord: number;
}

/** 未解析引用（不阻断渲染） */
export interface LineMapUnresolved {
  towers: string[];
  wires: string[];
  crosses: string[];
  famSources: string[];
  devSources: string[];
}

/** 地图数据（提取结果） */
export interface LineMapData {
  towers: TowerMarker[];
  wires: WireSegment[];
  crosses: CrossMarker[];
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  warnings: string[];
  stats: LineMapStats;
  unresolved: LineMapUnresolved;
}

/** 拓扑索引（仅在 extractLineMapData 内部构建，不持久化、不回写 state） */
interface LineGraphTopoIndex {
  /** 路径 → 节点 */
  nodeByPath: Map<string, GimGraphNode>;
  /** 子路径 → 父节点 */
  parentByPath: Map<string, GimGraphNode>;
  /** 文件名小写 → 节点（用于按裸文件名反查节点） */
  nodeByFileNameLower: Map<string, GimGraphNode>;
  /** Tower_Device 路径 → 所属 F4System(GROUPTYPE=TOWER) */
  towerGroupByDevicePath: Map<string, GimGraphNode>;
  /** STRING 文件路径/文件名 → 所属 TOWER F4（导线端点兜底用） */
  towerGroupByStringPath: Map<string, GimGraphNode>;
  /** WIRE 路径 → 所属 F4System(GROUPTYPE=WIRE) */
  wireGroupByWirePath: Map<string, GimGraphNode>;
}

// ---------------------------------------------------------------------------
// BLHA 解析
// ---------------------------------------------------------------------------

/** BLHA 解析结果 */
interface BlhaCoord {
  lat: number;
  lng: number;
  elev: number | null;
  azimuth: number | null;
}

/**
 * 解析 BLHA 字符串（纬度,经度,高程,方位角）。
 *
 * 注意：BLHA = 纬度,经度（lat 在前 lng 在后），不可颠倒。
 * 示例："26.84596049,112.43415192,63.880,420.507943"
 *   → lat=26.84596049, lng=112.43415192, elev=63.880, azimuth=420.507943
 *
 * @returns 解析失败返回 null（不抛异常）
 */
function parseBlha(blha: string | undefined): BlhaCoord | null {
  if (!blha) return null;
  const parts = blha.split(',').map((s) => s.trim());
  if (parts.length < 2) return null;
  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  // 经纬度合理范围校验（中国境内 lat 0~60, lng 70~140），过滤明显错误值
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  let elev: number | null = null;
  if (parts.length >= 3 && parts[2] !== '') {
    const e = parseFloat(parts[2]);
    elev = isFinite(e) ? e : null;
  }
  let azimuth: number | null = null;
  if (parts.length >= 4 && parts[3] !== '') {
    const a = parseFloat(parts[3]);
    azimuth = isFinite(a) ? a : null;
  }
  return { lat, lng, elev, azimuth };
}

// ---------------------------------------------------------------------------
// 拓扑索引
// ---------------------------------------------------------------------------

/**
 * 构建 GimGraph 拓扑索引。
 *
 * GimGraph 是 children 树，想从 WIRE → F4(WIRE) → BACKSTRING/FRONTSTRING →
 * 所属 TOWER F4 → BLHA 稳定反查，必须先建立拓扑索引。
 */
function buildLineGraphTopoIndex(graph: GimGraph): LineGraphTopoIndex {
  const nodeByPath = new Map<string, GimGraphNode>(graph.nodesByPath);
  const parentByPath = new Map<string, GimGraphNode>();
  const nodeByFileNameLower = new Map<string, GimGraphNode>();

  // 递归建立 parentByPath + nodeByFileNameLower
  function walk(node: GimGraphNode): void {
    nodeByFileNameLower.set(getFileNameLower(node.path), node);
    for (const child of node.children) {
      parentByPath.set(child.path, node);
      walk(child);
    }
  }
  if (graph.root) walk(graph.root);

  const towerGroupByDevicePath = new Map<string, GimGraphNode>();
  const towerGroupByStringPath = new Map<string, GimGraphNode>();
  const wireGroupByWirePath = new Map<string, GimGraphNode>();

  /** 向上回溯找到满足条件的祖先 F4System */
  function findAncestorF4(start: GimGraphNode, groupType: string): GimGraphNode | null {
    let cur: GimGraphNode | null = parentByPath.get(start.path) || null;
    while (cur) {
      if (cur.entityName === 'F4System' && cur.rawProps['GROUPTYPE'] === groupType) {
        return cur;
      }
      cur = parentByPath.get(cur.path) || null;
    }
    return null;
  }

  for (const node of nodeByPath.values()) {
    if (node.entityName === 'WIRE') {
      const wireF4 = findAncestorF4(node, 'WIRE');
      if (wireF4) wireGroupByWirePath.set(node.path, wireF4);
    } else if (node.entityName === 'Tower_Device') {
      const towerF4 = findAncestorF4(node, 'TOWER');
      if (towerF4) towerGroupByDevicePath.set(node.path, towerF4);
    } else if (node.entityName === 'F4System' && node.rawProps['GROUPTYPE'] === 'TOWER') {
      // STRING 子节点（.cbm）→ 所属 TOWER F4，供导线端点兜底
      for (const child of node.children) {
        towerGroupByStringPath.set(child.path, node);
        towerGroupByStringPath.set(getFileNameLower(child.path), node);
      }
    }
  }

  return {
    nodeByPath,
    parentByPath,
    nodeByFileNameLower,
    towerGroupByDevicePath,
    towerGroupByStringPath,
    wireGroupByWirePath,
  };
}

// ---------------------------------------------------------------------------
// 属性查找辅助
// ---------------------------------------------------------------------------

/** 杆塔编号候选键（prop_key，大小写不敏感） */
const TOWER_NUMBER_KEYS = ['N0', 'TOWERNO', 'TOWERNUMBER', 'TOWERNUM', 'NUM', 'BH'];
/** 塔型候选键 */
const TOWER_TYPE_KEYS = ['TOWERTYPE', 'TOWERMODEL', 'MODEL', 'TOWERKIND', 'TYPE'];
/** 呼高候选键 */
const TOWER_HEIGHT_KEYS = ['TOWERHEIGHT', 'HEIGHT', 'HEIGHTVALUE', 'CALLHEIGHT', 'HOUGAO'];
/** 转角候选键 */
const TURN_ANGLE_KEYS = ['TURNANGLE', 'ANGLE', 'AZIMUTH'];

/** DEV 设备类型候选键 */
const DEV_TYPE_KEYS = ['DEVICETYPE', 'TYPE', 'CLASSIFY', 'TOWERTYPE'];

/**
 * 在属性 propMap 中按候选键查找值。
 * 先精确匹配 prop_key，再回退大小写不敏感 + 包含匹配。
 * 泛型 T 约束为含 prop_value 的记录类型，避免 Map 不变性导致的强转问题。
 */
function findAttrValue<T extends { prop_value?: string | null }>(
  propMap: Map<string, T[]> | undefined,
  candidates: string[],
): string | undefined {
  if (!propMap || propMap.size === 0) return undefined;
  // 1. 精确匹配
  for (const cand of candidates) {
    const list = propMap.get(cand);
    if (list && list.length > 0) {
      const rec = list[0];
      if (rec.prop_value) return rec.prop_value;
    }
  }
  // 2. 大小写不敏感精确匹配
  for (const cand of candidates) {
    const candLower = cand.toLowerCase();
    for (const [key, list] of propMap) {
      if (key.toLowerCase() === candLower && list.length > 0) {
        const rec = list[0];
        if (rec.prop_value) return rec.prop_value;
      }
    }
  }
  // 3. 包含匹配（最后兜底）
  for (const cand of candidates) {
    const candLower = cand.toLowerCase();
    for (const [key, list] of propMap) {
      if (key.toLowerCase().includes(candLower) && list.length > 0) {
        const rec = list[0];
        if (rec.prop_value) return rec.prop_value;
      }
    }
  }
  return undefined;
}

/** 收集 TOWER F4 节点及其 Tower_Device 子节点的 FAM 文件引用（去重） */
function gatherFamRefs(towerF4: GimGraphNode): string[] {
  const set = new Set<string>();
  for (const f of towerF4.refs.famFiles) if (f) set.add(f);
  for (const child of towerF4.children) {
    if (child.entityName === 'Tower_Device') {
      for (const f of child.refs.famFiles) if (f) set.add(f);
    }
  }
  return Array.from(set);
}

/** 收集 TOWER F4 节点及其 Tower_Device 子节点的 DEV 文件引用（去重） */
function gatherDevRefs(towerF4: GimGraphNode): string[] {
  const set = new Set<string>();
  for (const d of towerF4.refs.devFiles) if (d) set.add(d);
  for (const child of towerF4.children) {
    if (child.entityName === 'Tower_Device') {
      for (const d of child.refs.devFiles) if (d) set.add(d);
    }
  }
  return Array.from(set);
}

/** 查找 FAM 属性表并返回 (propMap, source)。返回类型由 attrs 推断，避免强转。 */
function lookupFamPropMap(refs: string[], attrs: LineAttributeIndex) {
  for (const ref of refs) {
    if (!ref) continue;
    // 1. 归一化路径 → famBySourcePath
    const norm = normalizeGimPath(ref);
    if (norm) {
      const m = attrs.famBySourcePath.get(norm);
      if (m) return { propMap: m, source: norm };
    }
    // 2. 文件名小写 → famByFileNameLower
    const fnl = getFileNameLower(ref);
    if (fnl) {
      const m = attrs.famByFileNameLower.get(fnl);
      if (m) return { propMap: m, source: fnl };
    }
  }
  return { propMap: undefined, source: '' };
}

/** 查找 DEV 属性表并返回 (propMap, source)。返回类型由 attrs 推断，避免强转。 */
function lookupDevPropMap(refs: string[], attrs: LineAttributeIndex) {
  for (const ref of refs) {
    if (!ref) continue;
    const norm = normalizeGimPath(ref);
    if (norm) {
      const m = attrs.devBySourcePath.get(norm);
      if (m) return { propMap: m, source: norm };
    }
    const fnl = getFileNameLower(ref);
    if (fnl) {
      const m = attrs.devByFileNameLower.get(fnl);
      if (m) return { propMap: m, source: fnl };
    }
  }
  return { propMap: undefined, source: '' };
}

// ---------------------------------------------------------------------------
// 导线类型与端点解析
// ---------------------------------------------------------------------------

/** 解析导线类型：优先 WIRE 节点自身 WIRETYPE，回退父 F4System(GROUPTYPE=WIRE) */
function resolveWireType(node: GimGraphNode, topo: LineGraphTopoIndex): string {
  const own = node.rawProps['WIRETYPE'];
  if (own) return own.toUpperCase();
  const wireF4 = topo.wireGroupByWirePath.get(node.path);
  if (wireF4) {
    const wt = wireF4.rawProps['WIRETYPE'];
    if (wt) return wt.toUpperCase();
  }
  return 'UNKNOWN';
}

/** 从节点 rawProp 值中提取裸文件名（refs 已是文件名，此函数用于 rawProp 兜底） */
function extractFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const p = trimmed.replace(/\\/g, '/');
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : trimmed;
}

/**
 * 导线端点兜底：WIRE 缺少 POINT0/1.BLHA 时，
 * 用 BACKSTRING/FRONTSTRING 反查两端所属 TOWER F4 的 BLHA。
 */
function resolveWireEndpointsFromTowers(
  node: GimGraphNode,
  topo: LineGraphTopoIndex,
): { startLat: number; startLng: number; endLat: number; endLng: number } | null {
  const backStr = node.rawProps['BACKSTRING'];
  const frontStr = node.rawProps['FRONTSTRING'];
  if (!backStr && !frontStr) return null;

  /** 通过 STRING 文件引用找到 TOWER F4 并取 BLHA */
  function blhaFromStringRef(ref: string): BlhaCoord | null {
    if (!ref) return null;
    const fn = extractFileName(ref);
    if (!fn) return null;
    const towerF4 = topo.towerGroupByStringPath.get(fn) || topo.towerGroupByStringPath.get(getFileNameLower(fn));
    if (!towerF4) return null;
    return parseBlha(towerF4.rawProps['BLHA']);
  }

  const start = backStr ? blhaFromStringRef(backStr) : null;
  const end = frontStr ? blhaFromStringRef(frontStr) : null;
  if (!start || !end) return null;
  return { startLat: start.lat, startLng: start.lng, endLat: end.lat, endLng: end.lng };
}

// ---------------------------------------------------------------------------
// bbox 计算
// ---------------------------------------------------------------------------

/** Haversine 距离（米），地球半径 6371000m（用于档距近似） */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * 判断导线端点是否为同塔内部连接（same-point）。
 *
 * same-point：两端 BLHA 的 lat/lng 完全相同（精度 1e-9），表示同塔内不同挂点间的连接。
 * inter-point：跨塔真实档距，需要绘制悬链线。
 */
function classifyWireGroup(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
): 'same-point' | 'inter-point' {
  const samePoint = Math.abs(startLat - endLat) < 1e-9
    && Math.abs(startLng - endLng) < 1e-9;
  return samePoint ? 'same-point' : 'inter-point';
}

/** 计算所有塔位 + 跨越点的经纬度包围盒 */
function computeBbox(towers: TowerMarker[], crosses: CrossMarker[]): LineMapData['bbox'] {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  let hasAny = false;
  for (const t of towers) {
    if (t.lat < minLat) minLat = t.lat;
    if (t.lat > maxLat) maxLat = t.lat;
    if (t.lng < minLng) minLng = t.lng;
    if (t.lng > maxLng) maxLng = t.lng;
    hasAny = true;
  }
  for (const c of crosses) {
    if (c.lat == null || c.lng == null) continue;
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lng < minLng) minLng = c.lng;
    if (c.lng > maxLng) maxLng = c.lng;
    hasAny = true;
  }
  if (!hasAny) return { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
  return { minLat, maxLat, minLng, maxLng };
}

/** bbox 是否有效（有可定位数据且范围非零退化） */
export function isLineMapDataValid(data: LineMapData): boolean {
  return data.towers.length > 0
    && isFinite(data.bbox.minLat)
    && data.bbox.maxLat > data.bbox.minLat
    && data.bbox.maxLng > data.bbox.minLng;
}

// ---------------------------------------------------------------------------
// 主提取函数
// ---------------------------------------------------------------------------

/**
 * 从 GimGraph + LineAttributeIndex 提取地图展示所需的 LineMapData。
 *
 * 遍历 graph.nodesByPath：
 * - F4System + GROUPTYPE=TOWER  → TowerMarker（坐标来自 rawProps.BLHA）
 * - F4System + GROUPTYPE=CROSS  → CrossMarker（坐标来自 BLHA，无则进 unresolved）
 * - WIRE                        → WireSegment（坐标来自 POINT0/1.BLHA，兜底 BACK/FRONTSTRING）
 *
 * 属性（杆塔编号/塔型/呼高/转角）从 attrs 查找，缺失不阻断渲染。
 */
export function extractLineMapData(graph: GimGraph, attrs: LineAttributeIndex): LineMapData {
  const topo = buildLineGraphTopoIndex(graph);
  const towers: TowerMarker[] = [];
  const wires: WireSegment[] = [];
  const crosses: CrossMarker[] = [];
  const warnings: string[] = [];
  const unresolved: LineMapUnresolved = {
    towers: [], wires: [], crosses: [], famSources: [], devSources: [],
  };

  let towerTotal = 0;
  let towerWithBlha = 0;
  let towerWithFam = 0;
  let wireTotal = 0;
  let wireWithEndpoints = 0;
  let crossTotal = 0;
  let crossWithCoord = 0;

  for (const [path, node] of topo.nodeByPath) {
    // ---- 塔位 ----
    if (node.entityName === 'F4System' && node.rawProps['GROUPTYPE'] === 'TOWER') {
      towerTotal++;
      const blha = parseBlha(node.rawProps['BLHA']);
      if (!blha) {
        unresolved.towers.push(path);
        warnings.push(`塔位 ${path} 缺少 BLHA 坐标`);
        continue;
      }
      towerWithBlha++;

      // FAM 属性查找
      const famRefs = gatherFamRefs(node);
      const famLookup = lookupFamPropMap(famRefs, attrs);
      const famPropMap = famLookup.propMap;
      const famSource = famLookup.source || undefined;
      if (!famPropMap && famRefs.length > 0) {
        for (const r of famRefs) unresolved.famSources.push(r);
      }

      const towerNumber = findAttrValue(famPropMap, TOWER_NUMBER_KEYS);
      const towerType = findAttrValue(famPropMap, TOWER_TYPE_KEYS);
      const towerHeight = findAttrValue(famPropMap, TOWER_HEIGHT_KEYS);
      const turnAngle = findAttrValue(famPropMap, TURN_ANGLE_KEYS);

      // DEV 属性查找（设备类型，用于耐张/直线分类）
      const devRefs = gatherDevRefs(node);
      const devLookup = lookupDevPropMap(devRefs, attrs);
      const devPropMap = devLookup.propMap;
      const devSource = devLookup.source || undefined;
      if (!devPropMap && devRefs.length > 0) {
        for (const r of devRefs) unresolved.devSources.push(r);
      }
      // DEVICETYPE 补充塔型（若 FAM 未命中塔型）
      const devType = findAttrValue(devPropMap, DEV_TYPE_KEYS);
      const finalTowerType = towerType || devType;

      if (famSource) towerWithFam++;
      const hasAttr = !!(towerNumber || finalTowerType || towerHeight || turnAngle);
      let dataQuality: TowerMarker['dataQuality'] = 'coords-only';
      if (famSource && hasAttr) dataQuality = 'full';
      else if (famSource || hasAttr) dataQuality = 'partial';

      towers.push({
        cbmPath: path,
        lat: blha.lat,
        lng: blha.lng,
        elev: blha.elev,
        azimuth: blha.azimuth,
        towerNumber,
        towerType: finalTowerType,
        towerHeight,
        turnAngle,
        dataQuality,
        famSource,
        devSource,
        nodeRef: node,
      });
      continue;
    }

    // ---- 跨越点 ----
    if (node.entityName === 'F4System' && node.rawProps['GROUPTYPE'] === 'CROSS') {
      crossTotal++;
      const blha = parseBlha(node.rawProps['BLHA']);
      if (blha) {
        crossWithCoord++;
        crosses.push({
          cbmPath: path,
          lat: blha.lat,
          lng: blha.lng,
          crossType: node.classifyName,
          name: node.name,
          nodeRef: node,
        });
      } else {
        crosses.push({
          cbmPath: path,
          lat: null,
          lng: null,
          crossType: node.classifyName,
          name: node.name,
          nodeRef: node,
        });
        unresolved.crosses.push(path);
      }
      continue;
    }

    // ---- 导线 ----
    if (node.entityName === 'WIRE') {
      wireTotal++;
      const p0 = parseBlha(node.rawProps['POINT0.BLHA']);
      const p1 = parseBlha(node.rawProps['POINT1.BLHA']);

      if (p0 && p1) {
        wireWithEndpoints++;
        const wireType = resolveWireType(node, topo);
        const groupKind = classifyWireGroup(p0.lat, p0.lng, p1.lat, p1.lng);
        const spanMeters = groupKind === 'inter-point'
          ? haversineMeters(p0.lat, p0.lng, p1.lat, p1.lng)
          : 0;
        wires.push({
          startLat: p0.lat, startLng: p0.lng,
          endLat: p1.lat, endLng: p1.lng,
          wireType,
          kValue: node.rawProps['KVALUE'] || undefined,
          split: node.rawProps['SPLIT'] || undefined,
          nodeRef: node,
          startElev: p0.elev,
          endElev: p1.elev,
          spanMeters,
          groupKind,
        });
      } else {
        // 兜底：BACKSTRING/FRONTSTRING 反查塔位 BLHA
        const fb = resolveWireEndpointsFromTowers(node, topo);
        if (fb) {
          wireWithEndpoints++;
          const wireType = resolveWireType(node, topo);
          // 兜底路径无 elev 信息（仅 lat/lng）
          wires.push({
            ...fb,
            wireType,
            kValue: node.rawProps['KVALUE'] || undefined,
            split: node.rawProps['SPLIT'] || undefined,
            nodeRef: node,
            startElev: null,
            endElev: null,
            spanMeters: null,
            groupKind: 'unknown',
          });
        } else {
          unresolved.wires.push(path);
        }
      }
      continue;
    }
  }

  const bbox = computeBbox(towers, crosses);

  if (warnings.length > 0) {
    debugLog(DEBUG_LINE_MAP, '[LineMapData] 提取完成，含', warnings.length, '条警告');
  }
  debugLog(DEBUG_LINE_MAP, '[LineMapData] 提取统计:', {
    towers: towers.length,
    wires: wires.length,
    crosses: crosses.length,
    stats: {
      towerTotal, towerWithBlha, towerWithFam,
      wireTotal, wireWithEndpoints,
      crossTotal, crossWithCoord,
    },
    unresolved: {
      towers: unresolved.towers.length,
      wires: unresolved.wires.length,
      crosses: unresolved.crosses.length,
      famSources: unresolved.famSources.length,
      devSources: unresolved.devSources.length,
    },
    bbox,
  });

  return {
    towers,
    wires,
    crosses,
    bbox,
    warnings,
    stats: {
      towerTotal, towerWithBlha, towerWithFam,
      wireTotal, wireWithEndpoints,
      crossTotal, crossWithCoord,
    },
    unresolved,
  };
}
