/**
 * 线路工程 UI 渲染层。
 *
 * 复用左侧层级树面板（cbmTreePanel）显示线路 CBM 树，
 * 复用文件设备面板（fileDevPanel）显示文件摘要，
 * 复用属性面板（propsDrawerBody）显示节点属性。
 *
 * 关键约束（spec 五）：
 * - 点击线路节点只展示属性，不创建 ViewerRuntime
 * - 不弹 IFC 模态框
 * - 不显示"未找到 IFC 文件"为错误
 */

import type { AppState } from '../app/state.js';
import type { GimGraph, GimGraphNode } from '../gim/gimGraphTypes.js';
import type { LineMapData, WireSegment } from '../gim/lineMapData.js';
import { escHtml } from '../shared/html.js';
import { cbmTreePanel, fileDevPanel, modelListEl, propsDrawerBody, propsDrawer, btnToggleProps, emptyTipEl, container } from './dom.js';
import type { LineMapViewHandle } from './lineMapView.js';
import type { LineMapBaseLayerHandle } from './lineMapBaseLayer.js';
import type { LineMapProjection, GeoBBox } from './lineMapProjection.js';
import { createMapLibreProjection } from './lineMapProjection.js';
import { renderLineMap } from './lineMapView.js';
import { extractLineMapData, isLineMapDataValid } from '../gim/lineMapData.js';
import { buildLineAttributeIndex } from '../services/lineAttrRestoreService.js';
import { buildWireSemanticInfo } from '../services/lineWireSemanticService.js';
import type { WireSemanticInfo } from '../services/lineWireSemanticService.js';
import { buildLineCatenaryParamAuditReport } from '../services/lineGeometryAuditService.js';
import { DEBUG_LINE_MAP } from '../config/debug.js';
import { ENABLE_MAPLIBRE_EXPERIMENT, ENABLE_PMTILES_EXPERIMENT, PMTILES_DEMO_URL, LINE_BASEMAP_MODE } from '../config/features.js';
import { setBasemapStatus, resetBasemapStatus } from '../services/basemapStatusService.js';
import type { BasemapStatus } from '../services/basemapStatusService.js';
import { debugLog, debugWarn } from '../utils/logger.js';

/**
 * 把 LINE_BASEMAP_MODE 映射为成功后的 BasemapStatus。
 *
 * MVP 阶段 LINE_BASEMAP_MODE 恒为 'osm-online'，
 * 'empty' / 'pmtiles' 仅作为内部枚举保留，不进入当前 MVP 范围。
 */
function basemapStatusFromMode(mode: string): BasemapStatus {
  if (mode === 'osm-online') return 'osm-online';
  if (mode === 'pmtiles') return 'pmtiles';
  return 'empty';
}

/**
 * M4-B3：构建悬链线参数审计摘要（精简版，用于 debugLog 输出）。
 *
 * 不输出全部样本，只输出：
 * - wireCount
 * - 各候选字段覆盖率（KVALUE/SPLIT/MATRIX0/BLHA 等）
 * - 阻塞问题数量
 *
 * 完整报告需调用 lineGeometryAuditService.buildLineCatenaryParamAuditReport。
 *
 * @param graph 线路工程图
 * @param mapData 已提取的地图数据
 */
function buildLineCatenaryAuditSummary(graph: unknown, mapData: unknown): {
  wireCount: number;
  coverage: Record<string, { count: number; ratio: number }>;
  blockingQuestionCount: number;
} {
  const report = buildLineCatenaryParamAuditReport({ graph, mapData });
  // 精简 coverage：移除 sampleValues 避免日志过大
  const coverageSummary: Record<string, { count: number; ratio: number }> = {};
  for (const [field, stat] of Object.entries(report.coverage)) {
    coverageSummary[field] = { count: stat.count, ratio: stat.ratio };
  }
  return {
    wireCount: report.wireCount,
    coverage: coverageSummary,
    blockingQuestionCount: report.blockingQuestions.length,
  };
}

/** 线路工程实体图标（扩展变电工程的 ENTITY_ICONS） */
const LINE_ENTITY_ICONS: Record<string, string> = {
  F1System: '🏗️',
  F2System: '🏢',
  F3System: '⚡',
  F4System: '🔧',
  Tower_Device: '🗼',
  Wire_Device: '〰️',
  WIRE: '〰️',
  CROSS: '✖️',
  PARTINDEX: '🔩',
};

/** 节点显示名称：classifyName 优先，回退 entityName，再回退文件名 */
function nodeDisplayName(node: GimGraphNode): string {
  const fn = node.path.split('/').pop() || node.path;
  return node.classifyName || node.entityName || fn.replace(/\.(cbm|dev|fam)$/i, '');
}

/**
 * 递归渲染线路 CBM 树节点。
 * 复用 tree-node / tree-row / tree-toggle / tree-icon / tree-label / tree-children 样式。
 */
