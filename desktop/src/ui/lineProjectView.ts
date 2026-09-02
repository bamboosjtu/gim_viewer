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
import { hideTabs } from './tabs.js';
import type { LineMapRenderPhase, LineMapViewHandle } from './lineMapView.js';
import type { LineMapBaseLayerHandle } from './lineMapBaseLayer.js';
import type { LineMapProjection, GeoBBox } from './lineMapProjection.js';
import { createMapLibreProjection } from './lineMapProjection.js';
import { renderLineMap } from './lineMapView.js';
import { extractLineMapData, isLineMapDataValid } from '../gim/lineMapData.js';
import { buildLineAttributeIndex } from '../services/lineAttrRestoreService.js';
import { buildWireSemanticInfo } from '../services/lineWireSemanticService.js';
import type { WireSemanticInfo } from '../services/lineWireSemanticService.js';
import { buildLineCatenaryAuditExportPayload } from '../services/lineCatenaryAuditExportService.js';
import type { LineCatenaryAuditExportPayload } from '../services/lineCatenaryAuditExportService.js';
import { formatLineCatenaryAuditMarkdown } from '../services/lineCatenaryAuditExportService.js';
import { DEBUG_LINE_MAP } from '../config/debug.js';
import { ENABLE_CATENARY, ENABLE_MAPLIBRE_EXPERIMENT, ENABLE_PMTILES_EXPERIMENT, PMTILES_DEMO_URL, runtimeBasemapMode, setRuntimeBasemapMode, resetRuntimeBasemapMode } from '../config/features.js';
import type { LineBasemapMode } from '../config/features.js';
import { isTiandituKeyAvailable } from '../config/tianditu.js';
import { setBasemapStatus, resetBasemapStatus } from '../services/basemapStatusService.js';
import type { BasemapStatus } from '../services/basemapStatusService.js';
import { debugLog, debugWarn } from '../utils/logger.js';
import { renderSearchBox } from './searchBox.js';
import { setStatusRight } from './shell/statusBar.js';
import { getFileNameLower, normalizeGimPath } from '../gim/linePathNormalize.js';
import {
  buildLineNavigationIndex,
  buildLineNavigationSearchIndex,
  renderLineNavigationTree,
  resolveLineNavigationTarget,
  revealLineNavigationTarget,
} from './lineNavigationTreeView.js';
import type { LineNavigationIndex, LineNavigationNode } from './lineNavigationTreeView.js';
import {
  fileReferenceValue,
  getPropertyDefinition,
  getPropertyReferenceKind,
  renderPropertySection,
  renderTechnicalSection,
  type FileReferenceValue,
  type PropertyComponent,
  type PropertyDefinition,
  type PropertyReferenceDetail,
  type PropertyRow,
} from './propertyDictionary.js';
import { renderInspectorTabs } from './propsDrawer.js';
import {
  loadLineModSourcesForNode,
  type LineModRuntimeEntry,
} from '../services/lineModRuntimeService.js';
import type {
  BoltModFile,
  HNumModFile,
  KeyValueModFile,
  PointLineModFile,
  RRecord,
  LineTextModGeometrySource,
  TowerDeviceModFile,
  UnknownKvModFile,
  WireModFile,
} from '../gim/geometry/ir.js';
import type { LineAttributeIndex } from '../gim/lineAttributeTypes.js';
import type { LineFamPropertyRecord, LineDevPropertyRecord } from '@desktop/database.js';
import { perfBegin, perfCurrentSession, type PerfSession } from '../utils/perfTimings.js';

/**
 * 把 LineBasemapMode 映射为成功后的 BasemapStatus。
 *
 * 用于在 MapLibre overlay 初始化成功后上报状态。
 */
function basemapStatusFromMode(mode: LineBasemapMode): BasemapStatus {
  switch (mode) {
    case 'osm-online': return 'osm-online';
    case 'pmtiles': return 'pmtiles';
    case 'tianditu-satellite': return 'tianditu-satellite';
    case 'tianditu-terrain': return 'tianditu-terrain';
    case 'tianditu-vector': return 'tianditu-vector';
    default: return 'empty';
  }
}

