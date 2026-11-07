import { resolveLineNavigationTarget } from '../services/lineNavigationProjection.js';
import type { LineNavigationIndex, LineNavigationNode } from '../services/lineNavigationProjection.js';
export { buildLineNavigationIndex, buildLineNavigationSearchIndex, resolveLineNavigationTarget } from '../services/lineNavigationProjection.js';
export type { LineNavigationKind, LineNavigationNode, LineNavigationIndex, LineNavigationOptions, LineSpanProjection, LineCrossProjection, LineNavigationStats } from '../services/lineNavigationProjection.js';


export interface LineNavigationTreeHandle { destroy():void; }
const treeOwners = new WeakMap<HTMLElement,LineNavigationTreeHandle>();

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
): LineNavigationTreeHandle {
  treeOwners.get(parentEl)?.destroy();
  const controller = new (parentEl.ownerDocument.defaultView?.AbortController ?? AbortController)();
  let destroyed = false;
  const handle:LineNavigationTreeHandle = { destroy() {
    if(destroyed)return;destroyed=true;controller.abort();
    if(treeOwners.get(parentEl)===handle){treeOwners.delete(parentEl);parentEl.replaceChildren();}
  }};
  treeOwners.set(parentEl,handle);
  parentEl.innerHTML = '';
  renderNode(index.root, parentEl, onNodeClick, true, controller.signal);
  return handle;
}


function renderNode(
  node: LineNavigationNode,
  parentEl: HTMLElement,
  onNodeClick: (node: LineNavigationNode) => void,
  initiallyExpanded: boolean,
  signal: AbortSignal,
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
        renderNode(child, childrenEl, onNodeClick, child.kind === 'route' || child.kind === 'section', signal);
      }
      rendered = true;
    }
  };
  if (hasChildren) {
    (toggle as HTMLButtonElement).addEventListener('click', (event) => {
      event.stopPropagation();
      setExpanded(!expanded);
    }, {signal});
  }
  row.addEventListener('click', () => {
    parentEl.closest('[role="tree"]')?.querySelectorAll('.tree-row.selected').forEach((item) => item.classList.remove('selected'));
    document.querySelectorAll('.line-navigation-row.selected').forEach((item) => item.classList.remove('selected'));
    row.classList.add('selected');
    onNodeClick(node);
  }, {signal});
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
  }, {signal});

  parentEl.appendChild(nodeEl);
  if (initiallyExpanded) setExpanded(true);
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