import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import { cbmTreePanel } from './dom.js';
import { getNodeDisplayName } from '../shared/displayName.js';
import { resolveIfcModelId } from '../gim/modelIdentity.js';
import { renderSearchBox } from './searchBox.js';
import type { SearchItem } from './searchBox.js';
import type { IfcSpatialNode, IfcSpatialObject } from '../gim/ifcSpatialParser.js';
import {
  buildSpatialSearchIndex,
  renderSubstationSpatialTree,
  resolveSpatialSearchCbmPath,
  revealSpatialSearchTarget,
  loadSpatialSearchTargetPage,
} from './substationSpatialTreeView.js';
import {
  buildFunctionalDomainIndex,
  buildFunctionalSearchIndex,
  renderSubstationFunctionalTree,
  revealFunctionalSearchTarget,
} from './substationFunctionalTreeView.js';
import type { PropertyReferenceDetail } from './propertyDictionary.js';

const ENTITY_ICONS: Record<string, string> = {
  F1System: '◎', F2System: '□', F3System: '≋', F4System: '◆', PARTINDEX: '•',
  // DEV SUBDEVICES 展开的虚拟子设备节点（方向 B）
  DEV_SUBDEVICE: '◇',
};

/**
 * 纯 UI 渲染层：渲染 CBM 层级树节点，不依赖 ViewerContext。
 * @param onNodeClick 节点点击回调（由交互层提供）
 */
export function renderCbmTreeUI(
  state: AppState,
  node: CbmNode,
  parentEl: HTMLElement,
  onNodeClick: (node: CbmNode) => void,
): void {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.setAttribute('role', 'treeitem');
  row.tabIndex = 0;
  // 搜索结果反查树行用（与线路工程 data-node-path 约定一致）
  row.dataset.nodePath = node.path;
  const toggle = document.createElement('span');
  toggle.className = `tree-toggle ${node.children.length === 0 ? 'leaf' : ''}`;
  toggle.textContent = '▶';
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = ENTITY_ICONS[node.entityName] || '□';
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries);
  // title 提供详细路径信息（CBM 真实节点显示 CBM 路径，DEV 虚拟节点显示 DEV 路径）
  const tooltipParts: string[] = [node.path];
  if (node.devSymbolName) tooltipParts.push(`设备名: ${node.devSymbolName}`);
  if (node.devType) tooltipParts.push(`类型: ${node.devType}`);
  if (node.devPath) tooltipParts.push(`DEV: ${node.devPath}`);
  label.title = tooltipParts.join('\n');
  row.appendChild(toggle); row.appendChild(icon); row.appendChild(label);
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
        for (const child of node.children) renderCbmTreeUI(state, child, childrenEl, onNodeClick);
        childrenRendered = true;
      }
    }
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      row.click();
    }
  });
  parentEl.appendChild(nodeEl);
}

/**
 * 构建变电 CBM 树搜索索引（dev-log「无搜索」项）。
 *
 * 遍历全树，标签取 getNodeDisplayName（含 IFC 名称索引 / DEV SYMBOLNAME 覆盖），
 * 副标签含实体类型与 DEV 类型。
 */
function buildCbmSearchIndex(state: AppState, root: CbmNode): SearchItem[] {
  const items: SearchItem[] = [];
  const seen = new Set<string>();
  const MAX_NODES = 100_000; // 防御异常大树
  (function walk(node: CbmNode): void {
    if (items.length >= MAX_NODES) return;
    if (!seen.has(node.path)) {
      seen.add(node.path);
      items.push({
        key: node.path,
        title: getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries),
        subtitle: [node.entityName, node.devType].filter(Boolean).join(' · ') || undefined,
      });
    }
    for (const c of node.children) walk(c);
  })(root);
  return items;
}

/**
 * 构建并渲染 CBM 层级树。
 * 统一入口：无论首次打开还是缓存命中，都使用 onNodeClick 回调处理交互。
 */