function renderLineTreeNode(
  node: GimGraphNode,
  parentEl: HTMLElement,
  onNodeClick: (node: GimGraphNode) => void,
): void {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  // Phase 4：地图点击塔位后用 data-node-path 反查树行并选中
  row.dataset.nodePath = node.path;
  const toggle = document.createElement('span');
  toggle.className = `tree-toggle ${node.children.length === 0 ? 'leaf' : ''}`;
  toggle.textContent = '▶';
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = LINE_ENTITY_ICONS[node.entityName] || '📁';
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = nodeDisplayName(node);
  label.title = node.path;
  row.appendChild(toggle);
  row.appendChild(icon);
  row.appendChild(label);
  nodeEl.appendChild(row);
  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  nodeEl.appendChild(childrenEl);

  let expanded = false;
  let childrenRendered = false;
  row.addEventListener('click', () => {
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    onNodeClick(node);
    if (node.children.length > 0) {
      expanded = !expanded;
      toggle.classList.toggle('expanded', expanded);
      childrenEl.classList.toggle('expanded', expanded);
      if (expanded && !childrenRendered) {
        for (const child of node.children) renderLineTreeNode(child, childrenEl, onNodeClick);
        childrenRendered = true;
      }
    }
  });
  parentEl.appendChild(nodeEl);
}

