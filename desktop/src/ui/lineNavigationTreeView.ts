/**
 * 线路路线导航树投影。
 *
 * 线路默认树不直接渲染 CBM 的 F1/F2/F3/F4、Tower_Device、Wire_Device
 * 和 CROSS 叶节点，而是从同一份 GimGraph + LineMapData 生成业务投影：
 *
 *   工程 → 线路 → 区段 → 耐张段 → 杆塔 / 档距 → 导线 / 跨越物
 *
 * 这是一个纯 UI 适配器：不修改解析结果、不写数据库，也不创建第二份
 * 业务对象。每个投影行都保存一个真实 GimGraphNode 作为来源和选择回指。
 * 路线顺序优先使用塔号，缺少塔号时保持 CBM 源顺序；F3 边界复用的起始塔
 * 通过 WIRE 端点补入对应耐张段，避免截断“塔位—档距—塔位”链。
 */

import type { GimGraph, GimGraphNode } from '../gim/gimGraphTypes.js';
import type {
  CrossMarker,
  LineMapData,
  TowerMarker,
  WireSegment,
} from '../gim/lineMapData.js';
import type { LineAttributeIndex } from '../gim/lineAttributeTypes.js';
import { getFileNameLower, normalizeGimPath } from '../gim/linePathNormalize.js';
import type { SearchItem } from './searchBox.js';

export type LineNavigationKind =
  | 'project'
  | 'route'
  | 'section'
  | 'strain-section'
  | 'tower'
  | 'span'
  | 'wire'
  | 'crossing'
  | 'same-point'
  | 'unsegmented'
  | 'unassociated-crossings';

/** 一个档距的业务聚合。多条 WIRE 共用端点时只产生一个 span 行。 */
export interface LineSpanProjection {
  key: string;
  startTower?: TowerMarker;
  endTower?: TowerMarker;
  /** 档距下的导线、地线、OPGW 和未知线型。 */
  wires: WireSegment[];
  /** 同塔内部连接（POINT0 == POINT1），不伪装成跨塔档距。 */
  samePointWires: WireSegment[];
  crosses: LineCrossProjection[];
  /** 没有可解析端点或仅有原始 F4 WIRE 组时为 true。 */
  unresolved: boolean;
  sourcePaths: string[];
  ownerF3Paths: string[];
  representativeNode: GimGraphNode | null;
}

export interface LineCrossProjection {
  marker: CrossMarker;
  node: GimGraphNode;
  /** 名称优先来自 CROSS 子节点 FAM，其次为 CODE 辅助标签。 */
  title: string;
  subtitle: string;
  typeLabel: string;
  codes: string[];
  sourceNodes: GimGraphNode[];
}

export interface LineNavigationNode {
  key: string;
  kind: LineNavigationKind;
  label: string;
  subtitle: string;
  icon: string;
  node: GimGraphNode | null;
  children: LineNavigationNode[];
  /** 对象在来源图中的所有可搜索路径（含被聚合的 WIRE/F4/CROSS）。 */
  sourcePaths: string[];
  inferred?: boolean;
  tower?: TowerMarker;
  /** 导线明细行回指地图语义数据，供属性面板和地图联动使用。 */
  wire?: WireSegment;
  span?: LineSpanProjection;
  cross?: LineCrossProjection;
}

export interface LineNavigationStats {
  sectionCount: number;
  strainSectionCount: number;
  towerCount: number;
  spanCount: number;
  wireCount: number;
  crossCount: number;
  unassociatedCrossCount: number;
  unsegmentedCount: number;
  unresolvedWireCount: number;
}

export interface LineNavigationIndex {
  root: LineNavigationNode;
  route: LineNavigationNode;
  nodesByKey: Map<string, LineNavigationNode>;
  parentByKey: Map<string, string>;
  /** 来源路径 → 首个业务投影行；共享边界塔使用首次出现的行。 */
  targetBySourcePath: Map<string, string>;
  stats: LineNavigationStats;
}

export interface LineNavigationOptions {
  projectName?: string;
  /** F1/F2/F3/CROSS FAM 属性，用于线路名、跨越物名称和来源摘要。 */
  attrs?: LineAttributeIndex;
}

interface ParentIndex {
  parentByPath: Map<string, GimGraphNode>;
  f3ByPath: Map<string, GimGraphNode>;
  f4WireByWirePath: Map<string, GimGraphNode>;
  f4WireF3ByPath: Map<string, GimGraphNode>;
  f4CrossF3ByPath: Map<string, GimGraphNode>;
}

interface TowerEntry {
  group: GimGraphNode;
  marker?: TowerMarker;
  sourceOrder: number;
  orderValue: number | null;
}

interface SpanRecord {
  key: string;
  startPath?: string;
  endPath?: string;
  startCoord?: Coord;
  endCoord?: Coord;
  startTower?: TowerMarker;
  endTower?: TowerMarker;
  wires: WireSegment[];
  samePointWires: WireSegment[];
  crosses: LineCrossProjection[];
  unresolved: boolean;
  sourcePaths: Set<string>;
  ownerF3Paths: Set<string>;
  representativeNode: GimGraphNode | null;
}

interface Coord {
  lat: number;
  lng: number;
  elev?: number | null;
}

interface F3Record {
  node: GimGraphNode;
  towerPaths: Set<string>;
  spanKeys: Set<string>;
}

const PROJECT_KEY = 'line-navigation:project';

const WIRE_LABELS: Record<string, string> = {
  CONDUCTOR: '导线',
  GROUNDWIRE: '地线',
  OPGW: 'OPGW',
  UNKNOWN: '未知导线',
};

const CROSS_CODE_LABELS: Record<string, string> = {
  '201': '房屋',
  '191': '河流/水域',
  '1019': '树木',
  '523': '地下通信电缆',
};

const PLACEHOLDER_RE = /^(?:-|\$|NULL\d*|其它|其他|&其他|无|未命名)$/i;

/**
 * 构建线路业务导航索引。
 *
 * `mapData` 负责地图口径（129 塔位、2232 WIRE、44 个 CROSS 业务组），
 * graph 负责 F3/F4 的来源关系。二者联合后才可处理 F3 边界复用。
 */
