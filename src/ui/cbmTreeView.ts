import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import { cbmTreePanel } from './dom.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';

const ENTITY_ICONS: Record<string, string> = {
  F1System: '🏗️', F2System: '🏢', F3System: '⚡', F4System: '🔧', PARTINDEX: '🔩',
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
  const toggle = document.createElement('span');
  toggle.className = `tree-toggle ${node.children.length === 0 ? 'leaf' : ''}`;
  toggle.textContent = '▶';
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = ENTITY_ICONS[node.entityName] || '📁';
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = getNodeDisplayName(node, state.ifcGuidToName);
  label.title = node.path;
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
  parentEl.appendChild(nodeEl);
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
  renderCbmTreeUI(state, state.currentCbmTree, cbmTreePanel, onNodeClick);
}