export function buildAndRenderCbmTree(
  state: AppState,
  onNodeClick: (node: CbmNode) => void,
): void {
  cbmTreePanel.innerHTML = '';
  if (!state.currentCbmTree) { cbmTreePanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示层级树</div>'; return; }
  const spatialIndex = state.substationSpatialIndex;
  const isSubstation = state.currentProjectType === 'substation';
  const hasSpatialTree = !!spatialIndex?.coverage.hasSpatialEntities && !!spatialIndex?.coverage.hasSpatialContainment;
  if (isSubstation) {
    // 空间事实缺失时自动降级到功能系统视角；空间能力恢复后仍可由用户显式切回空间。
    if (!hasSpatialTree && state.substationNavMode === 'spatial') state.substationNavMode = 'functional';
    const functionalIndex = state.currentCbmTree ? buildFunctionalDomainIndex(state.currentCbmTree) : null;
    // 搜索框由 renderSearchBox prepend 到顶部；模式条和树内容放在其后。
    const treeHost = document.createElement('div');
    treeHost.className = 'tree-view-host';
    const modeBar = document.createElement('div');
    modeBar.className = 'substation-nav-mode';
    const spatialButton = document.createElement('button');
    spatialButton.type = 'button';
    spatialButton.className = 'substation-nav-mode-btn';
    spatialButton.textContent = '空间';
    spatialButton.title = hasSpatialTree
      ? '按站区 / 建筑 / 楼层 / 空间浏览 IFC 构件'
      : '当前 IFC 未提供可用空间包含关系';
    spatialButton.disabled = !hasSpatialTree;
    spatialButton.setAttribute('aria-pressed', String(state.substationNavMode === 'spatial' && hasSpatialTree));
    const functionalButton = document.createElement('button');
    functionalButton.type = 'button';
    functionalButton.className = 'substation-nav-mode-btn';
    functionalButton.textContent = '功能系统';
    functionalButton.title = '按功能系统域 / 系统 / 构件或设备浏览 CBM 对象';
    functionalButton.setAttribute('aria-pressed', String(state.substationNavMode === 'functional'));
    const quality = document.createElement('span');
    quality.className = 'substation-nav-quality';
    if (spatialIndex) {
      const c = spatialIndex.coverage;
      quality.textContent = c.hasSpatialContainment
        ? `空间关联 ${Math.round(c.spatiallyContainedCbmCoverage * 100)}%`
        : '空间关系不可用';
      quality.title = c.hasSpatialContainment
        ? `CBM→IFC 空间关联 ${Math.round(c.spatiallyContainedCbmCoverage * 100)}% · 未落位 IFC ${c.uncontainedIfcObjects} · 坐标对象 ${c.positionedAssets} · 原点矩阵 ${c.identityPlacementAssets} · 无容器 ${c.confirmedWithoutSpatialContainer} · 未关联对象 ${c.unlocatedAssets}。此百分比仅表示 CBM 节点命中 IFC 空间的比例；空间主树仍保留全部 IFC 构件，推断/未关联对象保留在质量分组中`
        : '空间关系未提供，当前显示功能系统视图';
    } else {
      quality.textContent = '空间索引不可用';
    }
    modeBar.append(spatialButton, functionalButton, quality);
    cbmTreePanel.append(modeBar, treeHost);

    const renderMode = (): void => {
      spatialButton.classList.toggle('active', state.substationNavMode === 'spatial' && hasSpatialTree);
      functionalButton.classList.toggle('active', state.substationNavMode === 'functional' || !hasSpatialTree);
      spatialButton.setAttribute('aria-pressed', String(state.substationNavMode === 'spatial' && hasSpatialTree));
      functionalButton.setAttribute('aria-pressed', String(state.substationNavMode === 'functional' || !hasSpatialTree));
    };
    renderMode();
    spatialButton.addEventListener('click', () => {
      if (!hasSpatialTree) return;
      state.substationNavMode = 'spatial';
      buildAndRenderCbmTree(state, onNodeClick);
    });
    functionalButton.addEventListener('click', () => {
      state.substationNavMode = 'functional';
      buildAndRenderCbmTree(state, onNodeClick);
    });

    const onSpatialNodeClick = (node: IfcSpatialNode): void => {
      void import('./propsDrawer.js').then(({ showSpatialNodePropertiesBasic, openPropsDrawerUI }) => {
        if (state.substationSpatialIndex?.nodeByKey.get(node.key) !== node) return;
        showSpatialNodePropertiesBasic(state, node, state.substationSpatialIndex!);
        openPropsDrawerUI();
      }).catch((err) => console.warn('[空间树] 显示空间属性失败:', err));
    };
    const onSpatialObjectClick = (object: IfcSpatialObject): void => {
      void import('./propsDrawer.js').then(({ showIfcSpatialObjectPropertiesBasic, openPropsDrawerUI }) => {
        if (state.substationSpatialIndex?.objectByKey.get(object.key) !== object) return;
        showIfcSpatialObjectPropertiesBasic(state, object, state.substationSpatialIndex!);
        openPropsDrawerUI();
      }).catch((err) => console.warn('[空间树] 显示 IFC 构件属性失败:', err));
    };

    const isSpatialMode = state.substationNavMode === 'spatial' && !!spatialIndex && hasSpatialTree;
    const searchItems = isSpatialMode
      ? buildSpatialSearchIndex(state, spatialIndex!)
      : functionalIndex ? buildFunctionalSearchIndex(state, functionalIndex) : [];
    renderSearchBox(cbmTreePanel, searchItems, (key) => {
      if (isSpatialMode && spatialIndex) {
        const spatialNode = spatialIndex.nodeByKey.get(key);
        if (spatialNode) {
          revealSpatialSearchTarget(spatialIndex, key);
          selectCbmTreeRow(key);
          onSpatialNodeClick(spatialNode);
          return;
        }
        const spatialObject = spatialIndex.objectByKey.get(key);
        if (spatialObject) {
          const paginationKey = revealSpatialSearchTarget(spatialIndex, key);
          loadSpatialSearchTargetPage(paginationKey, key);
          selectCbmTreeRow(key);
          // 空间树命中的是 IFC 构件时优先打开 IFC 检查器，避免把
          // PropertySet/材质/Representation 等信息覆盖成 CBM 摘要。
          // 关联 CBM 仍在检查器关系页和“关联设备”行中可继续追踪。
          onSpatialObjectClick(spatialObject);
          return;
        }
        const spatialLink = spatialIndex.linksByCbmPath.get(key);
        if (spatialLink) {
          const paginationKey = revealSpatialSearchTarget(spatialIndex, key);
          loadSpatialSearchTargetPage(paginationKey, key);
        }
      }
      if (!isSpatialMode && functionalIndex) {
        const target = functionalIndex.targetByKey.get(key);
        if (target) {
          const rowKey = revealFunctionalSearchTarget(functionalIndex, key);
          if (rowKey) selectCbmTreeRow(rowKey);
          if (target.node) onNodeClick(target.node);
          return;
        }
      }
      const node = findByPath(state.currentCbmTree, key);
      if (node) {
        onNodeClick(node);
        selectCbmTreeRow(key);
        return;
      }
      if (isSpatialMode && spatialIndex) {
        const cbmPath = resolveSpatialSearchCbmPath(spatialIndex, key);
        const linkedNode = cbmPath ? findByPath(state.currentCbmTree, cbmPath) : null;
        if (linkedNode) {
          onNodeClick(linkedNode);
          selectCbmTreeRow(key);
        } else {
          const spatialObject = spatialIndex.objectByKey.get(key);
          if (spatialObject) onSpatialObjectClick(spatialObject);
        }
      }
    });

    treeHost.innerHTML = '';
    if (isSpatialMode && spatialIndex) {
      renderSubstationSpatialTree(state, spatialIndex, treeHost, onNodeClick, onSpatialNodeClick, onSpatialObjectClick);
    } else if (functionalIndex) {
      renderSubstationFunctionalTree(state, functionalIndex, treeHost, onNodeClick);
    } else {
      renderCbmTreeUI(state, state.currentCbmTree, treeHost, onNodeClick);
    }
    return;
  }

  // 线路工程不进入此入口；保留原始 CBM 树的搜索和渲染行为。
  renderSearchBox(cbmTreePanel, buildCbmSearchIndex(state, state.currentCbmTree), (key) => {
    const node = findByPath(state.currentCbmTree, key);
    if (!node) return;
    onNodeClick(node);
    selectCbmTreeRow(key);
  });
  renderCbmTreeUI(state, state.currentCbmTree, cbmTreePanel, onNodeClick);
}

/** 按 path 在树中查找节点（BFS，仅用于搜索命中回查） */
function findByPath(root: CbmNode | null, path: string): CbmNode | null {
  if (!root) return null;
  const queue: CbmNode[] = [root];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (n.path === path) return n;
    for (const c of n.children) queue.push(c);
  }
  return null;
}