export function buildLineNavigationIndex(
  graph: GimGraph,
  mapData: LineMapData,
  options: LineNavigationOptions = {},
): LineNavigationIndex {
  const parentIndex = buildParentIndex(graph);
  const f1 = findRouteNode(graph.root);
  const f2Nodes = f1 ? directOrDescendant(f1, 'F2System') : [];
  const allF3 = f2Nodes.flatMap((f2) => directOrDescendant(f2, 'F3System'));
  const f3Nodes = uniqueByPath(allF3);

  const towerEntries = collectTowerEntries(graph, mapData);
  const towerByPath = new Map(towerEntries.map((entry) => [entry.group.path, entry]));
  const towerOrder = buildTowerOrder(towerEntries);
  const towerByCoord = new Map<string, TowerEntry>();
  for (const entry of towerEntries) {
    if (entry.marker) towerByCoord.set(coordKey(entry.marker.lat, entry.marker.lng), entry);
  }
  const stringToTowerPath = buildStringTowerIndex(towerEntries);

  const spanRecords = buildSpanRecords(
    graph,
    mapData,
    parentIndex,
    towerByPath,
    towerByCoord,
    stringToTowerPath,
  );
  const spanByKey = new Map<string, SpanRecord>();
  for (const span of spanRecords) spanByKey.set(span.key, span);

  const crossProjections = mapData.crosses.map((marker) =>
    buildCrossProjection(marker, options.attrs),
  );
  // 以每个 F3 的真实来源关系归集塔位、档距和跨越物。F3 的 WIRE 端点可能指向前一段
  // 的塔，因此 spanRecord 的端点塔会补入 towerPaths。
  const f3Records = f3Nodes.map((node) => {
    const record: F3Record = {
      node,
      towerPaths: new Set<string>(),
      spanKeys: new Set<string>(),
    };
    for (const group of collectDescendantF4(node, parentIndex)) {
      if (group.rawProps['GROUPTYPE'] === 'TOWER') record.towerPaths.add(group.path);
      if (group.rawProps['GROUPTYPE'] === 'WIRE') {
        for (const span of spanRecords) {
          if (span.sourcePaths.has(group.path)) record.spanKeys.add(span.key);
        }
      }
    }
    // 也接收通过 WIRE 子节点登记的 F3 所有权。
    for (const span of spanRecords) {
      if (span.ownerF3Paths.has(node.path)) record.spanKeys.add(span.key);
      if (span.ownerF3Paths.has(node.path)) {
        if (span.startPath) record.towerPaths.add(span.startPath);
        if (span.endPath) record.towerPaths.add(span.endPath);
      }
    }
    return record;
  });

  const assignedSpanKeys = new Set<string>();
  const assignedCrossPaths = new Set<string>();
  const nodesByKey = new Map<string, LineNavigationNode>();
  const parentByKey = new Map<string, string>();
  const targetBySourcePath = new Map<string, string>();

  const routeNode = makeNode(
    routeKey(f1?.path || graph.root?.path || 'route'),
    'route',
    resolveLineName(f1, options),
    routeSubtitle(f1, mapData, towerEntries.length),
    '⌁',
    f1 || graph.root,
    [],
    f1 ? [f1.path] : [],
  );
  const rootNode = makeNode(
    PROJECT_KEY,
    'project',
    '线路工程',
    projectSubtitle(mapData, spanRecords),
    '⌂',
    graph.root,
    [],
    graph.root ? [graph.root.path] : [],
  );
  routeNode.children = [];
  registerNode(rootNode, nodesByKey, parentByKey, targetBySourcePath);
  registerNode(routeNode, nodesByKey, parentByKey, targetBySourcePath, rootNode.key);
  rootNode.children.push(routeNode);

  const sections: LineNavigationNode[] = [];
  const sourceSections = f2Nodes.length > 0 ? f2Nodes : [null];
  for (let sectionIndex = 0; sectionIndex < sourceSections.length; sectionIndex++) {
    const f2 = sourceSections[sectionIndex];
    const sectionF3 = f2
      ? f3Records.filter((record) => isDescendantOf(record.node, f2, parentIndex.parentByPath))
      : f3Records;
    const sectionStrains: LineNavigationNode[] = [];
    const sectionTowerPaths = new Set<string>();

    for (let f3Index = 0; f3Index < sectionF3.length; f3Index++) {
      const f3 = sectionF3[f3Index];
      const spans = Array.from(f3.spanKeys)
        .map((key) => spanByKey.get(key))
        .filter((span): span is SpanRecord => Boolean(span));
      const towerPaths = new Set(f3.towerPaths);
      for (const span of spans) {
        if (span.startPath) towerPaths.add(span.startPath);
        if (span.endPath) towerPaths.add(span.endPath);
      }
      const orderedTowerPaths = sortTowerPaths(Array.from(towerPaths), towerByPath, towerOrder);
      for (const path of orderedTowerPaths) sectionTowerPaths.add(path);

      const strainKey = strainSectionKey(f3.node.path, sectionIndex, f3Index);
      const strainChildren = buildStrainChildren(
        strainKey,
        orderedTowerPaths,
        spans,
        towerByPath,
        towerOrder,
        assignedSpanKeys,
        assignedCrossPaths,
        parentByKey,
        nodesByKey,
        targetBySourcePath,
      );
      const firstTower = firstTowerMarker(orderedTowerPaths, towerByPath, towerOrder);
      const lastTower = lastTowerMarker(orderedTowerPaths, towerByPath, towerOrder);
      const strainNode = makeNode(
        strainKey,
        'strain-section',
        rangeLabel(`耐张段 ${pad(f3Index + 1)}`, firstTower?.towerNumber, lastTower?.towerNumber),
        strainSubtitle(orderedTowerPaths.length, spans),
        '≋',
        f3.node,
        strainChildren,
        [f3.node.path],
      );
      strainNode.inferred = false;
      registerNode(strainNode, nodesByKey, parentByKey, targetBySourcePath);
      sectionStrains.push(strainNode);
    }

    // 没有 F3 时，只有在塔位/档距证据存在时生成一个明确的“顺序推断”段。
    if (sectionStrains.length === 0 && (towerEntries.length > 0 || spanRecords.length > 0)) {
      const fallbackSpans = spanRecords.filter((span) => span.ownerF3Paths.size === 0);
      const paths = sortTowerPaths(
        uniqueStrings(fallbackSpans.flatMap((span) => [span.startPath, span.endPath].filter(Boolean) as string[])),
        towerByPath,
        towerOrder,
      );
      const inferredKey = strainSectionKey(`inferred-${sectionIndex}`, sectionIndex, 0);
      const children = buildStrainChildren(
        inferredKey,
        paths,
        fallbackSpans,
        towerByPath,
        towerOrder,
        assignedSpanKeys,
        assignedCrossPaths,
        parentByKey,
        nodesByKey,
        targetBySourcePath,
      );
      const firstTower = firstTowerMarker(paths, towerByPath, towerOrder);
      const lastTower = lastTowerMarker(paths, towerByPath, towerOrder);
      const inferred = makeNode(
        inferredKey,
        'strain-section',
        `${rangeLabel(`耐张段 ${pad(1)}`, firstTower?.towerNumber, lastTower?.towerNumber)}（推断）`,
        '顺序来自塔号/坐标证据；原始 F3 不存在',
        '≋',
        f2 || f1 || graph.root,
        children,
        f2 ? [f2.path] : [],
      );
      inferred.inferred = true;
      registerNode(inferred, nodesByKey, parentByKey, targetBySourcePath);
      sectionStrains.push(inferred);
      for (const path of paths) sectionTowerPaths.add(path);
    }

    const sectionKey = sectionKeyFor(f2?.path, sectionIndex);
    const firstTower = firstTowerMarker(Array.from(sectionTowerPaths), towerByPath, towerOrder);
    const lastTower = lastTowerMarker(Array.from(sectionTowerPaths), towerByPath, towerOrder);
    const sectionNode = makeNode(
      sectionKey,
      'section',
      rangeLabel(`区段 ${pad(sectionIndex + 1)}`, firstTower?.towerNumber, lastTower?.towerNumber),
      sectionSubtitle(sectionStrains.length, sectionTowerPaths.size, f2),
      '▤',
      f2 || f1 || graph.root,
      sectionStrains,
      f2 ? [f2.path] : [],
    );
    if (!f2) sectionNode.inferred = true;
    registerNode(sectionNode, nodesByKey, parentByKey, targetBySourcePath, routeNode.key);
    for (const strain of sectionStrains) parentByKey.set(strain.key, sectionNode.key);
    routeNode.children.push(sectionNode);
    sections.push(sectionNode);
  }

  // 为 F3 归属不明确的档距补到“未分段对象”，保证数据不静默消失。
  const unsegmentedChildren: LineNavigationNode[] = [];
  for (const span of spanRecords) {
    if (assignedSpanKeys.has(span.key)) continue;
    const spanNode = buildSpanNode(span, parentByKey, nodesByKey, targetBySourcePath);
    unsegmentedChildren.push(spanNode);
    assignedSpanKeys.add(span.key);
  }
  for (const tower of towerEntries) {
    if (targetBySourcePath.has(tower.group.path)) continue;
    const towerNode = buildTowerNode(
      `${routeNode.key}:unsegmented:${encodeURIComponent(tower.group.path)}`,
      tower,
      parentByKey,
      nodesByKey,
      targetBySourcePath,
    );
    unsegmentedChildren.push(towerNode);
  }
  if (unsegmentedChildren.length > 0) {
    const unsegmented = makeNode(
      'line-navigation:unsegmented',
      'unsegmented',
      '未分段对象',
      `${unsegmentedChildren.length} 个对象 · 无可靠区段/耐张段归属`,
      '□',
      graph.root,
      unsegmentedChildren,
      [],
    );
    unsegmented.inferred = true;
    registerNode(unsegmented, nodesByKey, parentByKey, targetBySourcePath, routeNode.key);
    for (const child of unsegmentedChildren) parentByKey.set(child.key, unsegmented.key);
    routeNode.children.push(unsegmented);
  }

  // 可靠关联优先：只有显式端点/来源引用或足够区分度的坐标证据才挂到档距。
  for (const cross of crossProjections) {
    if (assignedCrossPaths.has(cross.marker.cbmPath)) continue;
    const ownerF3 = parentIndex.f4CrossF3ByPath.get(cross.marker.cbmPath);
    const candidates = ownerF3
      ? spanRecords.filter((span) => span.ownerF3Paths.has(ownerF3.path) && !span.samePointWires.length)
      : [];
    const selected = chooseCrossSpan(cross, candidates, towerByPath, stringToTowerPath);
    if (selected) {
      selected.crosses.push(cross);
      assignedCrossPaths.add(cross.marker.cbmPath);
      selected.sourcePaths.add(cross.marker.cbmPath);
    }
  }

  // 跨越物必须保留；没有可靠档距关系时使用唯一待关联组，不按 CROSS 叶节点展开。
  const pendingCrosses = crossProjections.filter((cross) => !assignedCrossPaths.has(cross.marker.cbmPath));
  if (pendingCrosses.length > 0) {
    const pendingChildren = pendingCrosses.map((cross) => buildCrossNode(
      `line-navigation:pending-cross:${encodeURIComponent(cross.marker.cbmPath)}`,
      cross,
      parentByKey,
      nodesByKey,
      targetBySourcePath,
    ));
    const pending = makeNode(
      'line-navigation:unassociated-crossings',
      'unassociated-crossings',
      '待关联跨越物',
      `${pendingChildren.length} 个业务跨越物 · 关系未确认`,
      '⚠',
      graph.root,
      pendingChildren,
      [],
    );
    registerNode(pending, nodesByKey, parentByKey, targetBySourcePath, routeNode.key);
    for (const child of pendingChildren) parentByKey.set(child.key, pending.key);
    routeNode.children.push(pending);
  }

  // 跨越物在 span 归属确定后才生成 span 子项，因此重新同步已注册 span 行的 children/labels。
  for (const node of nodesByKey.values()) {
    if (node.kind !== 'span' || !node.span) continue;
    refreshSpanNode(node, node.span, parentByKey, nodesByKey, targetBySourcePath);
  }

  // 构建 parentByKey 的 root/route 链，且删除上述注册时为兼容预留的空父键。
  parentByKey.set(routeNode.key, rootNode.key);
  for (const section of sections) {
    registerParentLinks(section, routeNode.key, parentByKey);
  }
  const unsegmentedNode = nodesByKey.get('line-navigation:unsegmented');
  if (unsegmentedNode) {
    registerParentLinks(unsegmentedNode, routeNode.key, parentByKey);
  }
  const pendingNode = nodesByKey.get('line-navigation:unassociated-crossings');
  if (pendingNode) {
    registerParentLinks(pendingNode, routeNode.key, parentByKey);
  }

  // 来源按钮通常携带的是 Tower_Device/Wire_Device 等隐藏 CBM 子节点，
  // 而导航树只渲染杆塔、档距、导线和跨越物等业务投影行。将未直接登记的
  // 图节点沿 CBM 父链回溯到最近已登记行，保证 CBM/DEV/FAM/PHM/MOD/STL
  // 等引用都能定位到可见业务节点；缓存恢复或目录大小写变化也走同一索引。
  registerGraphSourceAliases(graph, parentIndex, targetBySourcePath);

  const stats: LineNavigationStats = {
    sectionCount: sections.length,
    strainSectionCount: nodesByKind(rootNode, 'strain-section').length,
    towerCount: towerEntries.length,
    // “档距”只统计跨塔连接；同塔内部连接单独显示在塔位下，不混入档距计数。
    spanCount: spanRecords.filter((span) => span.wires.length > 0 || (span.unresolved && span.samePointWires.length === 0)).length,
    wireCount: mapData.stats.wireTotal,
    crossCount: crossProjections.length,
    unassociatedCrossCount: pendingCrosses.length,
    unsegmentedCount: unsegmentedChildren.length,
    unresolvedWireCount: mapData.unresolved.wires.length,
  };

  return { root: rootNode, route: routeNode, nodesByKey, parentByKey, targetBySourcePath, stats };
}