/** 节点显示名称：classifyName 优先，回退 entityName，再回退文件名 */
function nodeDisplayName(node: GimGraphNode): string {
  const fn = node.path.split('/').pop() || node.path;
  return node.classifyName || node.entityName || fn.replace(/\.(cbm|dev|fam)$/i, '');
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

function lineComponentForNode(node: GimGraphNode): PropertyComponent {
  switch (node.entityName.toUpperCase()) {
    case 'WIRE': return 'line-wire';
    case 'CROSS': return 'line-point-line';
    case 'TOWER_DEVICE': return 'line-tower-device';
    case 'WIRE_DEVICE': return 'line-wire-params';
    default: return 'line-node';
  }
}

/** 判断线路业务树中的杆塔节点（F4System/TOWER 及其设备别名）。 */
function isLineTowerNode(node: GimGraphNode): boolean {
  const entity = node.entityName.trim().toUpperCase();
  const classify = node.classifyName.trim().toUpperCase();
  const groupType = (node.rawProps['GROUPTYPE'] || '').trim().toUpperCase();
  return groupType === 'TOWER'
    || classify === 'TOWER'
    || entity === 'TOWER'
    || entity === 'TOWER_DEVICE';
}

/** 键值对 → 字典渲染的属性分节；来源值可由 fileReferenceValue 提供按钮。 */
function sectionHtml(
  title: string,
  pairs: Array<[string, string | FileReferenceValue]>,
  monoValue = false,
  component: PropertyComponent = 'line-node',
): string {
  const rows: PropertyRow[] = pairs
    .filter(([, value]) => typeof value === 'string' ? Boolean(value) : Boolean(value?.text))
    .map(([key, value]) => typeof value === 'string'
      ? { key, value, mono: monoValue }
      : { key, value: value.text, valueHtml: value.html, valueText: value.text, mono: monoValue });
  // 关系/来源字段本身可能不是工程字典键（如“DEV 1”“来源文件”），
  // 不能按未知键的 P2 默认级别过滤，否则可读来源按钮会整段消失。
  return renderPropertySection(title, component, rows);
}

function rawRows(
  component: PropertyComponent,
  raw: Record<string, string>,
  excluded: Set<string> = new Set(),
  options: { excludeReferences?: boolean } = {},
): { primary: PropertyRow[]; technical: PropertyRow[] } {
  const rows = Object.entries(raw)
    .filter(([key, value]) => Boolean(value)
      && !excluded.has(key)
      && !(options.excludeReferences && Boolean(getPropertyReferenceKind(component, key, value))))
    .map(([key, value]) => ({
      key,
      value,
      mono: key.includes('MATRIX') || key.includes('BLHA'),
    }));
  return {
    primary: rows.filter((row) => (getPropertyDefinition(component, row.key)?.priority ?? 2) < 2),
    technical: rows.filter((row) => (getPropertyDefinition(component, row.key)?.priority ?? 2) >= 2),
  };
}

function renderLineRawProperties(node: GimGraphNode, component = lineComponentForNode(node)): string {
  const excluded = new Set(['ENTITYNAME', 'GROUPTYPE', 'WIRETYPE', 'DEVICETYPE', 'SYSCLASSIFYNAME', 'PARTNAME']);
  const { primary, technical } = rawRows(component, node.rawProps, excluded, { excludeReferences: true });
  return renderPropertySection('工程字段', component, primary, { includeTechnical: false, allowReferences: false })
    + renderTechnicalSection('技术字段', component, technical, { allowReferences: false });
}

function sourceRecordsForRef<T extends { source_path: string; normalized_path: string; file_name_lower: string }>(
  refs: string[],
  bySource: Map<string, Map<string, T[]>>,
  byFile: Map<string, Map<string, T[]>>,
): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  const add = (records: T[] | undefined): void => {
    for (const rec of records ?? []) {
      const key = `${rec.source_path}|${rec.normalized_path}|${rec.file_name_lower}|${(rec as unknown as { sort_order?: number }).sort_order ?? ''}|${(rec as unknown as { prop_key?: string }).prop_key ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(rec);
    }
  };
  // Enumerate every property bucket for a matched source so no FAM/DEV key is lost.
  const enumerate = (map: Map<string, Map<string, T[]>>, key: string): void => {
    const bucket = map.get(key);
    if (!bucket) return;
    for (const records of bucket.values()) add(records);
  };
  for (const ref of refs) {
    enumerate(bySource, normalizeGimPath(ref));
    enumerate(byFile, getFileNameLower(ref));
  }
  return result.sort((a, b) => a.source_path.localeCompare(b.source_path));
}

function definitionWithDisplayLabel(
  component: PropertyComponent,
  key: string,
  label?: string | null,
): PropertyDefinition {
  const base = getPropertyDefinition(component, key);
  if (base && !label) return base;
  return {
    key,
    label: label || base?.label || key,
    description: base?.description || '来源文件属性；具体工程含义待规范确认',
    group: base?.group || '属性',
    priority: base?.priority ?? (label ? 1 : 2),
    dataType: base?.dataType || 'text',
    unit: base?.unit,
  };
}

interface LineAttributeScope {
  label: string;
  famRefs: string[];
  devRefs: string[];
}

/** 从 F4System 的业务键找到对应子节点；不把文件名泄漏到 UI。 */
function childForReference(node: GimGraphNode, reference: string): GimGraphNode | undefined {
  return node.children.find((child) => pathMatchesReference(child.path, reference));
}

function indexedRawReferences(node: GimGraphNode, pattern: RegExp): Array<{ index: number; value: string }> {
  return Object.entries(node.rawProps)
    .map(([key, value]) => {
      const match = key.match(pattern);
      return match && value ? { index: Number(match[1]), value } : null;
    })
    .filter((item): item is { index: number; value: string } => Boolean(item))
    .sort((a, b) => a.index - b.index);
}

/**
 * 属性参数按“关联对象”分组：塔位 F4 下只展开塔身、基础和导线串的
 * FAM/DEV；不会把同一 F4 下数十个来源文件各自生成一整块“查看引用”。
 */
function lineAttributeScopes(node: GimGraphNode): LineAttributeScope[] {
  const scopes: LineAttributeScope[] = [{
    label: '当前对象',
    famRefs: node.refs.famFiles,
    devRefs: node.refs.devFiles,
  }];
  const entity = node.entityName.trim().toUpperCase();
  const groupType = (node.rawProps['GROUPTYPE'] || '').trim().toUpperCase();
  if (entity !== 'F4SYSTEM' || groupType !== 'TOWER') return scopes;

  const addScope = (label: string, child: GimGraphNode | undefined): void => {
    if (!child) return;
    scopes.push({
      label,
      famRefs: child.refs.famFiles,
      devRefs: child.refs.devFiles,
    });
  };
  for (const { index, value } of indexedRawReferences(node, /^TOWER(\d+)$/i)) {
    addScope(`杆塔实例 ${index + 1}`, childForReference(node, value));
  }
  for (const { index, value } of indexedRawReferences(node, /^BASE(\d+)$/i)) {
    addScope(`基础 ${index + 1}`, childForReference(node, value));
  }
  for (const { index, value } of indexedRawReferences(node, /^STRING(\d+)\.STRING$/i)) {
    addScope(`导线串 ${index + 1}`, childForReference(node, value));
  }
  return scopes;
}

function renderAttributeBucket(
  title: string,
  component: PropertyComponent,
  records: Array<LineFamPropertyRecord | LineDevPropertyRecord>,
): string {
  const seen = new Set<string>();
  const primaryByGroup = new Map<string, PropertyRow[]>();
  const technicalByGroup = new Map<string, PropertyRow[]>();
  for (const record of records) {
    if (record.prop_value === null || record.prop_value === '') continue;
    // 属性值偶尔也会携带 BASEFAMILY/SOLIDMODEL 等引用键；引用统一放到来源页。
    if (getPropertyReferenceKind(component, record.prop_key, record.prop_value)) continue;
    const dedupeKey = `${record.source_path}|${record.prop_key}|${record.prop_value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const definition = definitionWithDisplayLabel(
      component,
      record.prop_key,
      'display_key' in record ? record.display_key : undefined,
    );
    const row: PropertyRow = {
      key: record.prop_key,
      value: record.prop_value,
      definition,
    };
    const target = definition.priority >= 2 ? technicalByGroup : primaryByGroup;
    const group = definition.group || '属性';
    const list = target.get(group);
    if (list) list.push(row);
    else target.set(group, [row]);
  }

  let html = '';
  for (const [group, rows] of primaryByGroup) {
    html += renderPropertySection(`${title} · ${group}`, component, rows, {
      includeTechnical: false,
      allowReferences: false,
    });
  }
  for (const [group, rows] of technicalByGroup) {
    html += renderTechnicalSection(`${title} · ${group}`, component, rows, { allowReferences: false });
  }
  return html;
}

function renderLineAttributeRecords(
  node: GimGraphNode,
  attrs: LineAttributeIndex | undefined,
): string {
  if (!attrs) return '';
  let html = '';
  for (const scope of lineAttributeScopes(node)) {
    const fam = sourceRecordsForRef<LineFamPropertyRecord>(scope.famRefs, attrs.famBySourcePath, attrs.famByFileNameLower);
    const dev = sourceRecordsForRef<LineDevPropertyRecord>(scope.devRefs, attrs.devBySourcePath, attrs.devByFileNameLower);
    html += renderAttributeBucket(`${scope.label} · 属性族`, 'line-node', fam);
    html += renderAttributeBucket(`${scope.label} · 设备`, 'line-node', dev);
  }
  return html;
}

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/**
 * 为 SVG 点标记做按高度分层的自适应抽样。
 *
 * 杆塔 MOD 的 P 记录通常是按构件输出的，文件前缀并不等于塔脚到塔顶。
 * 因此不能再使用 points.slice(0, N)。先按 Z 高度分桶，再在每个桶内均匀
 * 取样，并显式保留最低/中部/最高点，保证预览覆盖完整高度层级。
 */
function sampleTowerPointsByHeight(points: HNumModFile['bodySections'][number]['points'], maxMarkers: number): typeof points {
  const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
  if (valid.length <= maxMarkers) return valid;

  const sorted = valid.slice().sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y || a.id - b.id);
  const target = Math.max(3, Math.min(maxMarkers, sorted.length));
  const minZ = sorted[0].z;
  const maxZ = sorted[sorted.length - 1].z;
  const range = Math.max(maxZ - minZ, 1);
  const bucketCount = Math.max(3, Math.min(target, Math.ceil(Math.sqrt(sorted.length))));
  const buckets: typeof sorted[] = Array.from({ length: bucketCount }, () => []);
  for (const point of sorted) {
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor(((point.z - minZ) / range) * bucketCount)));
    buckets[index].push(point);
  }

  const result: typeof points = [];
  const seen = new Set<string>();
  const add = (point: (typeof sorted)[number]): void => {
    // ID 在异常导出器中可能跨 Body 重复，坐标也参与 key，避免错误去重。
    const key = `${point.id}|${point.x}|${point.y}|${point.z}`;
    if (seen.has(key) || result.length >= target) return;
    seen.add(key);
    result.push(point);
  };

  // 三个锚点是硬约束：塔脚、塔身中部、塔顶必须有可见点标记。
  add(sorted[0]);
  add(sorted[Math.floor((sorted.length - 1) / 2)]);
  add(sorted[sorted.length - 1]);

  // 每个高度桶至少取一个；余量在桶内均匀分配，避免只看到某一段。
  const perBucket = Math.max(1, Math.floor((target - result.length) / bucketCount));
  for (const bucket of buckets) {
    if (bucket.length === 0) continue;
    const count = Math.min(bucket.length, perBucket);
    for (let i = 0; i < count; i += 1) {
      add(bucket[Math.round((i * (bucket.length - 1)) / Math.max(count - 1, 1))]);
    }
  }

  // 由于桶内点数可能很少，继续用全高度等距索引填满剩余额度。
  for (let i = 0; result.length < target && i < target * 2; i += 1) {
    add(sorted[Math.round((i * (sorted.length - 1)) / Math.max(target * 2 - 1, 1))]);
  }
  return result;
}