/** 选中指定 path 的树行（未渲染的懒加载节点静默跳过） */
function selectCbmTreeRow(path: string): void {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(path) : path.replace(/"/g, '\\"');
  const row = document.querySelector<HTMLElement>(`.tree-row[data-node-path="${escaped}"]`);
  if (!row) return;
  document.querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
  row.classList.add('selected');
  row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * 属性面板来源按钮的变电路由。
 *
 * 路由优先回到 CBM/空间树节点；对 IFC 文件则定位到拥有该模型的第一个
 * CBM 节点并复用既有 handleNodeClick（必要时懒加载模型）。找不到业务节点时
 * 仍返回 true，避免事件继续冒泡到其它工程路由。
 */
export function handleSubstationPropertyReference(
  state: AppState,
  detail: PropertyReferenceDetail,
  showMessage: (text: string) => void = () => undefined,
): boolean {
  if (state.currentProjectType !== 'substation') return false;
  const normalized = detail.path.replace(/\\/g, '/').toLowerCase();
  const fileName = normalized.split('/').pop() || normalized;
  const nodes: CbmNode[] = [];
  if (state.currentCbmTree) {
    const queue: CbmNode[] = [state.currentCbmTree];
    while (queue.length > 0) {
      const node = queue.shift()!;
      nodes.push(node);
      queue.push(...node.children);
    }
  }
  const pathMatches = (value: string): boolean => {
    const candidate = value.replace(/\\/g, '/').toLowerCase();
    return candidate === normalized || (candidate.split('/').pop() || candidate) === fileName;
  };
  let target: CbmNode | undefined;
  if (detail.kind === 'cbm') {
    target = nodes.find((node) => pathMatches(node.path));
  } else if (detail.kind === 'dev') {
    target = nodes.find((node) => pathMatches(node.devPath) || node.path.toLowerCase().endsWith(fileName));
  } else if (detail.kind === 'fam') {
    target = nodes.find((node) => pathMatches(node.famPath));
  } else if (detail.kind === 'ifc') {
    target = nodes.find((node) => pathMatches(node.ifcFile));
    if (!target) {
      const entry = state.currentIfcEntries.find((item) => pathMatches(item.path) || pathMatches(item.name));
      if (entry) target = nodes.find((node) => resolveIfcModelId(node.ifcFile, state.currentIfcEntries) === entry.modelId);
    }
  } else if (detail.kind === 'phm' || detail.kind === 'mod' || detail.kind === 'stl') {
    // PHM/MOD/STL 不是独立 CBM 节点：优先利用已加载几何实例携带的
    // devPath 回到业务设备。instanceKey 也包含 PHM/MOD/STL 文件名，
    // 因此缓存命中或不同大小写目录下仍可完成定位。
    const groups = [
      ...Array.from(state.loadedXmlModGroups.entries()),
      ...Array.from(state.loadedStlGroups.entries()),
    ];
    const matched = groups.find(([instanceKey, group]) => {
      const data = group.userData as Record<string, unknown> | undefined;
      const candidates = [
        instanceKey,
        typeof data?.modPath === 'string' ? data.modPath : '',
        typeof data?.stlPath === 'string' ? data.stlPath : '',
        typeof data?.phmPath === 'string' ? data.phmPath : '',
      ];
      return candidates.some((value) => value && (pathMatches(value) || value.toLowerCase().includes(fileName)));
    });
    const devPath = matched?.[1].userData?.devPath;
    if (typeof devPath === 'string') {
      const normalizedDevPath = devPath.replace(/\\/g, '/').toLowerCase();
      const devFileName = normalizedDevPath.split('/').pop() || normalizedDevPath;
      target = nodes.find((node) => {
        const candidate = node.devPath.replace(/\\/g, '/').toLowerCase();
        return candidate === normalizedDevPath || (candidate.split('/').pop() || candidate) === devFileName;
      });
    }
  }
  if (target) {
    selectCbmTreeRow(target.path);
    void import('../services/nodeInteractionService.js').then(({ handleNodeClick }) =>
      handleNodeClick(state, target!, showMessage),
    ).catch((error) => console.warn('[属性引用] 变电节点定位失败:', error));
    return true;
  }
  showMessage('该来源文件未映射到可见变电节点');
  return true;
}