/** 构建路线树搜索索引；业务名称优先，来源路径作为可搜索别名。 */
export function buildLineNavigationSearchIndex(index: LineNavigationIndex): SearchItem[] {
  const items: SearchItem[] = [];
  const seen = new Set<string>();
  const push = (item: SearchItem): void => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };
  for (const node of index.nodesByKey.values()) {
    if (node.kind === 'project') continue;
    push({
      key: node.key,
      title: node.label,
      subtitle: [kindLabel(node.kind), node.subtitle].filter(Boolean).join(' · '),
    });
    for (const sourcePath of node.sourcePaths) {
      if (!sourcePath || sourcePath === node.key) continue;
      push({
        key: sourcePath,
        title: node.label,
        subtitle: `来源 · ${kindLabel(node.kind)} · ${sourcePath}`,
      });
    }
  }
  return items;
}

/** 把搜索/地图传入的业务键或来源 path 解析到渲染行键。 */
export function resolveLineNavigationTarget(
  index: LineNavigationIndex,
  key: string,
): LineNavigationNode | null {
  const rowKey = index.nodesByKey.has(key) ? key : findSourceTargetKey(index.targetBySourcePath, key);
  return rowKey ? index.nodesByKey.get(rowKey) || null : null;
}

/**
 * 搜索命中后只展开工程根到命中行的祖先链。
 * 返回渲染行键；调用方可以随后加 selected/scrollIntoView。
 */
export function revealLineNavigationTarget(
  index: LineNavigationIndex,
  key: string,
): string | null {
  const target = resolveLineNavigationTarget(index, key);
  if (!target) return null;
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = target.key;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = index.parentByKey.get(current);
  }
  chain.reverse();
  for (const rowKey of chain) ensureLineNavigationRowExpanded(rowKey);
  return target.key;
}

/** 渲染线路树。工程根、线路和区段默认展开；耐张段及明细按需展开。 */
export function renderLineNavigationTree(
  index: LineNavigationIndex,
  parentEl: HTMLElement,
  onNodeClick: (node: LineNavigationNode) => void,
): void {
  parentEl.innerHTML = '';
  renderNode(index.root, parentEl, onNodeClick, true);
}

function renderNode(
  node: LineNavigationNode,
  parentEl: HTMLElement,
  onNodeClick: (node: LineNavigationNode) => void,
  initiallyExpanded = false,
): void {
  const nodeEl = document.createElement('div');
  nodeEl.className = `tree-node line-navigation-node line-navigation-${node.kind}`;
  nodeEl.dataset.navigationKey = node.key;

  const row = document.createElement('div');
  row.className = 'tree-row line-navigation-row';
  row.dataset.nodePath = node.key;
  row.setAttribute('role', 'treeitem');
  row.tabIndex = 0;
  // 导航树的 tooltip 只保留业务语义；GUID/完整路径由右侧“来源”页签
  // 的可读按钮承载，避免用户在树上被技术文件名干扰。
  row.title = [node.label, node.subtitle].filter(Boolean).join(' · ');

  const hasChildren = node.children.length > 0;
  const toggle = document.createElement(hasChildren ? 'button' : 'span');
  toggle.className = `tree-toggle ${hasChildren ? '' : 'leaf'}`;
  toggle.textContent = '▶';
  if (hasChildren) {
    const button = toggle as HTMLButtonElement;
    button.type = 'button';
    button.dataset.toggleKey = node.key;
    button.setAttribute('aria-label', `展开或折叠 ${node.label}`);
    row.setAttribute('aria-expanded', 'false');
  }

  const icon = document.createElement('span');
  icon.className = 'tree-icon line-navigation-icon';
  icon.textContent = node.icon;
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'tree-label line-navigation-label';
  label.textContent = node.label;
  label.title = node.subtitle;
  const meta = document.createElement('span');
  meta.className = 'line-navigation-meta';
  // 线路树只显示业务标签；长度、分裂数、来源路径等细节在 tooltip/属性面板中查看。
  meta.textContent = '';
  meta.title = node.subtitle;
  meta.setAttribute('aria-hidden', 'true');

  row.append(toggle, icon, label, meta);
  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  nodeEl.append(row, childrenEl);

  let expanded = false;
  let rendered = false;
  const setExpanded = (next: boolean): void => {
    if (!hasChildren) return;
    expanded = next;
    toggle.classList.toggle('expanded', expanded);
    childrenEl.classList.toggle('expanded', expanded);
    row.setAttribute('aria-expanded', String(expanded));
    if (expanded && !rendered) {
      for (const child of node.children) {
        // 工程根、线路和区段默认展开；耐张段及明细按需生成，避免首屏铺开大量对象。
        renderNode(child, childrenEl, onNodeClick, child.kind === 'route' || child.kind === 'section');
      }
      rendered = true;
    }
  };
  if (hasChildren) {
    (toggle as HTMLButtonElement).addEventListener('click', (event) => {
      event.stopPropagation();
      setExpanded(!expanded);
    });
  }
  row.addEventListener('click', () => {
    parentEl.closest('[role="tree"]')?.querySelectorAll('.tree-row.selected').forEach((item) => item.classList.remove('selected'));
    document.querySelectorAll('.line-navigation-row.selected').forEach((item) => item.classList.remove('selected'));
    row.classList.add('selected');
    onNodeClick(node);
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      row.click();
    } else if (event.key === 'ArrowRight' && hasChildren && !expanded) {
      event.preventDefault();
      setExpanded(true);
    } else if (event.key === 'ArrowLeft' && hasChildren && expanded) {
      event.preventDefault();
      setExpanded(false);
    }
  });

  parentEl.appendChild(nodeEl);
  if (initiallyExpanded) setExpanded(true);
}

