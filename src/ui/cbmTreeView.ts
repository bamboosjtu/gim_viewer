import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { cbmTreePanel } from './dom.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';
import { showNodeProperties, openPropsDrawer } from './propsDrawer.js';
import { highlightIfcFromNode } from '../viewer/highlight.js';

const ENTITY_ICONS: Record<string, string> = {
  F1System: '🏗️', F2System: '🏢', F3System: '⚡', F4System: '🔧', PARTINDEX: '🔩',
};

/** 渲染 CBM 层级树 */
export function renderCbmTree(
  ctx: ViewerContext,
  state: AppState,
  node: CbmNode,
  parentEl: HTMLElement,
  showMessage: (text: string) => void,
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
    showNodeProperties(ctx, state, node);
    openPropsDrawer(ctx);
    highlightIfcFromNode(ctx, state, node, showMessage);
    if (node.children.length > 0) {
      expanded = !expanded;
      toggle.classList.toggle('expanded', expanded);
      childrenEl.classList.toggle('expanded', expanded);
      if (expanded && !childrenRendered) {
        for (const child of node.children) renderCbmTree(ctx, state, child, childrenEl, showMessage);
        childrenRendered = true;
      }
    }
  });
  parentEl.appendChild(nodeEl);
}

/** 构建并渲染 CBM 层级树 */
export function buildAndRenderCbmTree(ctx: ViewerContext, state: AppState, showMessage: (text: string) => void): void {
  cbmTreePanel.innerHTML = '';
  if (!state.currentCbmTree) { cbmTreePanel.innerHTML = '<div class="props-empty">加载 GIM 文件后显示层级树</div>'; return; }
  renderCbmTree(ctx, state, state.currentCbmTree, cbmTreePanel, showMessage);
}