function renderHNumPreview(source: HNumModFile): string {
  const points = source.bodySections.flatMap((body) => body.points);
  if (points.length === 0) return '<div class="props-note">MOD 未提供 P 节点，无法生成骨架预览。</div>';
  const width = 280;
  // 使用正方形视口，并对 X/Z 使用同一缩放因子；此前分别拉伸 X、Z
  // 造成塔身比例失真，尤其是窄高塔型难以阅读。
  const height = 280;
  const pad = 14;
  const xs = points.map((point) => point.x);
  const zs = points.map((point) => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const sx = Math.max(maxX - minX, 1);
  const sz = Math.max(maxZ - minZ, 1);
  const scale = Math.min((width - pad * 2) / sx, (height - pad * 2) / sz);
  const offsetX = (width - sx * scale) / 2;
  const offsetY = (height - sz * scale) / 2;
  const pointMap = new Map<number, [number, number]>();
  // pointMap 必须建立在全量 P 上；否则后半段 R 的端点无法连接，表现为塔身
  // 被“截断”。点标记本身采用按高度抽样，杆件则使用一个 SVG path 全量绘制。
  for (const point of points) {
    const x = offsetX + (point.x - minX) * scale;
    const y = height - offsetY - (point.z - minZ) * scale;
    pointMap.set(point.id, [x, y]);
  }
  const sampledPoints = sampleTowerPointsByHeight(points, 1800);
  const pointPath = sampledPoints.map((point) => {
    const projected = pointMap.get(point.id);
    if (!projected) return '';
    const [x, y] = projected;
    // 小十字比 1800 个 circle 节点更轻量，同时在缩放后仍可辨认。
    return `M${formatNumber(x - 0.7, 1)} ${formatNumber(y, 1)}h1.4M${formatNumber(x, 1)} ${formatNumber(y - 0.7, 1)}v1.4`;
  }).join('');
  const rodPathParts: string[] = [];
  let drawnRodCount = 0;
  let skippedRodCount = 0;
  let unknownRodCount = 0;
  let unknownDrawnRodCount = 0;
  for (const rod of source.bodySections.flatMap((body) => body.rods) as RRecord[]) {
    if (rod.kind === 'unknown') unknownRodCount += 1;
    const id1 = 'id1' in rod ? rod.id1 : undefined;
    const id2 = 'id2' in rod ? rod.id2 : undefined;
    if (id1 == null || id2 == null) {
      skippedRodCount += 1;
      continue;
    }
    const a = pointMap.get(id1);
    const b = pointMap.get(id2);
    if (!a || !b) {
      skippedRodCount += 1;
      continue;
    }
    rodPathParts.push(`M${formatNumber(a[0], 1)} ${formatNumber(a[1], 1)}L${formatNumber(b[0], 1)} ${formatNumber(b[1], 1)}`);
    drawnRodCount += 1;
    if (rod.kind === 'unknown') unknownDrawnRodCount += 1;
  }
  const rodPath = rodPathParts.join('');
  const skippedNote = skippedRodCount > 0 ? `，${skippedRodCount} 根杆件因端点/变体异常未绘制` : '';
  const unknownNote = unknownRodCount > 0 ? `，未知变体 ${unknownDrawnRodCount}/${unknownRodCount} 已按端点绘制` : '';
  return `<div class="line-mod-preview" aria-label="杆塔形状（局部骨架预览）"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img"><g class="line-mod-rods"><path d="${rodPath}" vector-effect="non-scaling-stroke" /></g><g class="line-mod-points"><path d="${pointPath}" vector-effect="non-scaling-stroke" /></g></svg><span>局部骨架预览 · X/Z 投影（等比例，单位：mm） · P ${points.length}（点标记 ${sampledPoints.length}） · R ${drawnRodCount}${unknownNote}${skippedNote}</span></div>`;
}

interface LineModRenderOptions {
  /** 参数页不显示来源按钮；来源页统一渲染所有文件入口。 */
  includeSourceLink?: boolean;
}

function appendLineModSource(html: string, entry: LineModRuntimeEntry, options: LineModRenderOptions): string {
  return options.includeSourceLink === false
    ? html
    : html + sectionHtml('来源', [['MOD 文件', fileReferenceValue('mod', entry.path, '查看 MOD')]]);
}

export function renderLineModSource(entry: LineModRuntimeEntry, options: LineModRenderOptions = {}): string {
  if (!entry.source) {
    return appendLineModSource(
      `<div class="props-section"><div class="props-section-title">线路 MOD</div><div class="props-note warning">${escHtml(entry.error || 'MOD 解析失败')}</div></div>`,
      entry,
      options,
    );
  }
  const source: LineTextModGeometrySource = entry.source;
  const records = source.records;
  if ('hNum' in records) {
    const hnum = records as HNumModFile;
    const rows: PropertyRow[] = [
      { key: 'hNum', value: hnum.hNum },
      { key: 'hRecords', value: hnum.hRecords.length },
      { key: 'bodySections', value: hnum.bodySections.length },
      { key: 'points', value: hnum.bodySections.reduce((sum, body) => sum + body.points.length, 0) },
      { key: 'rods', value: hnum.bodySections.reduce((sum, body) => sum + body.rods.length, 0) },
      { key: 'groundPoints', value: hnum.bodySections.reduce((sum, body) => sum + body.groundPoints.length, 0) },
      { key: 'hSubLegs', value: hnum.hSubLegs.length },
      { key: 'hLegs', value: hnum.hLegs.length },
    ];
    return appendLineModSource(renderPropertySection('杆塔骨架', 'line-hnum', rows, { allowReferences: false }), entry, options);
  }
  if ('boltNum' in records) {
    const bolt = records as BoltModFile;
    let html = renderPropertySection(
      '连接件摘要',
      'line-bolt',
      [{ key: 'boltNum', value: bolt.boltNum }, { key: 'count', value: bolt.bolts.length }],
      { allowReferences: false },
    );
    const visibleBolts = bolt.bolts.slice(0, 64);
    if (visibleBolts.length > 0) {
      const rows = visibleBolts.map((item) => `<tr><td class="prop-key">${item.index}</td><td>${escHtml(item.spec || '—')}</td><td>${escHtml(formatNumber(item.length))} mm</td><td>${escHtml(item.restFields[0] || '—')}</td><td>${escHtml(String(item.position.code))}</td><td>${escHtml(formatNumber(item.position.x))} mm</td><td>${escHtml(formatNumber(item.position.y))} mm</td><td>${escHtml(formatNumber(item.position.z))} mm</td></tr>`).join('');
      html += `<div class="props-section"><div class="props-section-title">螺栓明细（表格）</div><table class="props-table props-bolt-table"><thead><tr><th>序号</th><th>规格</th><th>长度</th><th>材质/等级</th><th>方位码</th><th>X</th><th>Y</th><th>Z</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    const extraRows: PropertyRow[] = visibleBolts.flatMap((item) => item.restFields.slice(1).map((value, index) => ({
      key: `螺栓 ${item.index} · 字段 ${index + 2}`,
      value,
    })));
    if (extraRows.length > 0) html += renderTechnicalSection('螺栓 · 未确认字段', 'line-bolt', extraRows, { allowReferences: false });
    if (bolt.bolts.length > 64) html += '<div class="props-note">螺栓记录较多，仅显示前 64 条；完整来源仍可通过“查看 MOD”打开。</div>';
    return appendLineModSource(html, entry, options);
  }
  if ('pointNum' in records) {
    const pointLine = records as PointLineModFile;
    let html = renderPropertySection('跨越物点线摘要', 'line-point-line', [
      { key: 'code', value: pointLine.code },
      { key: 'pointNum', value: pointLine.pointNum },
      { key: 'lineNum', value: pointLine.lineNum },
    ]);
    const pointSections = pointLine.points.slice(0, 64).map((point) => renderPropertySection(
      `跨越点 ${point.id}`,
      'line-point-line',
      [
        { key: 'id', value: point.id },
        {
          key: 'BLHA',
          value: [formatNumber(point.lat, 8), formatNumber(point.lon, 8), formatNumber(point.alt, 3), '—'].join(','),
          definition: {
            key: 'BLHA', label: '坐标', description: '跨越点纬度、经度、高程', group: '跨越点',
            priority: 0, dataType: 'coordinate',
          },
        },
        { key: 'type', value: point.type },
      ],
    )).join('');
    if (pointSections) html += `<div class="props-note">跨越点（前 ${Math.min(pointLine.points.length, 64)} 个）</div>${pointSections}`;
    const lineRows = pointLine.lines.slice(0, 64).map((line, index) => `<tr><td class="prop-key">LINE${index + 1}</td><td class="prop-val">${line.fromId} → ${line.toId}</td></tr>`).join('');
    if (lineRows) html += `<div class="props-section"><div class="props-section-title">跨越边（前 ${Math.min(pointLine.lines.length, 64)} 条）</div><table class="props-table">${lineRows}</table></div>`;
    return appendLineModSource(html, entry, options);
  }
  const kv = records as KeyValueModFile;
  if ('signature' in kv && kv.signature === 'unknown') {
    const unknown = kv as UnknownKvModFile;
    const rows = Object.entries(unknown.raw).map(([key, value]) => ({ key, value }));
    return appendLineModSource(
      renderTechnicalSection('未识别 MOD 字段', 'line-node', rows, { allowReferences: false })
        + '<div class="props-note warning">此 MOD 的键集合尚未纳入属性字典，已保留原值，未推断工程含义。</div>',
      entry,
      options,
    );
  }
  if ('TYPE' in kv) {
    const wire = kv as WireModFile;
    const rows: PropertyRow[] = Object.entries(wire)
      .filter(([key]) => key !== 'signature')
      .map(([key, value]) => ({ key, value: value as string }));
    return appendLineModSource(
      renderPropertySection('导线参数', 'line-wire-params', rows, { includeTechnical: false, allowReferences: false })
        + renderTechnicalSection('导线技术字段', 'line-wire-params', rows, { allowReferences: false }),
      entry,
      options,
    );
  }
  if ('type' in kv) {
    const tower = kv as TowerDeviceModFile;
    const rows: PropertyRow[] = Object.entries(tower)
      .filter(([key]) => key !== 'signature')
      .map(([key, value]) => ({ key, value: value as string }));
    return appendLineModSource(
      renderPropertySection('塔基参数', 'line-tower-device', rows, { includeTechnical: false, allowReferences: false })
        + renderTechnicalSection('塔基技术字段', 'line-tower-device', rows, { allowReferences: false }),
      entry,
      options,
    );
  }
  return appendLineModSource('', entry, options);
}

function renderLineModSources(entries: LineModRuntimeEntry[], options: LineModRenderOptions = {}): string {
  if (entries.length === 0) return '<div class="props-note">当前节点没有可解析的线路 MOD 引用。</div>';
  return entries.slice(0, 32).map((entry) => renderLineModSource(entry, options)).join('')
    + (entries.length > 32 ? '<div class="props-note">MOD 来源较多，仅展示前 32 个；请通过来源按钮逐个打开原文件。</div>' : '');
}

/**
 * 将杆塔 HNum 来源渲染到“来源”页签。
 *
 * 杆塔形状是来源文件中的可视证据，不应和业务参数混在一起；这里只
 * 显示轻量 X/Z 投影，并保留可读的 MOD 来源按钮。首次点击塔位时来源
 * 尚在异步读取，先显示等待提示，读取完成后由检查器增量刷新。
 */
export function renderLineTowerShapeSource(
  node: GimGraphNode,
  entries: LineModRuntimeEntry[],
  options: LineModRenderOptions = {},
): string {
  if (!isLineTowerNode(node)) return '';
  const hnumEntries = entries.filter((entry) => entry.source && 'hNum' in entry.source.records);
  if (hnumEntries.length === 0) {
    const note = entries.length === 0
      ? '正在读取塔型来源…'
      : '当前塔位未找到可预览的 HNum 杆塔形状。';
    return `<div class="props-section"><div class="props-section-title">杆塔形状</div><div class="props-note">${note}</div></div>`;
  }

  let html = '';
  for (const [index, entry] of hnumEntries.slice(0, 3).entries()) {
    const source = entry.source!;
    if (!('hNum' in source.records)) continue;
    const title = index === 0 ? '杆塔形状（局部骨架预览）' : `杆塔形状 ${index + 1}（局部骨架预览）`;
    html += `<div class="props-section"><div class="props-section-title">${title}</div>`
      + renderHNumPreview(source.records as HNumModFile)
      + (options.includeSourceLink === false
        ? ''
        : sectionHtml('形状来源', [['HNum MOD', fileReferenceValue('mod', entry.path, '查看塔型 MOD')]]))
      + '</div>';
  }
  if (hnumEntries.length > 3) {
    html += `<div class="props-note">检测到 ${hnumEntries.length} 个塔型来源，仅预览前 3 个。</div>`;
  }
  return html;
}

type LineSourceKind = Parameters<typeof fileReferenceValue>[0];

interface LineSourceEntry {
  kind: LineSourceKind;
  path: string;
  context: string;
}

const LINE_SOURCE_KINDS: Array<{ kind: LineSourceKind; label: string }> = [
  { kind: 'cbm', label: 'CBM' },
  { kind: 'dev', label: 'DEV' },
  { kind: 'fam', label: 'FAM' },
  { kind: 'phm', label: 'PHM' },
  { kind: 'mod', label: 'MOD' },
  { kind: 'stl', label: 'STL' },
  { kind: 'file', label: 'WIRE' },
  { kind: 'ifc', label: 'IFC' },
];

/** 来源页按类型折叠，并限制每类首批预览，避免工程节点生成超长 DOM。 */
const SOURCE_PREVIEW_LIMIT_PER_KIND = 120;

function lineSourceContext(node: GimGraphNode, fallback = '当前对象'): string {
  const entity = node.entityName.trim().toUpperCase();
  const groupType = (node.rawProps['GROUPTYPE'] || '').trim().toUpperCase();
  if (entity === 'F4SYSTEM' && groupType === 'TOWER') return '杆塔';
  if (entity === 'F4SYSTEM' && groupType === 'WIRE') return '导线';
  if (entity === 'WIRE') return '导线';
  if (entity === 'CROSS') return '跨越物';
  const name = node.classifyName.trim() || node.name.trim();
  return name && !/^(?:F[1-4]SYSTEM|TOWER_DEVICE|WIRE_DEVICE)$/i.test(name) ? name : fallback;
}

function childSourceContext(parent: GimGraphNode, child: GimGraphNode, inherited: string): string {
  const tower = indexedRawReferences(parent, /^TOWER(\d+)$/i).find(({ value }) => pathMatchesReference(child.path, value));
  if (tower) return `杆塔实例 ${tower.index + 1}`;
  const base = indexedRawReferences(parent, /^BASE(\d+)$/i).find(({ value }) => pathMatchesReference(child.path, value));
  if (base) return `基础 ${base.index + 1}`;
  const string = indexedRawReferences(parent, /^STRING(\d+)\.STRING$/i).find(({ value }) => pathMatchesReference(child.path, value));
  if (string) return `导线串 ${string.index + 1}`;
  return inherited;
}

/** 收集当前业务节点及其子树的全部来源，供“来源”页签集中展示。 */
function collectLineSourceEntries(node: GimGraphNode, modEntries: LineModRuntimeEntry[] = []): LineSourceEntry[] {
  const entries: LineSourceEntry[] = [];
  const seen = new Set<string>();
  const add = (kind: LineSourceKind, path: string, context: string): void => {
    if (!path) return;
    const normalized = normalizeGimPath(path);
    const key = `${kind}|${normalized.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, path: normalized || path, context });
  };
  const walk = (current: GimGraphNode, inheritedContext: string): void => {
    const context = lineSourceContext(current, inheritedContext);
    add('cbm', current.path, context);
    for (const path of current.refs.cbmFiles) {
      const child = current.children.find((candidate) => pathMatchesReference(candidate.path, path));
      add('cbm', path, child ? childSourceContext(current, child, context) : context);
    }
    for (const path of current.refs.devFiles) add('dev', path, context);
    for (const path of current.refs.famFiles) add('fam', path, context);
    for (const path of current.refs.phmFiles) add('phm', path, context);
    for (const path of current.refs.modFiles) add('mod', path, context);
    for (const path of current.refs.stlFiles) add('stl', path, context);
    for (const path of current.refs.wireFiles) add('file', path, context);
    for (const path of current.refs.ifcFiles) add('ifc', path, context);
    for (const child of current.children) walk(child, childSourceContext(current, child, context));
  };
  walk(node, '当前对象');
  for (const entry of modEntries) add('mod', entry.path, '几何来源');
  return entries.sort((a, b) => {
    const ai = LINE_SOURCE_KINDS.findIndex((item) => item.kind === a.kind);
    const bi = LINE_SOURCE_KINDS.findIndex((item) => item.kind === b.kind);
    return ai - bi || a.context.localeCompare(b.context) || a.path.localeCompare(b.path);
  });
}

/** 文件引用只在来源页签显示，正文使用关联对象名称而非 GUID 文件名。 */
function renderLineSourceRefs(node: GimGraphNode, modEntries: LineModRuntimeEntry[] = []): string {
  const entries = collectLineSourceEntries(node, modEntries);
  if (entries.length === 0) return '';
  const labels: Record<LineSourceKind, string> = {
    cbm: '定位 CBM',
    dev: '查看 DEV',
    fam: '查看属性族',
    phm: '查看 PHM',
    mod: '查看 MOD',
    stl: '查看 STL',
    file: '查看源文件',
    ifc: '切换 IFC',
    sld: '打开电气图纸',
  };
  const groups = new Map<LineSourceKind, LineSourceEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.kind);
    if (group) group.push(entry);
    else groups.set(entry.kind, [entry]);
  }

  let html = `<div class="props-section"><div class="props-section-title">文件来源</div><div class="props-note">共 ${entries.length} 个来源，按类型折叠显示。</div></div>`;
  for (const { kind, label } of LINE_SOURCE_KINDS) {
    const group = groups.get(kind);
    if (!group || group.length === 0) continue;
    const visible = group.slice(0, SOURCE_PREVIEW_LIMIT_PER_KIND);
    const rows: PropertyRow[] = visible.map((entry, index) => {
      const reference = fileReferenceValue(kind, entry.path, labels[kind]);
      const context = entry.context || '当前对象';
      return {
        key: `source-${kind}-${index}`,
        value: reference.text,
        valueHtml: reference.html,
        valueText: reference.text,
        definition: definitionWithDisplayLabel('line-node', `source-${kind}-${index}`, context),
      };
    });
    html += renderPropertySection(`${label}（${group.length}）`, 'line-node', rows, {
      details: true,
      includeTechnical: true,
    });
    if (group.length > visible.length) {
      html += `<div class="props-note">${escHtml(label)} 其余 ${group.length - visible.length} 个来源未在此处展开，请选择更具体的业务对象继续查看。</div>`;
    }
  }
  return html;
}