function buildParentIndex(graph: GimGraph): ParentIndex {
  const parentByPath = new Map<string, GimGraphNode>();
  const f3ByPath = new Map<string, GimGraphNode>();
  const f4WireByWirePath = new Map<string, GimGraphNode>();
  const f4WireF3ByPath = new Map<string, GimGraphNode>();
  const f4CrossF3ByPath = new Map<string, GimGraphNode>();
  const walk = (node: GimGraphNode, f3: GimGraphNode | null): void => {
    const ownF3 = node.entityName === 'F3System' ? node : f3;
    if (ownF3) f3ByPath.set(node.path, ownF3);
    for (const child of node.children) {
      parentByPath.set(child.path, node);
      if (node.entityName === 'F4System' && node.rawProps['GROUPTYPE'] === 'WIRE') {
        f4WireByWirePath.set(child.path, node);
        if (ownF3) f4WireF3ByPath.set(node.path, ownF3);
      }
      if (node.entityName === 'F4System' && node.rawProps['GROUPTYPE'] === 'CROSS' && ownF3) {
        f4CrossF3ByPath.set(node.path, ownF3);
      }
      walk(child, ownF3);
    }
  };
  if (graph.root) walk(graph.root, null);
  return { parentByPath, f3ByPath, f4WireByWirePath, f4WireF3ByPath, f4CrossF3ByPath };
}

function findRouteNode(root: GimGraphNode | null): GimGraphNode | null {
  if (!root) return null;
  if (root.entityName === 'F1System') return root;
  return root.children.find((child) => child.entityName === 'F1System')
    || firstDescendant(root, (node) => node.entityName === 'F1System');
}

function directOrDescendant(node: GimGraphNode, entityName: string): GimGraphNode[] {
  const direct = node.children.filter((child) => child.entityName === entityName);
  if (direct.length > 0) return uniqueByPath(direct);
  return collectDescendants(node, (child) => child.entityName === entityName);
}

function collectDescendantF4(node: GimGraphNode, parentIndex: ParentIndex): GimGraphNode[] {
  // 线路 F3 下的 F4 正常为直接子项；递归兜底兼容导出器增加的中间组。
  return collectDescendants(node, (child) => child.entityName === 'F4System'
    && ['TOWER', 'WIRE', 'CROSS'].includes(child.rawProps['GROUPTYPE'] || ''))
    .filter((child) => parentIndex.f3ByPath.get(child.path)?.path === node.path);
}

function collectTowerEntries(graph: GimGraph, mapData: LineMapData): TowerEntry[] {
  const markersByPath = new Map(mapData.towers.map((tower) => [tower.nodeRef.path, tower]));
  const entries: TowerEntry[] = [];
  const seen = new Set<string>();
  let order = 0;
  const walk = (node: GimGraphNode): void => {
    if (node.entityName === 'F4System' && node.rawProps['GROUPTYPE'] === 'TOWER' && !seen.has(node.path)) {
      seen.add(node.path);
      const marker = markersByPath.get(node.path);
      entries.push({ group: node, marker, sourceOrder: order++, orderValue: parseTowerNumber(marker?.towerNumber) });
    }
    for (const child of node.children) walk(child);
  };
  if (graph.root) walk(graph.root);
  // 缓存恢复时 graph.nodesByPath 仍可能包含 source tree 未挂载的节点，补齐可见塔位。
  for (const marker of mapData.towers) {
    if (seen.has(marker.nodeRef.path)) continue;
    seen.add(marker.nodeRef.path);
    entries.push({ group: marker.nodeRef, marker, sourceOrder: order++, orderValue: parseTowerNumber(marker.towerNumber) });
  }
  return entries;
}

function buildTowerOrder(entries: TowerEntry[]): Map<string, number> {
  const sortable = entries.every((entry) => entry.orderValue != null);
  const ordered = entries.slice().sort((a, b) => {
    if (sortable && a.orderValue != null && b.orderValue != null && a.orderValue !== b.orderValue) {
      return a.orderValue - b.orderValue;
    }
    return a.sourceOrder - b.sourceOrder;
  });
  return new Map(ordered.map((entry, index) => [entry.group.path, index]));
}

function buildStringTowerIndex(entries: TowerEntry[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of entries) {
    result.set(entry.group.path.toLowerCase(), entry.group.path);
    result.set(getFileNameLower(entry.group.path), entry.group.path);
    for (const child of entry.group.children) {
      result.set(child.path.toLowerCase(), entry.group.path);
      result.set(getFileNameLower(child.path), entry.group.path);
    }
    for (const value of Object.entries(entry.group.rawProps)) {
      if (!value[0].startsWith('STRING') || !value[0].endsWith('.STRING')) continue;
      const filename = fileName(value[1]);
      if (filename) result.set(filename.toLowerCase(), entry.group.path);
    }
  }
  return result;
}

