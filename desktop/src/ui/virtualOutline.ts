/** A logical outline keeps expansion/identity while its DOM window is recycled. */
export interface OutlineNode {
  key: string;
  render(host: HTMLElement): void;
  children?: () => OutlineNode[];
}
export interface OutlineElement extends HTMLElement {
  __gimRevealOutline?: (key: string) => boolean;
}

/** Fixed-height tree rows, including arbitrarily nested expanded branches.
 * Only the visible logical rows are flattened; children stay lazy. */
export function renderVirtualOutline(host: HTMLElement, roots: OutlineNode[]): void {
  const element = document.createElement('div') as OutlineElement;
  element.className = 'functional-virtual-outline';
  element.setAttribute('role', 'group');
  const top = document.createElement('div'), rows = document.createElement('div'), bottom = document.createElement('div');
  top.setAttribute('aria-hidden', 'true'); bottom.setAttribute('aria-hidden', 'true');
  element.append(top, rows, bottom); host.append(element);
  const expanded = new Set<string>(), children = new Map<string, OutlineNode[]>();
  let flat: Array<{node: OutlineNode; depth: number; parent?: string; pos: number; size: number}> = [];
  let start = 0, end = 0, selected = '', frame = 0;
  const height = 30, windowSize = 100, overscan = 10;
  const flatten = (): void => {
    flat = [];
    const visit = (nodes: OutlineNode[], depth: number, parent?: string): void => {
      nodes.forEach((node, index) => {
        flat.push({node, depth, parent, pos: index + 1, size: nodes.length});
        if (expanded.has(node.key) && node.children) {
          let nested = children.get(node.key);
          if (!nested) { nested = node.children(); children.set(node.key, nested); }
          visit(nested, depth + 1, node.key);
        }
      });
    };
    visit(roots, 0);
    element.dataset.virtualCount = String(flat.length);
  };
  const render = (index: number): void => {
    const oldSelection = rows.querySelector<HTMLElement>('.selected');
    if (oldSelection) selected = oldSelection.dataset.nodePath ?? '';
    else if (document.querySelector('.tree-row.selected')) selected = '';
    start = Math.max(0, Math.min(Math.max(0, flat.length - windowSize), index - overscan));
    end = Math.min(flat.length, start + windowSize + overscan * 2);
    top.style.height = `${start * height}px`; bottom.style.height = `${(flat.length - end) * height}px`;
    rows.replaceChildren();
    for (let i = start; i < end; i++) {
      const item = flat[i];
      item.node.render(rows);
      const wrapper = rows.lastElementChild as HTMLElement;
      const row = wrapper.querySelector<HTMLElement>('.tree-row')!;
      // One logical row per wrapper: child rows have their own flattened entry.
      wrapper.style.paddingLeft = `${item.depth * 15}px`;
      row.style.height = `${height}px`; row.style.boxSizing = 'border-box';
      row.setAttribute('aria-level', String(item.depth + 1));
      row.setAttribute('aria-posinset', String(item.pos)); row.setAttribute('aria-setsize', String(item.size));
      row.classList.toggle('selected', item.node.key === selected);
      if (item.node.children) {
        row.setAttribute('aria-expanded', String(expanded.has(item.node.key)));
        const toggle = row.querySelector<HTMLElement>('.tree-toggle')!;
        toggle.classList.toggle('expanded', expanded.has(item.node.key));
        toggle.addEventListener('click', event => {
          event.preventDefault(); event.stopImmediatePropagation(); toggleNode(item.node.key);
        }, {capture: true});
      }
    }
  };
  const reveal = (key: string, focus = false): boolean => {
    const index = flat.findIndex(item => item.node.key === key);
    if (index < 0) return false;
    if (index < start || index >= end) render(index);
    const row = [...rows.querySelectorAll<HTMLElement>('.tree-row')].find(row => row.dataset.nodePath === key);
    if (focus) row?.focus();
    row?.scrollIntoView?.({block: 'nearest'});
    return true;
  };
  const toggleNode = (key: string, next = !expanded.has(key)): void => {
    if (next) expanded.add(key); else expanded.delete(key);
    flatten(); render(start + overscan); reveal(key, true);
  };
  rows.addEventListener('keydown', event => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('.tree-row')?.dataset.nodePath;
    const index = flat.findIndex(item => item.node.key === key);
    if (index < 0) return;
    const item = flat[index];
    if (event.key === 'ArrowRight' && item.node.children) {
      event.preventDefault(); event.stopPropagation();
      if (!expanded.has(item.node.key)) toggleNode(item.node.key, true);
      else if (flat[index + 1]?.parent === key) reveal(flat[index + 1].node.key, true);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault(); event.stopPropagation();
      if (expanded.has(item.node.key)) toggleNode(item.node.key, false);
      else if (item.parent) reveal(item.parent, true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? flat.length - 1
        : Math.max(0, Math.min(flat.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      reveal(flat[next].node.key, true);
    }
  }, {capture: true});
  element.__gimRevealOutline = key => reveal(key);
  flatten(); render(0);
  // Bind to the panel after its lazy branch has been attached. Disconnect on
  // removal so repeated project switches leave no scroll/observer owners.
  queueMicrotask(() => {
    if (!element.isConnected) return;
    const scroller = element.closest<HTMLElement>('.tab-panel');
    if (!scroller) return;
    const onScroll = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!element.isConnected || !element.getClientRects().length) return;
        const offset = Math.max(0, scroller.getBoundingClientRect().top - element.getBoundingClientRect().top);
        const index = Math.floor(offset / height);
        const next = Math.max(0, Math.min(Math.max(0, flat.length - windowSize), index - overscan));
        if (next !== start) render(index);
      });
    };
    scroller.addEventListener('scroll', onScroll, {passive: true});
    const observer = new MutationObserver(() => {
      if (element.isConnected) return;
      scroller.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame);
      observer.disconnect(); delete element.__gimRevealOutline;
    });
    observer.observe(document.body, {childList: true, subtree: true});
  });
}