function relationSection(title: string, pairs: Array<[string, string]>): string {
  const rows: PropertyRow[] = pairs
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => ({
      key,
      value,
      definition: definitionWithDisplayLabel('line-node', key, key),
    }));
  return renderPropertySection(title, 'line-node', rows, { includeTechnical: false, allowReferences: false });
}

function relationTargetStatus(node: GimGraphNode, reference: string): string {
  return childForReference(node, reference) ? '已关联' : '未找到对象';
}

function relationCount(node: GimGraphNode, key: string, fallback: number): string {
  const raw = node.rawProps[key];
  return raw && /^\d+$/.test(raw.trim()) ? raw.trim() : String(fallback);
}

/** 按杆塔、基础、导线、导线挂点四个业务组渲染 F4/TOWER 关系。 */
function renderTowerRelationGroups(node: GimGraphNode): string {
  const towerRefs = indexedRawReferences(node, /^TOWER(\d+)$/i);
  const baseRefs = indexedRawReferences(node, /^BASE(\d+)$/i);
  const stringRefs = indexedRawReferences(node, /^STRING(\d+)\.STRING$/i);
  const gpoints = Object.entries(node.rawProps)
    .map(([key, value]) => {
      const match = key.match(/^STRING(\d+)\.GPOINT$/i);
      return match && value ? { index: Number(match[1]), value } : null;
    })
    .filter((item): item is { index: number; value: string } => Boolean(item))
    .sort((a, b) => a.index - b.index);
  let html = '';
  if (towerRefs.length > 0 || node.rawProps['TOWERS.NUM']) {
    html += relationSection('杆塔', [
      ['数量', `${relationCount(node, 'TOWERS.NUM', towerRefs.length)} 个`],
      ...towerRefs.map(({ index, value }) => [`塔身 ${index + 1}`, relationTargetStatus(node, value)] as [string, string]),
    ]);
  }
  if (baseRefs.length > 0 || node.rawProps['BASES.NUM']) {
    html += relationSection('基础', [
      ['数量', `${relationCount(node, 'BASES.NUM', baseRefs.length)} 个`],
      ...baseRefs.map(({ index, value }) => [`基础 ${index + 1}`, relationTargetStatus(node, value)] as [string, string]),
    ]);
  }
  if (stringRefs.length > 0 || node.rawProps['STRINGS.NUM']) {
    html += relationSection('导线', [
      ['导线串数量', `${relationCount(node, 'STRINGS.NUM', stringRefs.length)} 个`],
      ...stringRefs.map(({ index, value }) => [`导线串 ${index + 1}`, relationTargetStatus(node, value)] as [string, string]),
    ]);
  }
  if (gpoints.length > 0) {
    html += relationSection('导线挂点', gpoints.map(({ index, value }) => [`挂点 ${index + 1}`, value] as [string, string]));
  }
  return html;
}

function renderLineRelationGroups(node: GimGraphNode): string {
  const groupType = (node.rawProps['GROUPTYPE'] || '').trim().toUpperCase();
  if (node.entityName.trim().toUpperCase() === 'F4SYSTEM' && groupType === 'TOWER') {
    const grouped = renderTowerRelationGroups(node);
    if (grouped) return grouped;
  }
  let html = '';
  const subdeviceRefs = indexedRawReferences(node, /^SUBDEVICE(\d+)$/i);
  if (subdeviceRefs.length > 0 || node.rawProps['SUBDEVICES.NUM']) {
    html += relationSection('导线', [
      ['子设备数量', `${relationCount(node, 'SUBDEVICES.NUM', subdeviceRefs.length)} 个`],
      ...subdeviceRefs.map(({ index, value }) => [`导线设备 ${index + 1}`, relationTargetStatus(node, value)] as [string, string]),
    ]);
  }
  const endpointRows: Array<[string, string]> = [];
  for (const [key, label] of [['BACKSTRING', '后侧挂点'], ['FRONTSTRING', '前侧挂点']] as const) {
    if (node.rawProps[key]) endpointRows.push([label, childForReference(node, node.rawProps[key]) ? '已关联' : '已记录']);
  }
  if (endpointRows.length > 0) html += relationSection('导线挂点', endpointRows);
  if (!html && node.children.length > 0) html = relationSection('子对象', [['数量', `${node.children.length} 个`]]);
  return html || '<div class="props-note">暂无可读关系。</div>';
}

export function buildLineNodeBuckets(
  node: GimGraphNode,
  attrs: LineAttributeIndex | undefined,
  modEntries: LineModRuntimeEntry[] = [],
): { overview: string; params: string; relations: string; source: string } {
  const component = lineComponentForNode(node);
  const overviewRows: PropertyRow[] = [
    { key: 'ENTITYNAME', value: node.entityName },
    ...(node.classifyName ? [{ key: 'SYSCLASSIFYNAME', value: node.classifyName, definition: definitionWithDisplayLabel(component, 'SYSCLASSIFYNAME', '分类') }] : []),
    ...(node.name && node.name !== node.entityName ? [{ key: 'PARTNAME', value: node.name, definition: definitionWithDisplayLabel(component, 'PARTNAME', '名称') }] : []),
    { key: 'NUM', value: node.children.length, definition: definitionWithDisplayLabel(component, 'NUM', '子节点数') },
  ];
  const overview = renderPropertySection('基本信息', component, overviewRows, { includeTechnical: false })
    + renderPropertySection('关键业务字段', component, rawRows(component, node.rawProps, new Set(), { excludeReferences: true }).primary, { includeTechnical: false, allowReferences: false });
  const params = renderLineRawProperties(node, component)
    + renderLineAttributeRecords(node, attrs)
    + (modEntries.length > 0 ? renderLineModSources(modEntries, { includeSourceLink: false }) : '<div class="props-note">正在读取可达的 MOD 参数…</div>');
  const relations = renderLineRelationGroups(node);
  const source = renderLineSourceRefs(node, modEntries)
    + renderLineTowerShapeSource(node, modEntries, { includeSourceLink: false });
  return { overview, params, relations, source };
}