function buildSpanRecords(
  graph: GimGraph,
  mapData: LineMapData,
  parentIndex: ParentIndex,
  towerByPath: Map<string, TowerEntry>,
  towerByCoord: Map<string, TowerEntry>,
  stringToTowerPath: Map<string, string>,
): SpanRecord[] {
  const records = new Map<string, SpanRecord>();
  const mappedWirePaths = new Set<string>();
  const towerPathForCoord = (coord: Coord | undefined): string | undefined => {
    if (!coord) return undefined;
    return towerByCoord.get(coordKey(coord.lat, coord.lng))?.group.path;
  };
  const resolveRef = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const fn = fileName(value).toLowerCase();
    return stringToTowerPath.get(fn) || stringToTowerPath.get(value.toLowerCase());
  };
  const addWire = (wire: WireSegment): void => {
    mappedWirePaths.add(wire.nodeRef.path);
    const group = parentIndex.f4WireByWirePath.get(wire.nodeRef.path);
    const startCoord = coordFromWire(wire, true);
    const endCoord = coordFromWire(wire, false);
    let startPath = towerPathForCoord(startCoord);
    let endPath = towerPathForCoord(endCoord);
    if (group) {
      startPath = startPath || resolveRef(group.rawProps['BACKSTRING']);
      endPath = endPath || resolveRef(group.rawProps['FRONTSTRING']);
    }
    const samePoint = wire.groupKind === 'same-point'
      || (startCoord && endCoord && coordKey(startCoord.lat, startCoord.lng) === coordKey(endCoord.lat, endCoord.lng));
    const startIdentity = startPath || coordKeyFromCoord(startCoord) || `wire:${wire.nodeRef.path}:start`;
    const endIdentity = endPath || coordKeyFromCoord(endCoord) || `wire:${wire.nodeRef.path}:end`;
    const key = samePoint
      ? `same:${startIdentity}`
      : `span:${[startIdentity, endIdentity].sort().join('~')}`;
    let record = records.get(key);
    if (!record) {
      record = {
        key,
        startPath,
        endPath,
        startCoord,
        endCoord,
        startTower: startPath ? towerByPath.get(startPath)?.marker : undefined,
        endTower: endPath ? towerByPath.get(endPath)?.marker : undefined,
        wires: [],
        samePointWires: [],
        crosses: [],
        unresolved: !startPath || !endPath,
        sourcePaths: new Set<string>(),
        ownerF3Paths: new Set<string>(),
        representativeNode: wire.nodeRef,
      };
      records.set(key, record);
    }
    if (samePoint) record.samePointWires.push(wire);
    else record.wires.push(wire);
    record.sourcePaths.add(wire.nodeRef.path);
    if (group) {
      record.sourcePaths.add(group.path);
      const f3 = parentIndex.f4WireF3ByPath.get(group.path);
      if (f3) record.ownerF3Paths.add(f3.path);
    }
    record.startPath = record.startPath || startPath;
    record.endPath = record.endPath || endPath;
    record.startCoord = record.startCoord || startCoord;
    record.endCoord = record.endCoord || endCoord;
    record.startTower = record.startTower || (startPath ? towerByPath.get(startPath)?.marker : undefined);
    record.endTower = record.endTower || (endPath ? towerByPath.get(endPath)?.marker : undefined);
    record.unresolved = record.unresolved || !startPath || !endPath;
  };
  for (const wire of mapData.wires) addWire(wire);

  // mapData.unresolved.wires 没有 WIRE 节点，不能凭空创建档距；但仍将只有 F4 WIRE
  // 组且没有可提取 WIRE 的情况显示为“未解析档距”。
  const walk = (node: GimGraphNode): void => {
    if (node.entityName === 'F4System' && node.rawProps['GROUPTYPE'] === 'WIRE') {
      const hasMapped = node.children.some((child) => mappedWirePaths.has(child.path));
      if (!hasMapped) {
        const startPath = stringToTowerPath.get(fileName(node.rawProps['BACKSTRING'] || '').toLowerCase());
        const endPath = stringToTowerPath.get(fileName(node.rawProps['FRONTSTRING'] || '').toLowerCase());
        const startIdentity = startPath || `f4:${node.path}:start`;
        const endIdentity = endPath || `f4:${node.path}:end`;
        const key = `span:${[startIdentity, endIdentity].sort().join('~')}:${encodeURIComponent(node.path)}`;
        const f3 = parentIndex.f4WireF3ByPath.get(node.path);
        records.set(key, {
          key,
          startPath,
          endPath,
          startTower: startPath ? towerByPath.get(startPath)?.marker : undefined,
          endTower: endPath ? towerByPath.get(endPath)?.marker : undefined,
          wires: [],
          samePointWires: [],
          crosses: [],
          unresolved: true,
          sourcePaths: new Set([node.path]),
          ownerF3Paths: new Set(f3 ? [f3.path] : []),
          representativeNode: node,
        });
      }
    }
    for (const child of node.children) walk(child);
  };
  if (graph.root) walk(graph.root);
  return Array.from(records.values());
}

function buildCrossProjection(marker: CrossMarker, attrs?: LineAttributeIndex): LineCrossProjection {
  const node = marker.nodeRef;
  const sourceNodes = collectDescendants(node, (child) => child.entityName === 'CROSS');
  const codes = uniqueStrings(sourceNodes.map((child) => child.rawProps['CODE']).filter(Boolean));
  const names = uniqueStrings(sourceNodes.flatMap((child) => {
    const propMap = lookupFamMap(child.refs.famFiles, attrs);
    return [
      firstProp(propMap, ['NAME', 'CROSSNAME', 'HOUSETYPE', 'TREETYPE', 'WIRETYPE']),
    ].filter((value): value is string => Boolean(value && !PLACEHOLDER_RE.test(value)));
  }));
  const codeLabels = codes.map((code) => CROSS_CODE_LABELS[code] || `代码 ${code}`);
  const typeLabel = uniqueStrings([...names, ...codeLabels]).join('/') || '其他跨越物';
  const position = marker.lat != null && marker.lng != null ? '可定位' : '无法定位';
  const title = `跨越物 · ${typeLabel}`;
  const subtitle = `${position}${sourceNodes.length > 1 ? ` · ${sourceNodes.length} 个来源对象` : ''}`;
  return { marker, node, title, subtitle, typeLabel, codes, sourceNodes };
}

function buildStrainChildren(
  strainKey: string,
  orderedTowerPaths: string[],
  spans: SpanRecord[],
  towerByPath: Map<string, TowerEntry>,
  towerOrder: Map<string, number>,
  assignedSpanKeys: Set<string>,
  assignedCrossPaths: Set<string>,
  parentByKey: Map<string, string>,
  nodesByKey: Map<string, LineNavigationNode>,
  targetBySourcePath: Map<string, string>,
): LineNavigationNode[] {
  const children: LineNavigationNode[] = [];
  const consumed = new Set<string>();
  for (let index = 0; index < orderedTowerPaths.length; index++) {
    const path = orderedTowerPaths[index];
    const tower = towerByPath.get(path);
    if (tower) {
      const towerNode = buildTowerNode(
        `${strainKey}:tower:${encodeURIComponent(path)}`,
        tower,
        parentByKey,
        nodesByKey,
        targetBySourcePath,
      );
      // 同塔 WIRE 是内部连接，透明地挂在塔位下，而不是伪造一个跨塔档距。
      const samePointSpans = spans.filter((span) =>
        span.samePointWires.length > 0 && (span.startPath === path || span.endPath === path),
      );
      for (const samePoint of samePointSpans) {
        const sameNode = buildSamePointNode(
          `${towerNode.key}:same:${encodeURIComponent(samePoint.key)}`,
          samePoint,
          parentByKey,
          nodesByKey,
          targetBySourcePath,
        );
        towerNode.children.push(sameNode);
        parentByKey.set(sameNode.key, towerNode.key);
        consumed.add(samePoint.key);
        assignedSpanKeys.add(samePoint.key);
      }
      children.push(towerNode);
    }

    const nextPath = orderedTowerPaths[index + 1];
    if (!nextPath) continue;
    const between = spans.filter((span) =>
      !span.samePointWires.length
      && connects(span, path, nextPath)
      && !consumed.has(span.key),
    );
    for (const span of between) {
      const spanNode = buildSpanNode(span, parentByKey, nodesByKey, targetBySourcePath);
      children.push(spanNode);
      parentByKey.set(spanNode.key, strainKey);
      consumed.add(span.key);
      assignedSpanKeys.add(span.key);
      for (const cross of span.crosses) assignedCrossPaths.add(cross.marker.cbmPath);
      for (const source of span.sourcePaths) targetBySourcePath.set(source, spanNode.key);
    }
  }

  // 非相邻分支或缺少塔号的档距仍放在耐张段末尾，保持来源和质量信息可见。
  const remaining = spans
    .filter((span) => !consumed.has(span.key))
    .sort(compareSpansByOrder(towerOrder));
  for (const span of remaining) {
    if (span.samePointWires.length > 0) continue;
    const spanNode = buildSpanNode(span, parentByKey, nodesByKey, targetBySourcePath);
    children.push(spanNode);
    parentByKey.set(spanNode.key, strainKey);
    consumed.add(span.key);
    assignedSpanKeys.add(span.key);
    for (const cross of span.crosses) assignedCrossPaths.add(cross.marker.cbmPath);
  }
  return children;
}