/** 渲染文件设备面板摘要（线路工程无 FileDevRelation，改为文件统计摘要） */
function renderLineFileSummary(graph: GimGraph): void {
  fileDevPanel.innerHTML = '';
  const stats = graph.stats;

  // 文件计数统一从 stats 读取（与缓存恢复路径一致：
  // 缓存命中时 filesByType 数组为空，计数仅存在于 stats）
  const summary: [string, string][] = [
    ['CBM 文件', String(stats.CBM || 0)],
    ['DEV 文件', String(stats.DEV || 0)],
    ['FAM 文件', String(stats.FAM || 0)],
    ['PHM 文件', String(stats.PHM || 0)],
    ['MOD 文件', String(stats.MOD || 0)],
    ['STL 文件', String(stats.STL || 0)],
    ['IFC 文件', String(stats.IFC || 0)],
    ['—', '—'],
    ['F1System', String(stats.F1System || 0)],
    ['F2System', String(stats.F2System || 0)],
    ['F3System', String(stats.F3System || 0)],
    ['F4System', String(stats.F4System || 0)],
    ['Tower_Device', String(stats.Tower_Device || 0)],
    ['Wire_Device', String(stats.Wire_Device || 0)],
    ['WIRE', String(stats.WIRE || 0)],
    ['CROSS', String(stats.CROSS || 0)],
    ['—', '—'],
    ['节点总数', String(stats.total || 0)],
  ];

  const wrap = document.createElement('div');
  wrap.className = 'props-section';
  const title = document.createElement('div');
  title.className = 'props-section-title';
  title.textContent = '线路工程文件摘要';
  wrap.appendChild(title);
  const table = document.createElement('table');
  table.className = 'props-table';
  for (const [k, v] of summary) {
    const tr = document.createElement('tr');
    const tdK = document.createElement('td');
    tdK.className = 'prop-key';
    tdK.textContent = k;
    const tdV = document.createElement('td');
    tdV.className = 'prop-val';
    tdV.textContent = v;
    tr.appendChild(tdK);
    tr.appendChild(tdV);
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  fileDevPanel.appendChild(wrap);
}

/** 渲染模型面板（线路工程无 IFC 模型，清空占位） */
function renderLineModelPanel(): void {
  if (!modelListEl) return;
  modelListEl.innerHTML = '';
}

/**
 * Phase 5：渲染地图数据统计与未解析引用摘要。
 *
 * 数据来源：mapData.stats + mapData.unresolved。
 * - 不影响原文件摘要（renderLineFileSummary）
 * - unresolved 数量较大时只显示数量，不展开全部路径
 * - CROSS 无坐标时不被当成错误，只显示"未定位跨越点数量"
 */
function renderMapStats(mapData: LineMapData): void {
  const s = mapData.stats;
  const u = mapData.unresolved;

  const rows: [string, string][] = [
    ['塔位总数', String(s.towerTotal)],
    ['有坐标塔位', String(s.towerWithBlha)],
    ['导线段总数', String(s.wireTotal)],
    ['有端点导线', String(s.wireWithEndpoints)],
    ['跨越点总数', String(s.crossTotal)],
    ['有坐标跨越点', String(s.crossWithCoord)],
    ['FAM 命中塔位', String(s.towerWithFam)],
    ['—', '—'],
    ['未定位塔位', String(u.towers.length)],
    ['未定位导线', String(u.wires.length)],
    ['未定位跨越点', String(u.crosses.length)],
    ['FAM 未命中引用', String(u.famSources.length)],
    ['DEV 未命中引用', String(u.devSources.length)],
  ];

  const wrap = document.createElement('div');
  wrap.className = 'props-section';
  const title = document.createElement('div');
  title.className = 'props-section-title';
  title.textContent = '地图数据统计';
  wrap.appendChild(title);
  const table = document.createElement('table');
  table.className = 'props-table';
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const tdK = document.createElement('td');
    tdK.className = 'prop-key';
    tdK.textContent = k;
    const tdV = document.createElement('td');
    tdV.className = 'prop-val';
    tdV.textContent = v;
    tr.appendChild(tdK);
    tr.appendChild(tdV);
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  fileDevPanel.appendChild(wrap);
}

/** 渲染引用清单为 HTML */
function renderRefs(refs: GimGraphNode['refs']): string {
  const sections: [string, string[]][] = [
    ['CBM 引用', refs.cbmFiles],
    ['DEV 引用', refs.devFiles],
    ['FAM 引用', refs.famFiles],
    ['PHM 引用', refs.phmFiles],
    ['MOD 引用', refs.modFiles],
    ['STL 引用', refs.stlFiles],
    ['WIRE 引用', refs.wireFiles],
    ['IFC 引用', refs.ifcFiles],
  ];
  let html = '';
  for (const [title, files] of sections) {
    if (files.length === 0) continue;
    html += `<div class="props-section"><div class="props-section-title">${escHtml(title)} (${files.length})</div><table class="props-table">`;
    for (const f of files) {
      html += `<tr><td class="prop-val" colspan="2" style="font-family:monospace;font-size:11px;color:#888;word-break:break-all">${escHtml(f)}</td></tr>`;
    }
    html += '</table></div>';
  }
  // rawRefs（STRING<i>.GPOINT 等非文件挂点信息）
  const rawRefKeys = Object.keys(refs.rawRefs);
  if (rawRefKeys.length > 0) {
    html += '<div class="props-section"><div class="props-section-title">挂点 / 原始引用</div><table class="props-table">';
    for (const k of rawRefKeys) {
      const vals = refs.rawRefs[k];
      html += `<tr><td class="prop-key">${escHtml(k)}</td><td class="prop-val">${escHtml(vals.join('; '))}</td></tr>`;
    }
    html += '</table></div>';
  }
  return html;
}

/** WIRE 节点需要突出显示的字段 */
const WIRE_HIGHLIGHT_KEYS = ['KVALUE', 'SPLIT', 'POINT0.BLHA', 'POINT1.BLHA'];

/** 显示线路节点属性到属性面板（纯 UI，不创建 Viewer） */
export function showLineNodeProperties(node: GimGraphNode): void {
  let html = `<div class="props-header">${escHtml(nodeDisplayName(node))}</div>`;

  // 基本信息
  html += '<div class="props-section"><div class="props-section-title">基本信息</div><table class="props-table">';
  const fileName = node.path.split('/').pop() || node.path;
  const basic: [string, string][] = [
    ['路径', node.path],
    ['文件名', fileName],
    ['实体类型', node.entityName],
    ['分类名称', node.classifyName],
    ['子节点数', String(node.children.length)],
  ];
  for (const [k, v] of basic) {
    if (v) html += `<tr><td class="prop-key">${escHtml(k)}</td><td class="prop-val">${escHtml(v)}</td></tr>`;
  }
  html += '</table></div>';

  // WIRE 节点突出显示字段
  if (node.entityName === 'WIRE') {
    const highlightVals: [string, string][] = [];
    for (const k of WIRE_HIGHLIGHT_KEYS) {
      if (node.rawProps[k]) highlightVals.push([k, node.rawProps[k]]);
    }
    // 补充 POINT0.MATRIX0 / POINT1.MATRIX0（悬链线计算用）
    for (const k of ['POINT0.MATRIX0', 'POINT1.MATRIX0']) {
      if (node.rawProps[k]) highlightVals.push([k, node.rawProps[k]]);
    }
    if (highlightVals.length > 0) {
      html += '<div class="props-section"><div class="props-section-title">WIRE 悬链线参数</div><table class="props-table">';
      for (const [k, v] of highlightVals) {
        html += `<tr><td class="prop-key">${escHtml(k)}</td><td class="prop-val" style="font-family:monospace;font-size:11px;word-break:break-all">${escHtml(v)}</td></tr>`;
      }
      html += '</table></div>';
    }
  }

  // 原始属性 rawProps（排除已突出显示的 WIRE 字段，避免重复）
  const excludeKeys = new Set<string>([
    'ENTITYNAME', 'GROUPTYPE', 'WIRETYPE', 'DEVICETYPE', 'SYSCLASSIFYNAME', 'PARTNAME',
    'TRANSFORMMATRIX',
    ...(node.entityName === 'WIRE' ? WIRE_HIGHLIGHT_KEYS : []),
  ]);
  const otherProps: [string, string][] = [];
  for (const [k, v] of Object.entries(node.rawProps)) {
    if (excludeKeys.has(k)) continue;
    if (!v) continue;
    otherProps.push([k, v]);
  }
  if (otherProps.length > 0) {
    html += '<div class="props-section"><div class="props-section-title">原始属性</div><table class="props-table">';
    for (const [k, v] of otherProps) {
      html += `<tr><td class="prop-key">${escHtml(k)}</td><td class="prop-val" style="font-family:monospace;font-size:11px;word-break:break-all">${escHtml(v)}</td></tr>`;
    }
    html += '</table></div>';
  }

  // 变换矩阵
  const tm = node.rawProps['TRANSFORMMATRIX'];
  if (tm && tm !== '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1') {
    html += '<div class="props-section"><div class="props-section-title">变换矩阵</div><table class="props-table">';
    html += `<tr><td class="prop-val" colspan="2" style="font-family:monospace;font-size:11px;color:#888;word-break:break-all">${escHtml(tm)}</td></tr>`;
    html += '</table></div>';
  }

  // 引用清单
  html += renderRefs(node.refs);

  propsDrawerBody.innerHTML = html;
}

/**
 * M4-B2：显示导线属性到属性面板。
 *
 * 与 showLineNodeProperties 区别：
 * - 入参是 WireSegment（地图渲染数据），不是 GimGraphNode
 * - 展示结构化语义信息（WireSemanticInfo）：导线类型、图层、跳线、分裂数、档距、端点 BLHA、
 *   POINT0/1.MATRIX0、BACK/FRONTSTRING 等
 * - 缺失字段显示 "—"，不报错
 * - 档距保留 1 位小数
 * - 同步展示原始 rawProps（折叠在"原始属性"小节），便于排障
 *
 * @param wire 地图渲染的 WireSegment
 */
function showWireProperties(wire: WireSegment): void {
  const info: WireSemanticInfo = buildWireSemanticInfo({ wire });
  const node = wire.nodeRef;
  const nodeName = node ? nodeDisplayName(node) : '导线';
  const fileName = node ? (node.path.split('/').pop() || node.path) : '';

  let html = `<div class="props-header">〰️ ${escHtml(nodeName)}</div>`;

  // 导线语义信息（核心区）
  const layerLabelMap: Record<string, string> = {
    conductor: '导线层 (conductor)',
    groundwire: '地线层 (groundwire)',
    opgw: 'OPGW 层 (opgw)',
    unknownWire: '未知导线层 (unknownWire)',
  };
  const rows: [string, string][] = [
    ['导线类型', info.wireType || '—'],
    ['图层', layerLabelMap[info.layerKey] || info.layerKey],
    ['是否跳线', info.isJumper ? '是 (ISJUMPER)' : '否'],
    ['分裂数 (SPLIT)', info.split != null ? String(info.split) : '—'],
    ['档距 (近似)', info.spanMeters != null ? info.spanMeters.toFixed(1) + ' m' : '—'],
    ['KVALUE', info.kValue || '—'],
    ['起点 BLHA (POINT0)', info.point0Blha || '—'],
    ['终点 BLHA (POINT1)', info.point1Blha || '—'],
    ['POINT0.MATRIX0', info.point0Matrix0 || '—'],
    ['POINT1.MATRIX0', info.point1Matrix0 || '—'],
    ['BACKSTRING', info.backString || '—'],
    ['FRONTSTRING', info.frontString || '—'],
  ];

  html += '<div class="props-section"><div class="props-section-title">导线语义</div><table class="props-table">';
  for (const [k, v] of rows) {
    const isLongVal = v.length > 40;
    const valStyle = isLongVal
      ? 'font-family:monospace;font-size:11px;word-break:break-all'
      : '';
    html += `<tr><td class="prop-key">${escHtml(k)}</td><td class="prop-val" style="${valStyle}">${escHtml(v)}</td></tr>`;
  }
  html += '</table></div>';

  // 端点坐标（已解析）
  html += '<div class="props-section"><div class="props-section-title">端点坐标</div><table class="props-table">';
  html += `<tr><td class="prop-key">起点纬度</td><td class="prop-val">${wire.startLat.toFixed(6)}</td></tr>`;
  html += `<tr><td class="prop-key">起点经度</td><td class="prop-val">${wire.startLng.toFixed(6)}</td></tr>`;
  html += `<tr><td class="prop-key">终点纬度</td><td class="prop-val">${wire.endLat.toFixed(6)}</td></tr>`;
  html += `<tr><td class="prop-key">终点经度</td><td class="prop-val">${wire.endLng.toFixed(6)}</td></tr>`;
  html += '</table></div>';

  // 告警信息（如果有）
  if (info.warnings.length > 0) {
    html += '<div class="props-section"><div class="props-section-title">解析告警</div><table class="props-table">';
    for (const w of info.warnings) {
      html += `<tr><td class="prop-val" colspan="2" style="color:#b45309;font-size:11px">⚠ ${escHtml(w)}</td></tr>`;
    }
    html += '</table></div>';
  }

  // 节点基本信息（路径，便于排障）
  if (node) {
    html += '<div class="props-section"><div class="props-section-title">基本信息</div><table class="props-table">';
    html += `<tr><td class="prop-key">路径</td><td class="prop-val" style="font-family:monospace;font-size:11px;word-break:break-all">${escHtml(node.path)}</td></tr>`;
    if (fileName) html += `<tr><td class="prop-key">文件名</td><td class="prop-val">${escHtml(fileName)}</td></tr>`;
    html += `<tr><td class="prop-key">实体类型</td><td class="prop-val">${escHtml(node.entityName || '—')}</td></tr>`;
    html += `<tr><td class="prop-key">分类名称</td><td class="prop-val">${escHtml(node.classifyName || '—')}</td></tr>`;
    html += '</table></div>';
  }

  // 原始 rawProps（折叠在末尾，便于排障）
  if (node && Object.keys(node.rawProps).length > 0) {
    html += '<div class="props-section"><div class="props-section-title">原始属性 rawProps</div><table class="props-table">';
    for (const [k, v] of Object.entries(node.rawProps)) {
      if (!v) continue;
      html += `<tr><td class="prop-key">${escHtml(k)}</td><td class="prop-val" style="font-family:monospace;font-size:11px;word-break:break-all">${escHtml(v)}</td></tr>`;
    }
    html += '</table></div>';
  }

  propsDrawerBody.innerHTML = html;
}

/**
 * M4-B2：地图点击导线回调：显示导线属性面板。
 *
 * 与 handleMapTowerClick 区别：
 * - 不联动左侧树（导线路径在 WIRE 节点，可能不在已渲染的树中）
 * - 仅显示属性面板
 * - 不报错、不弹模态框
 */
function handleMapWireClick(wire: WireSegment): void {
  showWireProperties(wire);
  propsDrawer.classList.remove('collapsed');
  btnToggleProps.style.right = '332px';
  // 清除左侧树的选中态（避免误导：导线选中 ≠ 树节点选中）
  document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
}

// ---------------------------------------------------------------------------
// 地图视图生命周期管理
// ---------------------------------------------------------------------------

/** 当前地图视图 handle（模块级，避免重复打开 GIM 后残留） */
let lineMapHandle: LineMapViewHandle | null = null;

/** 当前地图数据（供左侧树点击定位地图时反查 TowerMarker nodePath 用） */
let lineMapData: LineMapData | null = null;

/**
 * M4-A1：MapLibre probe handle（实验性，默认关闭）。
 *
 * 仅在 ENABLE_MAPLIBRE_EXPERIMENT=true 时创建，与 Canvas 主地图并存。
 * 不替换 Canvas 主流程，仅验证 MapLibre 能在 Tauri + Vite 中初始化/销毁。
 */
let maplibreProbeHandle: LineMapBaseLayerHandle | null = null;

/**
 * M4-A2：probe 创建代次，用于取消过期的异步 probe 创建。
 *
 * 每次 renderLineProjectPanels / destroyLineMapView 时递增，
 * 异步 probe 完成后检查代次是否匹配，不匹配则销毁新建的 probe。
 */
let maplibreProbeGeneration = 0;

/**
 * M4-A2：MapLibre pointer 事件取消函数列表。
 *
 * overlay 模式下注册的 onPointerMove / onPointerClick / onPointerLeave 回调，
 * 在销毁时统一调用以防止残留。
 */
let maplibreInteractionCleanup: Array<() => void> = [];

/**
 * 销毁当前地图视图。
 *
 * 调用时机（spec 六 清理要求）：
 * - 打开新 GIM 前
 * - 清空场景
 * - 切换到变电工程
 *
 * 幂等：handle 为空时直接返回。
 */
export function destroyLineMapView(): void {
  // M4-A2：递增代次，取消所有在途的 MapLibre probe 创建
  maplibreProbeGeneration++;
  // M4-A2：清理 pointer 事件监听（防止残留）
  for (const fn of maplibreInteractionCleanup) {
    try { fn(); } catch { /* ignore */ }
  }
  maplibreInteractionCleanup = [];
  if (lineMapHandle) {
    lineMapHandle.destroy();
    lineMapHandle = null;
  }
  // M4-A1：同时销毁 MapLibre probe（如果存在）
  if (maplibreProbeHandle) {
    maplibreProbeHandle.destroy();
    maplibreProbeHandle = null;
  }
  lineMapData = null;
  // M4-A2 Finalization：重置底图运行状态（避免下次打开工程时残留旧状态）
  resetBasemapStatus();
}

// ---------------------------------------------------------------------------
// Phase 4：地图→左侧树选中联动
// ---------------------------------------------------------------------------

/**
 * 选中并滚动到指定 nodePath 对应的树行。
 *
 * 仅处理已渲染的节点（懒加载未展开的子节点不强求）。
 * 未找到时静默返回，不抛异常。
 */
function selectTreeRow(path: string): void {
  // CSS.escape 兼容路径中的特殊字符；缺失时回退到双引号字符串选择器
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(path) : path.replace(/"/g, '\\"');
  const row = document.querySelector<HTMLElement>(`.tree-row[data-node-path="${escaped}"]`);
  if (!row) return;
  // 清除旧的 selected
  document.querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
  row.classList.add('selected');
  // 滚动到可见区域（smooth，避免突兀跳动）
  row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Phase 3：左侧树→地图定位联动
// ---------------------------------------------------------------------------

/**
 * 递归收集节点子树中所有"已渲染为塔位"的 nodePath。
 *
 * 判断依据：path 与 lineMapData.towers[].nodeRef.path 相同。
 * 仅收集直接命中，不重复入栈。
 */
function collectDescendantTowerPaths(node: GimGraphNode): string[] {
  if (!lineMapData) return [];
  const towerPathSet = new Set<string>();
  for (const t of lineMapData.towers) {
    if (t.nodeRef && t.nodeRef.path) towerPathSet.add(t.nodeRef.path);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  function walk(n: GimGraphNode): void {
    if (towerPathSet.has(n.path) && !seen.has(n.path)) {
      result.push(n.path);
      seen.add(n.path);
    }
    for (const child of n.children) walk(child);
  }
  walk(node);
  return result;
}

/**
 * 左侧树点击回调：先尝试定位地图，再展示属性面板。
 *
 * Phase 3 规则：
 * 1. 节点本身是塔位 → focusTowerByNodePath
 * 2. 子树含塔位 → focusBboxByNodePaths
 * 3. 找不到坐标 → 只显示属性面板，不报错
 */
function handleTreeNodeClick(node: GimGraphNode): void {
  // 展开属性面板
  showLineNodeProperties(node);
  propsDrawer.classList.remove('collapsed');
  btnToggleProps.style.right = '332px';

  if (!lineMapHandle || !lineMapData) return;

  // 1. 节点本身是塔位 → 单塔定位
  const isTower = lineMapData.towers.some(
    (t) => t.nodeRef && t.nodeRef.path === node.path,
  );
  if (isTower) {
    lineMapHandle.focusTowerByNodePath(node.path);
    return;
  }

  // 2. 子树含塔位 → bbox 定位
  const towerPaths = collectDescendantTowerPaths(node);
  if (towerPaths.length > 0) {
    lineMapHandle.focusBboxByNodePaths(towerPaths);
  }
  // 3. 找不到坐标 → 只显示属性面板
}

/**
 * 地图塔位点击回调：展示属性 + 同步选中左侧树行。
 *
 * Phase 4 规则：
 * 1. 右侧属性面板显示该 TowerMarker 的 nodeRef
 * 2. 左侧层级树中对应节点行加 selected
 * 3. 已渲染节点可滚动到可见区域；未渲染的懒加载节点不强求
 */
function handleMapTowerClick(node: GimGraphNode): void {
  showLineNodeProperties(node);
  propsDrawer.classList.remove('collapsed');
  btnToggleProps.style.right = '332px';
  if (node.path) selectTreeRow(node.path);
}

/**
 * 渲染线路工程面板（统一入口）。
 *
 * - 复用左侧层级树面板显示线路 CBM 树
 * - 文件设备面板显示文件摘要
 * - 主视口渲染线路地图（Canvas 2D）
 * - 点击节点/塔位只展示属性，不创建 ViewerRuntime
 */
export function renderLineProjectPanels(
  state: AppState,
  graph: GimGraph,
  showMessage: (text: string) => void,
): void {
  // 确保 state 与 graph 同步（调用方可能已设置，此处幂等确认）
  state.currentGimGraph = graph;

  // 1. 层级树（左侧树点击走 handleTreeNodeClick：定位地图 + 显示属性）
  cbmTreePanel.innerHTML = '';
  if (!graph.root) {
    cbmTreePanel.innerHTML = '<div class="props-empty">线路工程未找到 CBM 层级树</div>';
  } else {
    renderLineTreeNode(graph.root, cbmTreePanel, handleTreeNodeClick);
  }

  // 2. 文件设备面板摘要
  renderLineFileSummary(graph);

  // 3. 模型面板（清空占位，不显示 IFC 提示）
  renderLineModelPanel();

  // 4. 主视口：渲染线路地图
  //    先销毁旧 handle，避免重复打开 GIM 后 canvas 残留
  destroyLineMapView();
  const attrs = buildLineAttributeIndex(state);
  const mapData = extractLineMapData(graph, attrs);
  // 模块级保存：供左侧树点击 collectDescendantTowerPaths 反查塔位 path
  lineMapData = mapData;

  // M4-B3：在 debug 模式输出悬链线参数审计摘要（仅摘要，不输出全部样本）
  // 仅在 DEBUG_LINE_MAP 开启时执行，避免生产环境性能影响
  debugLog(DEBUG_LINE_MAP, '[M4-B3] catenary param audit summary', buildLineCatenaryAuditSummary(graph, mapData));

  // Phase 5：地图数据统计与未解析引用摘要（追加到文件设备面板）
  renderMapStats(mapData);

  if (isLineMapDataValid(mapData)) {
    // 地图点击塔位走 handleMapTowerClick：显示属性 + 选中左侧树行
    // M4-B2：onWireClick 处理导线点击（命中导线且未命中塔位时触发）
    lineMapHandle = renderLineMap(mapData, container, handleMapTowerClick, {
      onWireClick: handleMapWireClick,
    });
  } else {
    // 塔位坐标缺失：在视口中央显示提示，不抛异常
    const tip = document.createElement('div');
    tip.style.position = 'absolute';
    tip.style.inset = '0';
    tip.style.display = 'flex';
    tip.style.alignItems = 'center';
    tip.style.justifyContent = 'center';
    tip.style.color = '#888';
    tip.style.fontSize = '14px';
    tip.style.pointerEvents = 'none';
    tip.textContent = `未提取到可定位塔位（塔位 ${mapData.stats.towerTotal}，有坐标 ${mapData.stats.towerWithBlha}）`;
    container.appendChild(tip);
    // 临时 handle：destroy 时移除该提示节点
    lineMapHandle = {
      fit() { /* 无地图可 fit */ },
      destroy() {
        if (tip.parentNode === container) container.removeChild(tip);
      },
      focusTowerByNodePath() { return false; },
      focusBboxByNodePaths() { return false; },
    };
  }
  // M4-A2 Finalization：先报告 Canvas-only 状态
  // - 无论 ENABLE_MAPLIBRE_EXPERIMENT 是否开启，主视口已先以 Canvas-only 形式就绪
  // - 后续 MapLibre overlay 成功时状态会被更新为 'osm-online'
  // - OSM 失败回退时状态会被更新为 'osm-unavailable-fallback'
  setBasemapStatus('canvas-only', {
    mode: LINE_BASEMAP_MODE,
    maplibreEnabled: ENABLE_MAPLIBRE_EXPERIMENT,
  });

  // 5. 隐藏空提示（线路工程使用地图视口，不需要 3D 空提示）
  if (emptyTipEl) emptyTipEl.style.display = 'none';

  // 6. 状态提示
  showMessage('线路工程已加载，当前为地图浏览模式');
  debugLog(DEBUG_LINE_MAP, '[GIM] 线路工程面板已渲染:', {
    type: graph.projectType,
    root: graph.root?.path || null,
    totalNodes: graph.stats.total,
    stats: graph.stats,
    map: {
      towers: mapData.stats.towerTotal,
      towersWithCoords: mapData.stats.towerWithBlha,
      wires: mapData.stats.wireTotal,
      crosses: mapData.stats.crossTotal,
      warnings: mapData.warnings.length,
    },
  });

  // 7. M4-A2：MapLibre 底图层 + Canvas overlay
  //    - Canvas-only 已在上方渲染完成，确保地图立即可见
  //    - flag=true 时异步创建 MapLibre probe，成功后切换为 overlay 模式
  //    - overlay 模式恢复完整交互：hover/click/联动（pointer 事件桥接）
  //    - 失败时保持 Canvas-only，不影响主流程
  //    底图模式（LINE_BASEMAP_MODE）：
  //    - 'osm-online'：MVP 默认，加载 OSM 在线 raster 瓦片
  //    - 'pmtiles'  ：走 PMTiles 预研路径（默认关闭，需 ENABLE_PMTILES_EXPERIMENT=true）
  //    - 'empty'    ：不加载瓦片，仅显示纯色背景
  //    - OSM 不可用（3 次 tile error）或初始化失败时，自动回退 Canvas-only
  if (ENABLE_MAPLIBRE_EXPERIMENT && isLineMapDataValid(mapData)) {
    debugLog(DEBUG_LINE_MAP, '[MapLibre overlay] enabled:', ENABLE_MAPLIBRE_EXPERIMENT);
    debugLog(DEBUG_LINE_MAP, '[MapLibre overlay] basemap mode:', LINE_BASEMAP_MODE);
    if (LINE_BASEMAP_MODE === 'osm-online') {
      debugLog(DEBUG_LINE_MAP, '[MapLibre overlay] using OSM online raster tiles');
    }
    // 先销毁旧 probe + 旧 interaction listeners（避免残留）
    if (maplibreProbeHandle) {
      maplibreProbeHandle.destroy();
      maplibreProbeHandle = null;
    }
    for (const fn of maplibreInteractionCleanup) {
      try { fn(); } catch { /* ignore */ }
    }
    maplibreInteractionCleanup = [];
    const myGen = ++maplibreProbeGeneration;
    // M4-A2 第 3 轮 Patch：OSM 不可用时回退 Canvas-only
    //  - 只触发一次（fallbackToCanvasOnlyCalled 守卫）
    //  - 可能在 probe 创建期间（await 中）或之后触发
    //  - 创建期间触发时，IIFE 在 await 返回后检查 flag 并放弃 overlay 切换
    let fallbackToCanvasOnlyCalled = false;
    function fallbackToCanvasOnly(reason: unknown): void {
      if (fallbackToCanvasOnlyCalled) return;
      fallbackToCanvasOnlyCalled = true;

      debugWarn(DEBUG_LINE_MAP, '[MapLibre overlay] OSM unavailable, fallback to Canvas-only', reason);

      // 只在当前 generation 有效时执行（避免过期回调污染新工程）
      if (myGen !== maplibreProbeGeneration) return;

      // 清理 interaction listeners（overlay 模式下注册的 4 个 off*）
      for (const fn of maplibreInteractionCleanup) {
        try { fn(); } catch { /* ignore */ }
      }
      maplibreInteractionCleanup = [];

      // 销毁 overlay canvas handle（如果已切换到 overlay 模式）
      if (lineMapHandle) {
        lineMapHandle.destroy();
        lineMapHandle = null;
      }

      // 销毁 MapLibre probe（如果已创建）
      if (maplibreProbeHandle) {
        maplibreProbeHandle.destroy();
        maplibreProbeHandle = null;
      }

      // 重新渲染 Canvas-only（恢复经纬度网格、比例尺、hover/click/tooltip/树联动）
      // M4-B2：onWireClick 在 fallback 模式下同样生效
      lineMapHandle = renderLineMap(mapData, container, handleMapTowerClick, {
        onWireClick: handleMapWireClick,
      });

      // M4-A2 Finalization：上报回退状态（含可读 reason 供诊断展示）
      // M4-A2 小修：fallback 后 MapLibre probe 已销毁，实际运行模式为 Canvas-only，
      //             因此 maplibreEnabled=false（反映"当前是否仍有 MapLibre 在线"而非"是否曾启用过"）
      setBasemapStatus('osm-unavailable-fallback', {
        mode: LINE_BASEMAP_MODE,
        maplibreEnabled: false,
        fallbackReason: reason instanceof Error ? reason.message : String(reason),
      });

      // UI 状态提示
      try {
        showMessage('OSM 在线底图不可用，已切换为 Canvas 地图模式');
      } catch { /* ignore */ }
    }
    void (async () => {
      try {
        const { createMapLibreProbe } = await import('./lineMapBaseLayer.js');
        // 传入初始 bbox，让 MapLibre 加载后自动 fitBounds（duration:0）
        const initialBounds: [number, number, number, number] = [
          mapData.bbox.minLng, mapData.bbox.minLat, mapData.bbox.maxLng, mapData.bbox.maxLat,
        ];
        const probe = await createMapLibreProbe(container, {
          initialBounds,
          basemapMode: LINE_BASEMAP_MODE,
          pmtiles: {
            enabled: ENABLE_PMTILES_EXPERIMENT,
            url: PMTILES_DEMO_URL,
          },
          onBasemapUnavailable: fallbackToCanvasOnly,
        });
        // 如果在 probe 创建期间已触发回退（3 次 tile error），销毁 probe 并放弃 overlay 切换
        if (fallbackToCanvasOnlyCalled) {
          try { probe.destroy(); } catch { /* ignore */ }
          return;
        }
        // 检查代次：若已过期（用户切换工程/清空场景），销毁并放弃
        if (myGen !== maplibreProbeGeneration) {
          probe.destroy();
          return;
        }
        maplibreProbeHandle = probe;
        const map = probe.getMap();
        if (!map) throw new Error('MapLibre map 实例为 null');
        // 构建 projection：project/unproject 来自 map，fitBounds 委托给 probe
        const baseProjection = createMapLibreProjection(map);
        const projection: LineMapProjection = {
          ...baseProjection,
          fitBounds(bbox: GeoBBox) {
            probe.fitBounds([bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]);
          },
        };
        // 销毁 Canvas-only handle，用 overlay 模式重新渲染
        // （Canvas 透明背景 + pointer-events:none，MapLibre 管理视图 + 交互）
        if (lineMapHandle) {
          lineMapHandle.destroy();
          lineMapHandle = null;
        }
        let redrawFn: (() => void) | null = null;
        lineMapHandle = renderLineMap(mapData, container, handleMapTowerClick, {
          projection,
          onRequestRedraw: (draw: () => void) => { redrawFn = draw; },
          // M4-B2：overlay 模式下也支持导线点击
          onWireClick: handleMapWireClick,
        });
        // MapLibre 视图变化（move/zoom/resize）时触发 Canvas overlay 重绘
        const offView = probe.onViewChange(() => {
          if (redrawFn) redrawFn();
        });
        // M4-A2：pointer 事件桥接（MapLibre → Canvas overlay）
        // Canvas pointer-events:none，MapLibre 接收鼠标事件并转发给 Canvas handle
        const offMove = probe.onPointerMove((p) => {
          lineMapHandle?.handlePointerMove?.(p.x, p.y);
        });
        const offClick = probe.onPointerClick((p) => {
          lineMapHandle?.handlePointerClick?.(p.x, p.y);
        });
        const offLeave = probe.onPointerLeave(() => {
          lineMapHandle?.handlePointerLeave?.();
        });
        maplibreInteractionCleanup.push(offView, offMove, offClick, offLeave);
        // M4-A2 Finalization：MapLibre overlay 初始化成功，按当前底图模式上报状态
        setBasemapStatus(basemapStatusFromMode(LINE_BASEMAP_MODE), {
          mode: LINE_BASEMAP_MODE,
          maplibreEnabled: true,
        });
        debugLog(DEBUG_LINE_MAP, '[MapLibre overlay] M4-A2：底图 + Canvas overlay + 交互桥接 初始化成功');
      } catch (err) {
        debugWarn(DEBUG_LINE_MAP, '[MapLibre overlay] M4-A2：初始化失败，保持 Canvas-only', err);
        // M4-A2 Finalization：初始化失败时状态保持为 Canvas-only（已在外层渲染时设置）
        // 此处不显式 setBasemapStatus，避免覆盖外层的 'canvas-only' 状态
      }
    })();
  }
}