function showLineInspector(
  title: string,
  buckets: { overview: string; params: string; relations: string; source: string },
  activeTab = 'overview',
): void {
  renderInspectorTabs(`<div class="props-header">${escHtml(title)}</div>`, buckets, activeTab);
  propsDrawer.classList.remove('collapsed');
  btnToggleProps.style.right = '364px';
}

function activeInspectorTab(): string {
  return propsDrawerBody.querySelector<HTMLElement>('[data-itab].active')?.getAttribute('data-itab') || 'overview';
}

let currentLineState: AppState | null = null;
let lineInspectorGeneration = 0;

/** 当前检查器对应的业务节点及其异步解析出的来源路径。 */
let currentLineInspectorNode: GimGraphNode | null = null;
let currentLineInspectorSourcePaths = new Set<string>();

/** 销毁线路地图及 MapLibre 资源。 */
function destroyLineMapResources(): void {
  maplibreProbeGeneration++;
  for (const fn of maplibreInteractionCleanup) {
    try { fn(); } catch { /* ignore */ }
  }
  maplibreInteractionCleanup = [];
  if (lineMapHandle) {
    lineMapHandle.destroy();
    lineMapHandle = null;
  }
  if (maplibreProbeHandle) {
    maplibreProbeHandle.destroy();
    maplibreProbeHandle = null;
  }
}

function pathMatchesReference(candidate: string, reference: string): boolean {
  const a = normalizeGimPath(candidate).toLowerCase();
  const b = normalizeGimPath(reference).toLowerCase();
  if (!a || !b) return false;
  return a === b || getFileNameLower(a) === getFileNameLower(b);
}

/** 属性面板来源按钮的线路路由：定位到可见业务树节点，不把 GUID 路径写进正文。 */
export function handleLinePropertyReference(detail: PropertyReferenceDetail): boolean {
  const state = currentLineState;
  const graph = state?.currentGimGraph;
  if (!state || state.currentProjectType !== 'transmission_line' || !graph) return false;
  let sourceNode: GimGraphNode | null = null;
  if (detail.kind === 'cbm') {
    sourceNode = Array.from(graph.nodesByPath.values()).find((node) => pathMatchesReference(node.path, detail.path)) || null;
  } else {
    const refsForKind: Record<string, (node: GimGraphNode) => string[]> = {
      dev: (node) => node.refs.devFiles,
      fam: (node) => node.refs.famFiles,
      phm: (node) => node.refs.phmFiles,
      mod: (node) => node.refs.modFiles,
      stl: (node) => node.refs.stlFiles,
      file: (node) => [...node.refs.wireFiles, ...node.refs.cbmFiles],
      ifc: (node) => node.refs.ifcFiles,
      sld: () => [],
    };
    const getRefs = refsForKind[detail.kind];
    if (getRefs) {
      sourceNode = Array.from(graph.nodesByPath.values()).find((node) =>
        getRefs(node).some((path) => pathMatchesReference(path, detail.path))) || null;
    }
  }
  if (!sourceNode || !lineNavigationIndex) {
    // MOD/PHM/STL 可能只在 DEV→PHM→几何链中出现，未作为 CBM 节点的
    // 直接 refs 持久化。它们的按钮是在当前检查器异步解析后生成的，
    // 因而可安全回到当前业务节点；仍要求路径命中当前检查器来源集合，
    // 避免旧面板按钮误跳到新节点。
    if (currentLineInspectorNode
      && currentLineInspectorSourcePaths.size > 0
      && Array.from(currentLineInspectorSourcePaths).some((path) => pathMatchesReference(path, detail.path))) {
      sourceNode = currentLineInspectorNode;
    }
  }
  if (!sourceNode || !lineNavigationIndex) {
    currentShowMessage?.('该来源文件未映射到可见线路节点');
    return true;
  }
  const target = resolveLineNavigationTarget(lineNavigationIndex, sourceNode.path);
  if (!target) {
    currentShowMessage?.('该来源文件未映射到可见线路节点');
    return true;
  }
  const targetKey = revealLineNavigationTarget(lineNavigationIndex, target.key);
  if (targetKey) selectTreeRow(targetKey);
  handleLineNavigationNode(target);
  return true;
}

/** 显示线路节点属性；MOD 解析异步补到“参数”页签，避免阻塞树交互。 */
export function showLineNodeProperties(
  node: GimGraphNode,
  state: AppState | null = currentLineState,
  displayLabel?: string,
): void {
  const generation = ++lineInspectorGeneration;
  currentLineInspectorNode = node;
  currentLineInspectorSourcePaths = new Set([
    node.path,
    ...node.refs.cbmFiles,
    ...node.refs.devFiles,
    ...node.refs.famFiles,
    ...node.refs.phmFiles,
    ...node.refs.modFiles,
    ...node.refs.stlFiles,
    ...node.refs.wireFiles,
    ...node.refs.ifcFiles,
  ]);
  const attrs = state ? buildLineAttributeIndex(state) : undefined;
  const title = displayLabel?.trim() || nodeDisplayName(node);
  showLineInspector(title, buildLineNodeBuckets(node, attrs));
  if (!state) return;
  void loadLineModSourcesForNode(state, node).then((entries) => {
    if (generation !== lineInspectorGeneration || currentLineState !== state) return;
    for (const entry of entries) currentLineInspectorSourcePaths.add(entry.path);
    const buckets = buildLineNodeBuckets(node, buildLineAttributeIndex(state), entries);
    showLineInspector(title, buckets, activeInspectorTab());
  }).catch((error) => {
    if (generation !== lineInspectorGeneration || currentLineState !== state) return;
    const buckets = buildLineNodeBuckets(node, buildLineAttributeIndex(state), []);
    buckets.params += `<div class="props-note warning">读取线路 MOD 失败：${escHtml(error instanceof Error ? error.message : String(error))}</div>`;
    showLineInspector(title, buckets, activeInspectorTab());
  });
}

/** 显示地图导线属性；保持同样的四页签结构和来源按钮约定。 */
function showWireProperties(wire: WireSegment, state: AppState | null = currentLineState): void {
  const info: WireSemanticInfo = buildWireSemanticInfo({ wire });
  const node = wire.nodeRef;
  currentLineInspectorNode = node;
  currentLineInspectorSourcePaths = new Set([
    node.path,
    ...node.refs.cbmFiles,
    ...node.refs.devFiles,
    ...node.refs.famFiles,
    ...node.refs.phmFiles,
    ...node.refs.modFiles,
    ...node.refs.stlFiles,
    ...node.refs.wireFiles,
    ...node.refs.ifcFiles,
  ]);
  const component: PropertyComponent = 'line-wire';
  const overview = renderPropertySection('导线语义', component, [
    { key: 'WIRETYPE', value: info.wireType },
    { key: 'ISJUMPER', value: info.isJumper ? '是' : '否' },
    { key: 'SPLIT', value: info.split ?? '—' },
    { key: 'KVALUE', value: info.kValue ?? '—' },
    { key: 'spanMeters', value: info.spanMeters != null ? formatNumber(info.spanMeters, 1) : '—', unit: 'm' },
  ]) + renderPropertySection('端点坐标', 'line-point-line', [
    {
      key: 'POINT0.BLHA',
      value: [formatNumber(wire.startLat, 8), formatNumber(wire.startLng, 8),
        wire.startElev == null ? '—' : formatNumber(wire.startElev, 3), '—'].join(','),
    },
    {
      key: 'POINT1.BLHA',
      value: [formatNumber(wire.endLat, 8), formatNumber(wire.endLng, 8),
        wire.endElev == null ? '—' : formatNumber(wire.endElev, 3), '—'].join(','),
    },
  ]);
  const params = (node ? renderLineRawProperties(node, component) : '')
    + (node && state ? renderLineAttributeRecords(node, buildLineAttributeIndex(state)) : '')
    + '<div class="props-note">POINT0/1.MATRIX0 等长矩阵已归入技术字段；需要时展开“技术字段”。</div>';
  const relations = node
    ? renderLineRelationGroups(node)
      + (info.warnings.length ? relationSection('解析告警', [['说明', info.warnings.join('；')]]) : '')
    : '';
  const source = node ? renderLineSourceRefs(node) : '';
  const generation = ++lineInspectorGeneration;
  showLineInspector(node ? nodeDisplayName(node) : '导线', { overview, params, relations, source });
  if (state && node) {
    void loadLineModSourcesForNode(state, node).then((entries) => {
      if (generation !== lineInspectorGeneration || currentLineState !== state) return;
      for (const entry of entries) currentLineInspectorSourcePaths.add(entry.path);
      showLineInspector(nodeDisplayName(node), {
        overview,
        params: params + renderLineModSources(entries, { includeSourceLink: false }),
        relations,
        source: renderLineSourceRefs(node, entries),
      }, activeInspectorTab());
    }).catch(() => { /* 基础属性已可用，解析失败由来源按钮继续排查 */ });
  }
}

/**
 * M4-B2：地图点击导线回调：显示导线属性面板并选中对应档距。
 *
 * 线路业务树的导线明细位于“档距”下，因此地图命中一条 WIRE 时，
 * 左侧选中的是该 WIRE 所属的档距行，而不是把原始 WIRE 节点铺到树根。
 */