function buildTowerNode(
  key: string,
  entry: TowerEntry,
  parentByKey: Map<string, string>,
  nodesByKey: Map<string, LineNavigationNode>,
  targetBySourcePath: Map<string, string>,
): LineNavigationNode {
  const marker = entry.marker;
  // 文件名（例如 f8.cbm）是来源证据，不是用户可读的塔位编号。
  // 没有 FAM/DEV 编号时使用稳定的来源顺序，避免把路径泄漏到主树。
  const number = normalizeTowerNumber(marker?.towerNumber)
    || normalizeTowerNumber(towerNumberFromNode(entry.group))
    || `杆塔 ${pad(entry.sourceOrder + 1)}`;
  const quality = marker ? qualityLabel(marker.dataQuality) : '无法定位';
  const details = [marker?.towerType, quality].filter(Boolean).join(' · ');
  const label = number.startsWith('杆塔 ') ? number : `${number} 杆塔`;
  const node = makeNode(key, 'tower', label, details || '塔型未提供', '●', entry.group, [], [entry.group.path]);
  node.tower = marker;
  registerNode(node, nodesByKey, parentByKey, targetBySourcePath);
  return node;
}

function buildSpanNode(
  span: SpanRecord,
  parentByKey: Map<string, string>,
  nodesByKey: Map<string, LineNavigationNode>,
  targetBySourcePath: Map<string, string>,
): LineNavigationNode {
  const key = `line-navigation:span:${encodeURIComponent(span.key)}`;
  const label = spanLabel(span);
  const subtitle = spanSubtitle(span);
  const node = makeNode(key, 'span', label, subtitle, '—', span.representativeNode, [], Array.from(span.sourcePaths));
  node.span = toSpanProjection(span);
  registerNode(node, nodesByKey, parentByKey, targetBySourcePath);
  refreshSpanNode(node, node.span, parentByKey, nodesByKey, targetBySourcePath);
  return node;
}

function refreshSpanNode(
  node: LineNavigationNode,
  span: LineSpanProjection,
  parentByKey: Map<string, string>,
  nodesByKey: Map<string, LineNavigationNode>,
  targetBySourcePath: Map<string, string>,
): void {
  node.children = [];
  for (const wire of span.wires.slice().sort(compareWireTypes)) {
    const type = (wire.wireType || 'UNKNOWN').toUpperCase();
    const split = wire.split ? ` · 分裂 ${wire.split}` : '';
    const wireNode = makeNode(
      `${node.key}:wire:${encodeURIComponent(wire.nodeRef.path)}`,
      'wire',
      WIRE_LABELS[type] || '未知导线',
      `${wire.spanMeters != null ? `${wire.spanMeters.toFixed(1)} m` : '档距未计算'}${split}`,
      type === 'OPGW' ? '○' : type === 'GROUNDWIRE' ? '·' : '╱',
      wire.nodeRef,
      [],
      [wire.nodeRef.path],
    );
    wireNode.wire = wire;
    node.children.push(wireNode);
    registerNode(wireNode, nodesByKey, parentByKey, targetBySourcePath, node.key);
  }
  for (const cross of span.crosses) {
    const crossNode = buildCrossNode(
      `${node.key}:cross:${encodeURIComponent(cross.marker.cbmPath)}`,
      cross,
      parentByKey,
      nodesByKey,
      targetBySourcePath,
      node.key,
    );
    node.children.push(crossNode);
  }
}

function buildSamePointNode(
  key: string,
  span: SpanRecord,
  parentByKey: Map<string, string>,
  nodesByKey: Map<string, LineNavigationNode>,
  targetBySourcePath: Map<string, string>,
): LineNavigationNode {
  const types = uniqueStrings(span.samePointWires.map((wire) => (wire.wireType || 'UNKNOWN').toUpperCase()));
  const node = makeNode(
    key,
    'same-point',
    `同塔连接 · ${types.map((type) => WIRE_LABELS[type] || type).join('/') || '导线'}`,
    `${span.samePointWires.length} 条内部连接 · 不计入跨塔档距`,
    '·',
    span.representativeNode,
    [],
    Array.from(span.sourcePaths),
  );
  node.span = toSpanProjection(span);
  registerNode(node, nodesByKey, parentByKey, targetBySourcePath);
  for (const wire of span.samePointWires.slice().sort(compareWireTypes)) {
    const wireNode = makeNode(
      `${node.key}:wire:${encodeURIComponent(wire.nodeRef.path)}`,
      'wire',
        WIRE_LABELS[(wire.wireType || 'UNKNOWN').toUpperCase()] || '未知导线',
      wire.split ? `分裂 ${wire.split}` : '同塔内部连接',
      '╱',
      wire.nodeRef,
      [],
      [wire.nodeRef.path],
    );
    wireNode.wire = wire;
    node.children.push(wireNode);
    registerNode(wireNode, nodesByKey, parentByKey, targetBySourcePath, node.key);
  }
  return node;
}

function buildCrossNode(
  key: string,
  cross: LineCrossProjection,
  parentByKey: Map<string, string>,
  nodesByKey: Map<string, LineNavigationNode>,
  targetBySourcePath: Map<string, string>,
  parentKey?: string,
): LineNavigationNode {
  const node = makeNode(key, 'crossing', cross.title, cross.subtitle, '✕', cross.node, [], [
    cross.marker.cbmPath,
    ...cross.sourceNodes.map((source) => source.path),
  ]);
  node.cross = cross;
  registerNode(node, nodesByKey, parentByKey, targetBySourcePath, parentKey);
  return node;
}

function toSpanProjection(span: SpanRecord): LineSpanProjection {
  return {
    key: span.key,
    startTower: span.startTower,
    endTower: span.endTower,
    wires: span.wires,
    samePointWires: span.samePointWires,
    crosses: span.crosses,
    unresolved: span.unresolved,
    sourcePaths: Array.from(span.sourcePaths),
    ownerF3Paths: Array.from(span.ownerF3Paths),
    representativeNode: span.representativeNode,
  };
}

function makeNode(
  key: string,
  kind: LineNavigationKind,
  label: string,
  subtitle: string,
  icon: string,
  node: GimGraphNode | null | undefined,
  children: LineNavigationNode[],
  sourcePaths: string[],
): LineNavigationNode {
  return {
    key,
    kind,
    label,
    subtitle,
    icon,
    node: node || null,
    children,
    sourcePaths: uniqueStrings(sourcePaths),
  };
}

function registerNode(
  node: LineNavigationNode,
  nodesByKey: Map<string, LineNavigationNode>,
  parentByKey: Map<string, string>,
  targetBySourcePath: Map<string, string>,
  parentKey?: string,
): void {
  nodesByKey.set(node.key, node);
  if (parentKey) parentByKey.set(node.key, parentKey);
  for (const sourcePath of node.sourcePaths) {
    if (!sourcePath) continue;
    registerSourceAlias(targetBySourcePath, sourcePath, node.key);
  }
}

/** 为来源路径登记原文、归一化路径和小写路径三个等价键。 */
function registerSourceAlias(
  targetBySourcePath: Map<string, string>,
  sourcePath: string,
  targetKey: string,
): void {
  const normalized = normalizeGimPath(sourcePath);
  const aliases = uniqueStrings([sourcePath, normalized, normalized.toLowerCase()]);
  for (const alias of aliases) {
    if (alias && !targetBySourcePath.has(alias)) targetBySourcePath.set(alias, targetKey);
  }
}

/**
 * 在图树完成业务投影后，为隐藏 CBM 子节点补最近可见业务祖先别名。
 *
 * 例如：`Tower_Device → F4System(GROUPTYPE=TOWER)` 会映射到“杆塔”行；
 * `WIRE → F4System(GROUPTYPE=WIRE) → F3System` 会优先命中“档距/导线”行。
 * 不覆盖已登记的精确来源，避免共享边界塔被错误改指到后一段。
 */
function registerGraphSourceAliases(
  graph: GimGraph,
  parentIndex: ParentIndex,
  targetBySourcePath: Map<string, string>,
): void {
  for (const graphNode of graph.nodesByPath.values()) {
    if (findSourceTargetKey(targetBySourcePath, graphNode.path)) continue;
    const seen = new Set<string>();
    let current: GimGraphNode | undefined = parentIndex.parentByPath.get(graphNode.path);
    while (current && !seen.has(current.path)) {
      seen.add(current.path);
      const targetKey = findSourceTargetKey(targetBySourcePath, current.path);
      if (targetKey) {
        registerSourceAlias(targetBySourcePath, graphNode.path, targetKey);
        break;
      }
      current = parentIndex.parentByPath.get(current.path);
    }
  }
}

