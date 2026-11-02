import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import { cbmTreePanel } from './dom.js';
import { getNodeDisplayName } from '../shared/displayName.js';
import { resolveIfcModelId } from '../gim/modelIdentity.js';
import { renderSearchBox } from './searchBox.js';
import type { SearchItem } from './searchBox.js';
import type { PropertyReferenceDetail } from './propertyDictionary.js';
import { markDeviceBounds } from './deviceBoundsMarker.js';
import { renderEngineeringTree, syncEngineeringTreeSelection } from './engineeringTreeView.js';

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
  row.setAttribute('aria-expanded', 'false');
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
  markDeviceBounds(row, state, node.path);
  nodeEl.appendChild(row);
  const childrenEl = document.createElement('div');
  childrenEl.className = 'tree-children';
  nodeEl.appendChild(childrenEl);

  let expanded = false;
  let childrenRendered = false;
  const setExpanded = (value: boolean): void => {
    if (node.children.length === 0) return;
    expanded = value;
    row.setAttribute('aria-expanded', String(expanded));
    toggle.classList.toggle('expanded', expanded);
    childrenEl.classList.toggle('expanded', expanded);
    if (expanded && !childrenRendered) {
      for (const child of node.children) renderCbmTreeUI(state, child, childrenEl, onNodeClick);
      childrenRendered = true;
    }
  };
  toggle.addEventListener('click', (event) => {
    // Expanding the tree must not select/load the node.
    event.stopPropagation();
    setExpanded(!expanded);
  });
  row.addEventListener('click', () => {
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    onNodeClick(node);
    if (node.children.length > 0) setExpanded(!expanded);
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
 * 构建变电 CBM 树搜索索引。
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
export function buildAndRenderCbmTree(state: AppState, onNodeClick: (node: CbmNode) => void): void {
  if (state.currentProjectType === 'substation') { renderEngineeringTree(state); return; }
  cbmTreePanel.replaceChildren();
  if (!state.currentCbmTree) { cbmTreePanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示层级树</div>'; return; }
  renderSearchBox(cbmTreePanel, buildCbmSearchIndex(state, state.currentCbmTree), key => {
    const node = findByPath(state.currentCbmTree, key);
    if (node) { onNodeClick(node); selectCbmTreeRow(key); }
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

/** Restore the current selection after lazy tree/name refresh, without a new request. */
export function syncSelectedTreeRow(state: AppState): void {
  if (state.currentProjectType === 'substation') { syncEngineeringTreeSelection(state); return; }
  document.querySelectorAll('#cbm-tree-panel .tree-row.selected').forEach((row) => row.classList.remove('selected'));
  const target=state.selectionRequest?.target;
  if (!target) return;
  selectCbmTreeRow(target.key);
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
  if (state.currentProjectType !== 'substation' && state.currentProjectType !== 'equipment') return false;
  if (state.currentProjectType === 'substation' && state.engineeringSources) {
    const normalize = (path: string) => path.replace(/\\/g, '/').toLowerCase();
    const wanted = normalize(detail.path), name = wanted.split('/').pop();
    const inventory = [...new Set([...state.substationEntryPaths, ...state.engineeringSources.graph.documents.map(doc => doc.path), ...state.engineeringSources.graph.ifcPaths])];
    const exact = inventory.filter(path => normalize(path) === wanted);
    const matches = exact.length ? exact : inventory.filter(path => normalize(path).split('/').pop() === name);
    if (matches.length !== 1) { showMessage(matches.length ? '来源文件有多个候选，请在来源视图核对' : '该来源文件当前不可用'); return true; }
    state.engineeringNavMode = 'source'; renderEngineeringTree(state);
    void import('../services/engineeringSourceInspector.js').then(({ inspectEngineeringDocument }) => inspectEngineeringDocument(state, matches[0]))
      .catch(error => showMessage(`来源未能打开：${String(error)}`));
    return true;
  }
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
  } else if (detail.kind === 'phm' || detail.kind === 'mod' || detail.kind === 'gl' || detail.kind === 'stl') {
    // PHM/MOD/GL/STL 不是独立 CBM 节点：优先利用已加载几何实例携带的
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
    const request=state.beginSelection({kind:'cbm',key:target.path});
    void import('../services/nodeInteractionService.js').then(({ handleNodeClick }) =>
      handleNodeClick(state,target!,showMessage,request),
    ).catch((error) => console.warn('[属性引用] 变电节点定位失败:', error));
    return true;
  }
  showMessage('该来源文件未映射到可见变电节点');
  return true;
}

/** Expand every saved ancestor row; unrendered paths are skipped. */
export async function expandTreeToPaths(paths: readonly string[]): Promise<void> {
  for (const path of [...paths].sort((a, b) => a.split('/').length - b.split('/').length)) {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(path) : path.replace(/"/g, '\\"');
    const row = document.querySelector<HTMLElement>(`#cbm-tree-panel .tree-row[data-node-path="${escaped}"]`);
    if (!row) continue;
    const toggle = row.querySelector<HTMLElement>('.tree-toggle');
    if (!toggle || toggle.classList.contains('leaf') || toggle.classList.contains('expanded')) continue;
    toggle.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