function handleMapWireClick(wire: WireSegment): void {
  showWireProperties(wire, currentLineState);
  propsDrawer.classList.remove('collapsed');
  btnToggleProps.style.right = '364px';
  const target = lineNavigationIndex
    ? resolveLineNavigationTarget(lineNavigationIndex, wire.nodeRef.path)
    : null;
  if (target && lineNavigationIndex) {
    const targetKey = revealLineNavigationTarget(lineNavigationIndex, target.key);
    if (targetKey) selectTreeRow(targetKey);
  }
}

// ---------------------------------------------------------------------------
// 地图视图生命周期管理
// ---------------------------------------------------------------------------

/** 当前地图视图 handle（模块级，避免重复打开 GIM 后残留） */
let lineMapHandle: LineMapViewHandle | null = null;

/** 当前地图数据（供左侧树点击定位地图时反查 TowerMarker nodePath 用） */
let lineMapData: LineMapData | null = null;

/** 当前线路业务导航投影（地图/搜索/树联动共用，变电工程不触碰）。 */
let lineNavigationIndex: LineNavigationIndex | null = null;

/** 当前线路地图的悬链线模式；底图 overlay/fallback 重建时必须沿用 A/B 选择。 */
let currentLineCatenaryEnabled = ENABLE_CATENARY;

/** 线路面板渲染选项；默认值保持现有生产行为，额外字段仅供性能 A/B。 */
export interface LineRenderOptions {
  /** 调用方捕获的性能会话；迟到的渲染 span 不得写入新工程。 */
  perfSession?: PerfSession;
  /** 覆盖悬链线渲染开关，便于在同一样本做 A/B；默认 ENABLE_CATENARY。 */
  enableCatenary?: boolean;
}

/**
 * M4-B3A：最新悬链线参数审计导出 payload（模块级，供 Ctrl+Shift+C 复制使用）。
 *
 * 仅线路工程成功渲染后有值；变电工程 / 清空场景时为 null。
 * 在 renderLineProjectPanels 完成后保存上下文；真正的审计 payload 在用户
 * 按 Ctrl+Shift+C 或显式导出时才构建，避免把完整报告放进首屏关键路径。
 */
let latestCatenaryAuditPayload: LineCatenaryAuditExportPayload | null = null;
let latestCatenaryAuditContext: { graph: GimGraph; mapData: LineMapData } | null = null;

/** M4-B3A：读取最新悬链线审计 payload（供快捷键 Ctrl+Shift+C 调用） */
export function getLatestCatenaryAuditPayload(): LineCatenaryAuditExportPayload | null {
  if (!latestCatenaryAuditPayload && latestCatenaryAuditContext) {
    latestCatenaryAuditPayload = buildLineCatenaryAuditExportPayload(latestCatenaryAuditContext);
  }
  return latestCatenaryAuditPayload;
}

/** M4-B3A：将 payload 格式化为 Markdown（供快捷键 Ctrl+Shift+C 调用） */
export function formatLatestCatenaryAuditMarkdown(): string | null {
  const payload = getLatestCatenaryAuditPayload();
  return payload ? formatLineCatenaryAuditMarkdown(payload) : null;
}

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
 * 底图切换：showMessage 回调（用于在切换成功/失败时给用户提示）。
 *
 * renderLineProjectPanels 时保存，destroyLineMapView 时清空。
 */
let currentShowMessage: ((text: string) => void) | null = null;

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
  // 使仍在读取线路 MOD 的异步检查器结果失效，避免旧工程覆盖新工程面板。
  lineInspectorGeneration++;
  currentLineState = null;
  destroyLineMapResources();
  lineMapData = null;
  lineNavigationIndex = null;
  // 底图切换：清空引用 + 重置运行时底图模式
  currentShowMessage = null;
  resetRuntimeBasemapMode();
  // M4-B3A：清空悬链线审计 payload（避免变电工程 / 清空场景残留旧线路数据）
  latestCatenaryAuditPayload = null;
  latestCatenaryAuditContext = null;
  currentLineCatenaryEnabled = ENABLE_CATENARY;
  // M4-A2 Finalization：重置底图运行状态（避免下次打开工程时残留旧状态）
  resetBasemapStatus();
}

// ---------------------------------------------------------------------------
// Phase 4：地图→左侧树选中联动
// ---------------------------------------------------------------------------

/** 选中并滚动到指定业务树行键；未找到时静默返回。 */
function selectTreeRow(key: string): void {
  // 通过 dataset 精确比较，兼容业务键中的冒号、百分号和路径字符。
  const row = Array.from(document.querySelectorAll<HTMLElement>('.tree-row'))
    .find((candidate) => candidate.dataset.nodePath === key);
  if (!row) return;
  // 清除旧的 selected
  document.querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
  row.classList.add('selected');
  // 滚动到可见区域（smooth，避免突兀跳动）
  row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------------------
// 线路业务树 ↔ 地图联动
// ---------------------------------------------------------------------------

/** 收集业务投影子树中的塔位来源路径，去重后交给地图 fit bbox。 */
function collectNavigationTowerPaths(node: LineNavigationNode): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const walk = (current: LineNavigationNode): void => {
    const towerPath = current.tower?.nodeRef?.path;
    if (towerPath && !seen.has(towerPath)) {
      seen.add(towerPath);
      paths.push(towerPath);
    }
    for (const child of current.children) walk(child);
  };
  walk(node);
  return paths;
}

function nearestNavigationAncestor(node: LineNavigationNode, kind: LineNavigationNode['kind']): LineNavigationNode | null {
  if (!lineNavigationIndex) return null;
  let key: string | undefined = node.key;
  const seen = new Set<string>();
  while (key && !seen.has(key)) {
    seen.add(key);
    const current = lineNavigationIndex.nodesByKey.get(key);
    if (!current) return null;
    if (current.kind === kind) return current;
    key = lineNavigationIndex.parentByKey.get(key);
  }
  return null;
}

function focusNavigationNode(node: LineNavigationNode): void {
  if (!lineMapHandle || !lineMapData) return;

  if (node.kind === 'tower' && node.tower?.nodeRef?.path) {
    lineMapHandle.focusTowerByNodePath(node.tower.nodeRef.path);
    return;
  }

  // WIRE / 同塔连接 / 跨越物明细优先定位其所在档距或塔位。
  const span = node.kind === 'span'
    ? node
    : nearestNavigationAncestor(node, 'span');
  if (span?.span) {
    const endpointPaths = [
      span.span.startTower?.nodeRef?.path,
      span.span.endTower?.nodeRef?.path,
    ].filter((path): path is string => Boolean(path));
    if (endpointPaths.length > 0 && lineMapHandle.focusBboxByNodePaths(endpointPaths)) return;
  }
  const samePointTower = nearestNavigationAncestor(node, 'tower');
  if (samePointTower?.tower?.nodeRef?.path) {
    lineMapHandle.focusTowerByNodePath(samePointTower.tower.nodeRef.path);
    return;
  }

  const towerPaths = collectNavigationTowerPaths(node);
  if (towerPaths.length > 0) lineMapHandle.focusBboxByNodePaths(towerPaths);
}