/** 精确、斜杠归一化、大小写不敏感地查找来源路径对应的投影行。 */
function findSourceTargetKey(
  targetBySourcePath: Map<string, string>,
  sourcePath: string,
): string | undefined {
  if (!sourcePath) return undefined;
  const direct = targetBySourcePath.get(sourcePath);
  if (direct) return direct;
  const normalized = normalizeGimPath(sourcePath);
  if (!normalized) return undefined;
  const directNormalized = targetBySourcePath.get(normalized)
    || targetBySourcePath.get(normalized.toLowerCase());
  if (directNormalized) return directNormalized;

  // 部分来源记录只保留裸文件名（例如 `abc.cbm`），而解压后的图节点带有
  // `Cbm/` 前缀。文件名是 GUID，按文件名兜底不会把不同业务对象混淆；若
  // 未来出现同名文件，仍优先使用上面的完整路径匹配。
  const fileName = getFileNameLower(normalized);
  if (!fileName) return undefined;
  for (const [source, target] of targetBySourcePath) {
    if (getFileNameLower(source) === fileName) return target;
  }
  return undefined;
}

/** 在所有投影行完成后补齐父链，覆盖懒加载明细（塔位、档距、导线、跨越物）。 */
function registerParentLinks(
  node: LineNavigationNode,
  parentKey: string | undefined,
  parentByKey: Map<string, string>,
): void {
  if (parentKey) parentByKey.set(node.key, parentKey);
  for (const child of node.children) registerParentLinks(child, node.key, parentByKey);
}

function chooseCrossSpan(
  cross: LineCrossProjection,
  candidates: SpanRecord[],
  towerByPath: Map<string, TowerEntry>,
  stringToTowerPath: Map<string, string>,
): SpanRecord | null {
  if (candidates.length === 0) return null;
  const raw = cross.node.rawProps;
  const refs = [
    raw['BACKSTRING'], raw['FRONTSTRING'], raw['SPAN'], raw['SPANREF'], raw['WIRE'],
    raw['WIREGROUP'], raw['TOWER0'], raw['TOWER1'], raw['STARTTOWER'], raw['ENDTOWER'],
  ].filter(Boolean);
  if (refs.length > 0) {
    const towerPaths = refs
      .map((value) => fileName(value).toLowerCase())
      .map((value) => stringToTowerPath.get(value) || value)
      .filter((value) => towerByPath.has(value));
    const byTowers = candidates.filter((span) =>
      towerPaths.some((path) => path === span.startPath || path === span.endPath),
    );
    if (byTowers.length === 1) return byTowers[0];
    const bySource = candidates.filter((span) => refs.some((ref) => span.sourcePaths.has(ref)));
    if (bySource.length === 1) return bySource[0];
  }
  if (cross.marker.lat != null && cross.marker.lng != null) {
    const scored = candidates
      .map((span) => ({ span, distance: pointToSpanMeters(cross.marker.lat as number, cross.marker.lng as number, span) }))
      .filter((item) => Number.isFinite(item.distance))
      .sort((a, b) => a.distance - b.distance);
    if (scored.length > 0 && scored[0].distance <= 250) {
      if (scored.length === 1 || scored[1].distance - scored[0].distance >= 25) return scored[0].span;
    }
  }
  // 没有坐标或显式端点引用时不做“唯一档距”猜测。
  // 线路样本中的 CROSS 业务组普遍缺少 BLHA，必须进入待关联组，避免把
  // “同一耐张段只有一个档距”误报成已确认关系。
  return null;
}

function pointToSpanMeters(lat: number, lng: number, span: SpanRecord): number {
  const start = span.startTower || (span.startCoord ? { lat: span.startCoord.lat, lng: span.startCoord.lng } : null);
  const end = span.endTower || (span.endCoord ? { lat: span.endCoord.lat, lng: span.endCoord.lng } : null);
  if (!start || !end) return Infinity;
  const latScale = 111_320;
  const lngScale = Math.cos(((start.lat + end.lat) / 2) * Math.PI / 180) * latScale;
  const px = (lng - start.lng) * lngScale;
  const py = (lat - start.lat) * latScale;
  const ex = (end.lng - start.lng) * lngScale;
  const ey = (end.lat - start.lat) * latScale;
  const lenSq = ex * ex + ey * ey;
  if (lenSq <= 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / lenSq));
  return Math.hypot(px - ex * t, py - ey * t);
}

function coordFromWire(wire: WireSegment, start: boolean): Coord | undefined {
  const lat = start ? wire.startLat : wire.endLat;
  const lng = start ? wire.startLng : wire.endLng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  const elev = start ? wire.startElev : wire.endElev;
  return { lat, lng, elev };
}

function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(8)},${lng.toFixed(8)}`;
}

function coordKeyFromCoord(coord: Coord | undefined): string | undefined {
  return coord ? coordKey(coord.lat, coord.lng) : undefined;
}

function connects(span: SpanRecord, a: string, b: string): boolean {
  return (span.startPath === a && span.endPath === b) || (span.startPath === b && span.endPath === a);
}

function sortTowerPaths(
  paths: string[],
  towerByPath: Map<string, TowerEntry>,
  towerOrder: Map<string, number>,
): string[] {
  return uniqueStrings(paths).sort((a, b) => {
    const ai = towerOrder.get(a);
    const bi = towerOrder.get(b);
    if (ai != null && bi != null && ai !== bi) return ai - bi;
    if (ai != null) return -1;
    if (bi != null) return 1;
    return (towerByPath.get(a)?.sourceOrder ?? 0) - (towerByPath.get(b)?.sourceOrder ?? 0);
  });
}

function compareSpansByOrder(towerOrder: Map<string, number>): (a: SpanRecord, b: SpanRecord) => number {
  const first = (span: SpanRecord): number => Math.min(
    towerOrder.get(span.startPath || '') ?? Number.MAX_SAFE_INTEGER,
    towerOrder.get(span.endPath || '') ?? Number.MAX_SAFE_INTEGER,
  );
  return (a, b) => first(a) - first(b) || a.key.localeCompare(b.key);
}

function firstTowerMarker(paths: string[], entries: Map<string, TowerEntry>, order: Map<string, number>): TowerMarker | undefined {
  const sorted = sortTowerPaths(paths, entries, order);
  return sorted.map((path) => entries.get(path)?.marker).find((marker): marker is TowerMarker => Boolean(marker));
}

function lastTowerMarker(paths: string[], entries: Map<string, TowerEntry>, order: Map<string, number>): TowerMarker | undefined {
  const sorted = sortTowerPaths(paths, entries, order).reverse();
  return sorted.map((path) => entries.get(path)?.marker).find((marker): marker is TowerMarker => Boolean(marker));
}

function spanLabel(span: SpanRecord): string {
  const start = normalizeTowerNumber(span.startTower?.towerNumber);
  const end = normalizeTowerNumber(span.endTower?.towerNumber);
  if (start && end) return `档距 ${start}—${end}`;
  if (start) return `档距 ${start}`;
  if (end) return `档距 ${end}`;
  // 端点不可靠时不虚构“起点—终点”；来源路径仍在 tooltip/属性面板中可追溯。
  return '档距';
}

function spanSubtitle(span: SpanRecord): string {
  const meters = firstFinite(span.wires.map((wire) => wire.spanMeters));
  const types = uniqueStrings(span.wires.map((wire) => (wire.wireType || 'UNKNOWN').toUpperCase()));
  const cross = span.crosses.length > 0 ? `跨越物 ${span.crosses.length}` : undefined;
  const unresolved = span.unresolved && !meters ? '端点/定位待确认' : undefined;
  return [meters != null ? `${meters.toFixed(1)} m` : '长度未计算', `导线 ${span.wires.length}`, types.join('/') || undefined, cross, unresolved]
    .filter(Boolean).join(' · ');
}

function strainSubtitle(towerCount: number, spans: SpanRecord[]): string {
  const wireCount = spans.reduce((sum, span) => sum + span.wires.length, 0);
  const quality = spans.some((span) => span.unresolved) ? '含未解析档距' : '拓扑顺序来自塔位/导线端点';
  const spanCount = spans.filter((span) => span.wires.length > 0 || (span.unresolved && span.samePointWires.length === 0)).length;
  return [`塔位 ${towerCount}`, `档距 ${spanCount}`, `导线 ${wireCount}`, quality]
    .join(' · ');
}

function sectionSubtitle(strainCount: number, towerCount: number, node: GimGraphNode | null | undefined): string {
  return [`耐张段 ${strainCount}`, `塔位 ${towerCount}`, node ? '按模型层级归属' : '顺序推断'].join(' · ');
}

function projectSubtitle(mapData: LineMapData, spans: SpanRecord[]): string {
  const spanCount = spans.filter((span) => span.wires.length > 0 || (span.unresolved && span.samePointWires.length === 0)).length;
  return [`塔位 ${mapData.stats.towerTotal}`, `档距 ${spanCount}`, `跨越物 ${mapData.crosses.length}`].join(' · ');
}

function routeSubtitle(f1: GimGraphNode | null, mapData: LineMapData, towerCount: number): string {
  const lineLength = f1 ? cleanText(f1.rawProps['LINELENGTH']) : '';
  return [lineLength ? `线路长度 ${lineLength} km` : undefined, `塔位 ${towerCount}`, `导线 ${mapData.wires.length}`]
    .filter(Boolean).join(' · ');
}

function resolveLineName(f1: GimGraphNode | null, options: LineNavigationOptions): string {
  const fromFam = firstPropForNode(f1, options.attrs, ['LINENAME', 'RUNPROJECTNAME', 'DESIGNPROJECTNAME']);
  return fromFam || cleanText(options.projectName) || '未命名线路';
}

function rangeLabel(prefix: string, start?: string, end?: string): string {
  return start && end ? `${prefix}（${start}—${end}）` : prefix;
}

function qualityLabel(quality: TowerMarker['dataQuality']): string {
  switch (quality) {
    case 'full': return '属性完整';
    case 'partial': return '部分属性';
    case 'coords-only': return '仅坐标';
    default: return '无法定位';
  }
}

function kindLabel(kind: LineNavigationKind): string {
  switch (kind) {
    case 'project': return '工程';
    case 'route': return '线路';
    case 'section': return '区段';
    case 'strain-section': return '耐张段';
    case 'tower': return '杆塔';
    case 'span': return '档距';
    case 'wire': return '导线';
    case 'crossing': return '跨越物';
    case 'same-point': return '同塔连接';
    case 'unsegmented': return '未分段对象';
    case 'unassociated-crossings': return '待关联跨越物';
    default: return '对象';
  }
}

function parseTowerNumber(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/(?:^|[^0-9])([0-9]+)(?:$|[^0-9])/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function towerNumberFromNode(node: GimGraphNode): string | undefined {
  for (const key of ['TOWERNUMBER', 'TOWERNO', 'N0', 'TOWERNUM', 'NUM', 'BH']) {
    const value = cleanText(node.rawProps[key]);
    if (value) return value;
  }
  return undefined;
}

/** 过滤文件名/路径等技术值，避免它们进入线路主导航标签。 */
function normalizeTowerNumber(value: string | undefined): string | undefined {
  const text = cleanText(value);
  if (!text || /[\\/]/.test(text) || /\.(?:cbm|xml|fam|dev)$/i.test(text)) return undefined;
  return text;
}

function lookupFamMap(
  refs: string[],
  attrs?: LineAttributeIndex,
): Map<string, { prop_value?: string | null }[]> | undefined {
  if (!attrs) return undefined;
  for (const ref of refs) {
    const normalized = normalizeGimPath(ref);
    const direct = attrs.famBySourcePath.get(normalized);
    if (direct) return direct;
    const byName = attrs.famByFileNameLower.get(getFileNameLower(ref));
    if (byName) return byName;
  }
  return undefined;
}

function firstProp(
  propMap: Map<string, { prop_value?: string | null }[]> | undefined,
  keys: string[],
): string | undefined {
  if (!propMap) return undefined;
  for (const key of keys) {
    const exact = propMap.get(key);
    if (exact?.[0]?.prop_value) return cleanText(exact[0].prop_value);
    for (const [candidate, values] of propMap) {
      if (candidate.toUpperCase() === key.toUpperCase() && values[0]?.prop_value) return cleanText(values[0].prop_value);
    }
  }
  return undefined;
}

function firstPropForNode(
  node: GimGraphNode | null,
  attrs: LineAttributeIndex | undefined,
  keys: string[],
): string | undefined {
  if (!node) return undefined;
  return firstProp(lookupFamMap(node.refs.famFiles, attrs), keys);
}

function cleanText(value: string | undefined): string {
  const text = (value || '').trim().replace(/\s+/g, ' ');
  return text && !PLACEHOLDER_RE.test(text) ? text : '';
}

function fileName(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function firstFinite(values: Array<number | null>): number | null {
  const value = values.find((item): item is number => item != null && Number.isFinite(item));
  return value ?? null;
}

function compareWireTypes(a: WireSegment, b: WireSegment): number {
  const rank: Record<string, number> = { CONDUCTOR: 0, GROUNDWIRE: 1, OPGW: 2, UNKNOWN: 3 };
  const at = (a.wireType || 'UNKNOWN').toUpperCase();
  const bt = (b.wireType || 'UNKNOWN').toUpperCase();
  return (rank[at] ?? 9) - (rank[bt] ?? 9) || a.nodeRef.path.localeCompare(b.nodeRef.path);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueByPath<T extends { path: string }>(nodes: T[]): T[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.path)) return false;
    seen.add(node.path);
    return true;
  });
}

function collectDescendants(node: GimGraphNode, predicate: (child: GimGraphNode) => boolean): GimGraphNode[] {
  const result: GimGraphNode[] = [];
  const seen = new Set<string>();
  const walk = (current: GimGraphNode): void => {
    for (const child of current.children) {
      if (seen.has(child.path)) continue;
      seen.add(child.path);
      if (predicate(child)) result.push(child);
      walk(child);
    }
  };
  walk(node);
  return result;
}

function firstDescendant(node: GimGraphNode, predicate: (child: GimGraphNode) => boolean): GimGraphNode | null {
  for (const child of node.children) {
    if (predicate(child)) return child;
    const result = firstDescendant(child, predicate);
    if (result) return result;
  }
  return null;
}

function isDescendantOf(node: GimGraphNode, ancestor: GimGraphNode, parentByPath: Map<string, GimGraphNode>): boolean {
  let current: GimGraphNode | undefined = node;
  const seen = new Set<string>();
  while (current && !seen.has(current.path)) {
    if (current.path === ancestor.path) return true;
    seen.add(current.path);
    current = parentByPath.get(current.path);
  }
  return false;
}

function sectionKeyFor(path: string | undefined, index: number): string {
  return path ? `line-navigation:section:${encodeURIComponent(path)}` : `line-navigation:section:inferred:${index}`;
}

function routeKey(path: string): string {
  return `line-navigation:route:${encodeURIComponent(path)}`;
}

function strainSectionKey(path: string, sectionIndex: number, index: number): string {
  return path.startsWith('inferred-')
    ? `line-navigation:strain:${sectionIndex}:${index}`
    : `line-navigation:strain:${encodeURIComponent(path)}`;
}

function nodesByKind(root: LineNavigationNode, kind: LineNavigationKind): LineNavigationNode[] {
  const result: LineNavigationNode[] = [];
  const walk = (node: LineNavigationNode): void => {
    if (node.kind === kind) result.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return result;
}

function ensureLineNavigationRowExpanded(key: string): void {
  // 通过 dataset 精确比较，避免 CSS.escape 在带冒号/百分号的业务键上
  // 作为属性选择器值时出现浏览器实现差异。
  const row = Array.from(document.querySelectorAll<HTMLElement>('.line-navigation-row'))
    .find((candidate) => candidate.dataset.nodePath === key);
  if (!row) return;
  const toggle = row.querySelector<HTMLButtonElement>('.tree-toggle[data-toggle-key]');
  if (!toggle || toggle.classList.contains('expanded')) return;
  toggle.click();
}