/** 左侧业务树点击：显示来源属性/导线语义，并按业务层级定位地图。 */
function handleLineNavigationNode(node: LineNavigationNode): void {
  if (node.kind === 'wire' && node.wire) {
    showWireProperties(node.wire, currentLineState);
  } else if (node.node) {
    // 右侧标题使用业务投影行（如“杆塔 01”），分类 TOWER/F4System
    // 仅在概览/副信息中展示，避免原始实体名抢占实例名称。
    showLineNodeProperties(node.node, currentLineState, node.label);
  } else {
    propsDrawerBody.innerHTML = `<div class="props-empty">${escHtml(node.label)}</div>`;
  }
  propsDrawer.classList.remove('collapsed');
  btnToggleProps.style.right = '364px';
  focusNavigationNode(node);
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
  const target = lineNavigationIndex && node.path
    ? resolveLineNavigationTarget(lineNavigationIndex, node.path)
    : null;
  showLineNodeProperties(node, currentLineState, target?.label);
  propsDrawer.classList.remove('collapsed');
  btnToggleProps.style.right = '364px';
  if (lineNavigationIndex && node.path) {
    if (target) {
      const targetKey = revealLineNavigationTarget(lineNavigationIndex, target.key);
      if (targetKey) selectTreeRow(targetKey);
    }
  }
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
  options: LineRenderOptions = {},
): void {
  const perfSession = options.perfSession ?? perfCurrentSession();
  const catenaryEnabled = options.enableCatenary ?? ENABLE_CATENARY;
  currentLineCatenaryEnabled = catenaryEnabled;

  // 确保 state 与 graph 同步（调用方可能已设置，此处幂等确认）
  state.currentGimGraph = graph;

  // 0. 线路工程只保留模型树与地图视口；隐藏变电专用的设备、图层和图纸 tab。
  hideTabs(['tab-models', 'tab-filedev', 'tab-sld']);

  // 1. 先清理上一条线路的地图/联动状态，再构建本次线路的业务投影。
  //    这样异步底图回调不会把旧线路的树键或地图句柄带入新工程。
  destroyLineMapView();
  // destroyLineMapView 会使上一工程的状态失效；此处在清理完成后重新
  // 绑定当前线路，保证属性来源按钮和异步 MOD 解析能拿到当前 graph。
  currentLineState = state;
  const attrs = buildLineAttributeIndex(state);
  const endMapData = perfBegin('线路地图数据提取', undefined, perfSession);
  const mapData = extractLineMapData(graph, attrs);
  endMapData(undefined, {
    towers: mapData.stats.towerTotal,
    wires: mapData.stats.wireTotal,
    crosses: mapData.stats.crossTotal,
  });
  lineMapData = mapData;
  const endNavigationIndex = perfBegin('线路导航索引构建', undefined, perfSession);
  lineNavigationIndex = graph.root
    ? buildLineNavigationIndex(graph, mapData, {
      projectName: state.projectName,
      attrs,
    })
    : null;
  endNavigationIndex(undefined, lineNavigationIndex ? {
    nodes: lineNavigationIndex.nodesByKey.size,
    sections: lineNavigationIndex.stats.sectionCount,
    strains: lineNavigationIndex.stats.strainSectionCount,
    spans: lineNavigationIndex.stats.spanCount,
  } : { nodes: 0 });

  // 2. 左侧树只渲染线路业务投影，不再把 F1/F2/F3/F4 和设备原始节点直接铺开。
  const endNavigationDom = perfBegin('线路导航树 DOM 渲染', undefined, perfSession);
  cbmTreePanel.innerHTML = '';
  if (!lineNavigationIndex) {
    cbmTreePanel.innerHTML = '<div class="props-empty">线路工程未找到 CBM 层级树</div>';
  } else {
    renderLineNavigationTree(lineNavigationIndex, cbmTreePanel, handleLineNavigationNode);
  }
  endNavigationDom(undefined, {
    nodes: lineNavigationIndex?.nodesByKey.size ?? 0,
  });

  // 3. 文件设备面板摘要（tab 已隐藏，但内容仍渲染以备后续展示）
  const endSummaryDom = perfBegin('线路摘要与搜索 DOM', undefined, perfSession);
  renderLineFileSummary(graph);

  // 4. 模型面板（清空占位，不显示 IFC 提示）
  renderLineModelPanel();

  // 5. 主视口：渲染线路地图

  // M0 设计系统：状态栏右侧工程统计（design/component_brief.md §21）
  setStatusRight(
    `${mapData.stats.towerTotal} 杆塔 · ${mapData.wires.length} 导线段 · ${mapData.crosses.length} 跨越物`,
  );

  // 搜索框：索引只包含线路/区段/耐张段/塔位/档距/导线/跨越物业务行，
  // 命中后展开祖先链并复用树点击的属性和地图联动。
  let searchItemCount = 0;
  if (lineNavigationIndex) {
    const searchItems = buildLineNavigationSearchIndex(lineNavigationIndex);
    searchItemCount = searchItems.length;
    renderSearchBox(cbmTreePanel, searchItems, (key) => {
      if (!lineNavigationIndex) return;
      const target = resolveLineNavigationTarget(lineNavigationIndex, key);
      if (!target) return;
      const targetKey = revealLineNavigationTarget(lineNavigationIndex, target.key);
      if (!targetKey) return;
      selectTreeRow(targetKey);
      handleLineNavigationNode(target);
    });
  }
  endSummaryDom(undefined, {
    searchItems: searchItemCount,
  });
  // 底图切换：保存 showMessage 引用，切换底图时给用户提示
  currentShowMessage = showMessage;

  // M4-B3A：只保存审计上下文；完整 report/sample 在 Ctrl+Shift+C 或显式
  // 导出时按需构建，避免首屏渲染关键路径执行全量审计。
  latestCatenaryAuditPayload = null;
  latestCatenaryAuditContext = { graph, mapData };
  debugLog(DEBUG_LINE_MAP, '[M4-B3] catenary renderer config', {
    enabled: catenaryEnabled,
    wireCount: mapData.wires.length,
  });

  // Phase 5：地图数据统计与未解析引用摘要（追加到文件设备面板）
  renderMapStats(mapData);

  const endCanvasMap = perfBegin('线路 Canvas 地图绘制', undefined, perfSession);
  if (isLineMapDataValid(mapData)) {
    // 地图点击塔位走 handleMapTowerClick：显示属性 + 选中左侧树行
    // M4-B2：onWireClick 处理导线点击（命中导线且未命中塔位时触发）
    lineMapHandle = renderLineMap(mapData, container, handleMapTowerClick, {
      onWireClick: handleMapWireClick,
      enableCatenary: catenaryEnabled,
      perfSession,
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
  endCanvasMap(undefined, {
    towers: mapData.towers.length,
    wires: mapData.wires.length,
    crosses: mapData.crosses.length,
    catenary: catenaryEnabled,
    valid: isLineMapDataValid(mapData),
  });
  // M4-A2 Finalization：先报告 Canvas-only 状态
  // - 无论 ENABLE_MAPLIBRE_EXPERIMENT 是否开启，主视口已先以 Canvas-only 形式就绪
  // - 后续 MapLibre overlay 成功时状态会被更新为对应在线 raster 状态
  // - 在线 raster 失败回退时状态会被更新为 '*-unavailable-fallback'
  setBasemapStatus('canvas-only', {
    mode: runtimeBasemapMode,
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
  //    底图模式（runtimeBasemapMode，可由 UI 切换）：
  //    - 'osm-online'      ：MVP 默认，加载 OSM 在线 raster 瓦片
  //    - 'tianditu-terrain': 天地图地形图（ter_w + cta_w 双图层）
  //    - 'tianditu-vector' : 天地图矢量图（vec_w + cva_w 双图层）
  //    - 'pmtiles'        ：走 PMTiles 预研路径（默认关闭，需 ENABLE_PMTILES_EXPERIMENT=true）
  //    - 'empty'          ：不加载瓦片，仅显示纯色背景
  //    - 在线 raster 不可用（3 次 tile error）或初始化失败时，自动回退 Canvas-only
  //    底图切换 UI：附加到图层面板下方（OSM / 天地图卫星 / 天地图地形 / 天地图矢量）
  attachBasemapSwitcher(mapData);
  if (ENABLE_MAPLIBRE_EXPERIMENT && isLineMapDataValid(mapData)) {
    debugLog(DEBUG_LINE_MAP, '[MapLibre overlay] enabled:', ENABLE_MAPLIBRE_EXPERIMENT);
    debugLog(DEBUG_LINE_MAP, '[MapLibre overlay] basemap mode:', runtimeBasemapMode);
    if (runtimeBasemapMode === 'osm-online') {
      debugLog(DEBUG_LINE_MAP, '[MapLibre overlay] using OSM online raster tiles');
    } else if (runtimeBasemapMode === 'tianditu-satellite') {
      debugLog(DEBUG_LINE_MAP, '[MapLibre overlay] using Tianditu satellite raster tiles');
    } else if (runtimeBasemapMode === 'tianditu-terrain') {
      debugLog(DEBUG_LINE_MAP, '[MapLibre overlay] using Tianditu terrain raster tiles');
    } else if (runtimeBasemapMode === 'tianditu-vector') {
      debugLog(DEBUG_LINE_MAP, '[MapLibre overlay] using Tianditu vector raster tiles');
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
    // 在线 raster 不可用时回退 Canvas-only
    //  - 只触发一次（fallbackToCanvasOnlyCalled 守卫）
    //  - 可能在 probe 创建期间（await 中）或之后触发
    //  - 创建期间触发时，IIFE 在 await 返回后检查 flag 并放弃 overlay 切换
    let fallbackToCanvasOnlyCalled = false;
    function fallbackToCanvasOnly(reason: unknown): void {
      if (fallbackToCanvasOnlyCalled) return;
      fallbackToCanvasOnlyCalled = true;

      const modeLabel = basemapModeLabel(runtimeBasemapMode);
      debugWarn(DEBUG_LINE_MAP, `[MapLibre overlay] ${modeLabel} unavailable, fallback to Canvas-only`, reason);

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
        enableCatenary: currentLineCatenaryEnabled,
        perfSession: perfCurrentSession(),
      });
      // fallback 后重新附加底图切换控件到新的图层面板
      attachBasemapSwitcher(mapData);

      // M4-A2 Finalization：上报回退状态（含可读 reason 供诊断展示）
      // M4-A2 小修：fallback 后 MapLibre probe 已销毁，实际运行模式为 Canvas-only，
      //             因此 maplibreEnabled=false（反映"当前是否仍有 MapLibre 在线"而非"是否曾启用过"）
      const fallbackStatus: BasemapStatus = isTiandituMode(runtimeBasemapMode)
        ? 'tianditu-unavailable-fallback'
        : 'osm-unavailable-fallback';
      setBasemapStatus(fallbackStatus, {
        mode: runtimeBasemapMode,
        maplibreEnabled: false,
        fallbackReason: reason instanceof Error ? reason.message : String(reason),
      });

      // UI 状态提示
      try {
        showMessage(`${modeLabel}不可用，已切换为 Canvas 地图模式`);
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
          basemapMode: runtimeBasemapMode,
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
        let redrawFn: ((phase?: LineMapRenderPhase) => void) | null = null;
        lineMapHandle = renderLineMap(mapData, container, handleMapTowerClick, {
          projection,
          onRequestRedraw: (draw) => { redrawFn = draw; },
          // M4-B2：overlay 模式下也支持导线点击
          onWireClick: handleMapWireClick,
          enableCatenary: currentLineCatenaryEnabled,
          perfSession: perfCurrentSession(),
        });
        // MapLibre 相机变化期间只请求 interactive frame；moveend/zoomend
        // 才启动完整 settled progressive pass，避免拖动时等待旧 pass 或
        // 每个 move 都重新开始完整渐进绘制。
        const offView = probe.onViewChange((kind) => {
          redrawFn?.('interactive');
          // Resize 没有对应的 resizeend 事件；在尺寸变化完成后安排
          // 一次 settled pass，保证标签/悬链线不会停留在轻量层。
          if (kind === 'resize') redrawFn?.('settled');
        });
        const offSettled = probe.onViewSettled(() => {
          redrawFn?.('settled');
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
        maplibreInteractionCleanup.push(offView, offSettled, offMove, offClick, offLeave);
        // overlay handle 创建后，重新附加底图切换控件到新的图层面板
        attachBasemapSwitcher(mapData);
        // M4-A2 Finalization：MapLibre overlay 初始化成功，按当前底图模式上报状态
        setBasemapStatus(basemapStatusFromMode(runtimeBasemapMode), {
          mode: runtimeBasemapMode,
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

// ---------------------------------------------------------------------------
// 底图切换 UI
// ---------------------------------------------------------------------------

/** 判断是否为天地图模式 */
function isTiandituMode(mode: LineBasemapMode): boolean {
  return mode === 'tianditu-satellite' || mode === 'tianditu-terrain' || mode === 'tianditu-vector';
}

/** 获取底图模式的人类可读标签 */
function basemapModeLabel(mode: LineBasemapMode): string {
  switch (mode) {
    case 'osm-online': return 'OpenStreetMap';
    case 'tianditu-satellite': return '天地图卫星影像';
    case 'tianditu-terrain': return '天地图地形图';
    case 'tianditu-vector': return '天地图矢量图';
    case 'pmtiles': return 'PMTiles';
    case 'empty': return '空白底图';
    default: return mode;
  }
}

/** 底图切换按钮配置 */
const BASEMAP_SWITCHER_OPTIONS: { mode: LineBasemapMode; label: string; title: string }[] = [
  { mode: 'osm-online',        label: 'OSM',  title: 'OpenStreetMap 在线底图' },
  { mode: 'tianditu-satellite', label: '卫星', title: '天地图卫星影像（高分辨率遥感）' },
  { mode: 'tianditu-terrain',  label: '地形', title: '天地图地形图（侧视效果，可观察悬链线弧垂）' },
  { mode: 'tianditu-vector',   label: '矢量', title: '天地图矢量图（道路/地名）' },
];

/**
 * 从 lineMapHandle 获取图层面板，并附加底图切换控件。
 *
 * 在以下时机调用：
 * - renderLineProjectPanels 创建 lineMapHandle 后（Canvas-only）
 * - MapLibre overlay 切换成功后（overlay handle 创建后）
 * - switchBasemap 中每次 handle 重建后
 *
 * 底图切换控件渲染为图层面板的子区域（"底图" 标题 + 按钮组），
 * 随 lineMapHandle.destroy() 自动移除（图层面板被 remove）。
 */
function attachBasemapSwitcher(mapData: LineMapData): void {
  if (!lineMapHandle?.getLayerPanel) return;
  const layerPanel = lineMapHandle.getLayerPanel();
  if (!layerPanel) return;
  renderBasemapSwitcherIntoLayerPanel(layerPanel, mapData);
}

/**
 * 在图层面板内渲染底图切换区域（作为 "底图" 子区域）。
 *
 * - 位于图层 checkbox 下方，带分隔线和标题
 * - 四选一切换：OSM / 天地图卫星 / 天地图地形 / 天地图矢量
 * - 当前模式按钮高亮
 * - 点击切换：更新 runtimeBasemapMode + 销毁当前 probe + 重建 probe
 * - 天地图模式在 key 未配置时禁用按钮
 * - 随图层面板 destroy 自动移除
 *
 * @param layerPanel 图层面板 DOM 元素
 * @param mapData 当前线路地图数据（用于切换时复用）
 */
function renderBasemapSwitcherIntoLayerPanel(layerPanel: HTMLElement, mapData: LineMapData): void {
  // 已存在则移除（重入时刷新）
  const existing = layerPanel.querySelector('.basemap-switcher-section');
  if (existing) existing.remove();

  const section = document.createElement('div');
  section.className = 'basemap-switcher-section';
  section.style.cssText = `
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid #cbd5e1;
  `;

  const title = document.createElement('div');
  title.textContent = '底图';
  title.style.cssText = `
    font-weight: 600;
    margin-bottom: 4px;
    color: #334155;
  `;
  section.appendChild(title);

  const btnGroup = document.createElement('div');
  btnGroup.style.cssText = `
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  `;

  const hasTiandituKey = isTiandituKeyAvailable();
  const container = layerPanel.parentElement || document.getElementById('viewport') as HTMLElement;

  for (const opt of BASEMAP_SWITCHER_OPTIONS) {
    const btn = document.createElement('button');
    btn.textContent = opt.label;
    btn.title = opt.title;
    btn.style.cssText = `
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid transparent;
      background: #f1f5f9;
      color: #475569;
      cursor: pointer;
      font-size: 11px;
      transition: background 0.15s;
    `;
    if (runtimeBasemapMode === opt.mode) {
      btn.style.background = '#0d84fc';
      btn.style.color = '#fff';
      btn.style.borderColor = '#0d84fc';
    }
    // 天地图 key 未配置时禁用对应按钮
    if (!hasTiandituKey && isTiandituMode(opt.mode)) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
      btn.title = '未配置 VITE_TIANDITU_KEY（.env），无法使用天地图';
    }
    btn.addEventListener('mouseenter', () => {
      if (!btn.disabled && runtimeBasemapMode !== opt.mode) {
        btn.style.background = '#e2e8f0';
      }
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.disabled && runtimeBasemapMode !== opt.mode) {
        btn.style.background = '#f1f5f9';
        btn.style.color = '#475569';
      }
    });
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      if (runtimeBasemapMode === opt.mode) return; // 已是当前模式
      switchBasemap(opt.mode, container, mapData);
    });
    btnGroup.appendChild(btn);
  }

  section.appendChild(btnGroup);
  layerPanel.appendChild(section);
}

/**
 * 切换底图模式：更新 runtimeBasemapMode + 销毁旧 probe + 重建 probe + overlay。
 *
 * 复用 renderLineProjectPanels 的 probe 创建逻辑（异步、代次守卫、fallback 回退）。
 * 切换期间 mapData 不变（仅底图变化，线路要素不变）。
 *
 * @param newMode 新底图模式
 * @param container 地图容器
 * @param mapData 当前线路地图数据
 */
function switchBasemap(
  newMode: LineBasemapMode,
  container: HTMLElement,
  mapData: LineMapData,
): void {
  setRuntimeBasemapMode(newMode);

  // 销毁旧 probe + 旧 overlay（图层面板 + 底图切换控件随之移除）
  maplibreProbeGeneration++;
  for (const fn of maplibreInteractionCleanup) {
    try { fn(); } catch { /* ignore */ }
  }
  maplibreInteractionCleanup = [];
  if (lineMapHandle) {
    lineMapHandle.destroy();
    lineMapHandle = null;
  }
  if (maplibreProbeHandle) {
    maplibreProbeHandle.destroy();
    maplibreProbeHandle = null;
  }

  // 重新渲染 Canvas-only（先恢复交互，再异步切换到 overlay）
  lineMapHandle = renderLineMap(mapData, container, handleMapTowerClick, {
    onWireClick: handleMapWireClick,
    enableCatenary: currentLineCatenaryEnabled,
    perfSession: perfCurrentSession(),
  });
  // Canvas-only handle 创建后，附加底图切换控件到新的图层面板
  attachBasemapSwitcher(mapData);
  setBasemapStatus('canvas-only', {
    mode: runtimeBasemapMode,
    maplibreEnabled: ENABLE_MAPLIBRE_EXPERIMENT,
  });

  if (!ENABLE_MAPLIBRE_EXPERIMENT) return;

  const myGen = maplibreProbeGeneration;
  let fallbackCalled = false;
  function fallback(reason: unknown): void {
    if (fallbackCalled) return;
    fallbackCalled = true;
    if (myGen !== maplibreProbeGeneration) return;
    const label = basemapModeLabel(newMode);
    debugWarn(DEBUG_LINE_MAP, `[MapLibre overlay] ${label} unavailable, fallback to Canvas-only`, reason);
    setBasemapStatus(isTiandituMode(newMode) ? 'tianditu-unavailable-fallback' : 'osm-unavailable-fallback', {
      mode: newMode,
      maplibreEnabled: false,
      fallbackReason: reason instanceof Error ? reason.message : String(reason),
    });
    try {
      currentShowMessage?.(`${label}不可用，已切换为 Canvas 地图模式`);
    } catch { /* ignore */ }
  }

  void (async () => {
    try {
      const { createMapLibreProbe } = await import('./lineMapBaseLayer.js');
      if (myGen !== maplibreProbeGeneration) return;
      const initialBounds: [number, number, number, number] = [
        mapData.bbox.minLng, mapData.bbox.minLat, mapData.bbox.maxLng, mapData.bbox.maxLat,
      ];
      const probe = await createMapLibreProbe(container, {
        initialBounds,
        basemapMode: newMode,
        pmtiles: {
          enabled: ENABLE_PMTILES_EXPERIMENT,
          url: PMTILES_DEMO_URL,
        },
        onBasemapUnavailable: fallback,
      });
      if (fallbackCalled || myGen !== maplibreProbeGeneration) {
        try { probe.destroy(); } catch { /* ignore */ }
        return;
      }
      maplibreProbeHandle = probe;
      const map = probe.getMap();
      if (!map) throw new Error('MapLibre map 实例为 null');
      const baseProjection = createMapLibreProjection(map);
      const projection: LineMapProjection = {
        ...baseProjection,
        fitBounds(bbox: GeoBBox) {
          probe.fitBounds([bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]);
        },
      };
      if (lineMapHandle) {
        lineMapHandle.destroy();
        lineMapHandle = null;
      }
      let redrawFn: ((phase?: LineMapRenderPhase) => void) | null = null;
      lineMapHandle = renderLineMap(mapData, container, handleMapTowerClick, {
        projection,
        onRequestRedraw: (draw) => { redrawFn = draw; },
        onWireClick: handleMapWireClick,
        enableCatenary: currentLineCatenaryEnabled,
        perfSession: perfCurrentSession(),
      });
      const offView = probe.onViewChange((kind) => {
        redrawFn?.('interactive');
        if (kind === 'resize') redrawFn?.('settled');
      });
      const offSettled = probe.onViewSettled(() => { redrawFn?.('settled'); });
      const offMove = probe.onPointerMove((p) => { lineMapHandle?.handlePointerMove?.(p.x, p.y); });
      const offClick = probe.onPointerClick((p) => { lineMapHandle?.handlePointerClick?.(p.x, p.y); });
      const offLeave = probe.onPointerLeave(() => { lineMapHandle?.handlePointerLeave?.(); });
      maplibreInteractionCleanup.push(offView, offSettled, offMove, offClick, offLeave);
      // overlay handle 创建后，重新附加底图切换控件到新的图层面板
      attachBasemapSwitcher(mapData);
      setBasemapStatus(basemapStatusFromMode(newMode), {
        mode: newMode,
        maplibreEnabled: true,
      });
      try {
        currentShowMessage?.(`已切换到${basemapModeLabel(newMode)}`);
      } catch { /* ignore */ }
    } catch (err) {
      debugWarn(DEBUG_LINE_MAP, '[MapLibre overlay] 切换底图失败，保持 Canvas-only', err);
      try {
        currentShowMessage?.(`切换到${basemapModeLabel(newMode)}失败`);
      } catch { /* ignore */ }
    }
  })();
}
