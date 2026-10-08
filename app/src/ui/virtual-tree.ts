import type { PowerlineProject, TreeNode, BusinessObject } from '@gim/powerline-core';
import { esc, icon } from './icons';
interface Row { node: TreeNode; depth: number; kind: string }
export class VirtualTree {
  private rows: Row[] = [];
  private project?: PowerlineProject;
  private objects = new Map<string, BusinessObject>();
  private selected?: string;
  expanded = new Set<string>(['root']);
  mode: 'structure' | 'objects' = 'structure';
  filter = 'all';
  query = '';
  private viewport: HTMLDivElement;
  private content: HTMLDivElement;
  private observer: ResizeObserver;
  private rowHeight = 48;
  constructor(private host: HTMLElement, private onSelect: (id: string) => void, private onState: () => void) {
    host.innerHTML = `<div class="tree-tools"><div class="segmented"><button data-mode="structure" class="active">结构</button><button data-mode="objects">对象</button></div><label class="tree-filter">筛选<select aria-label="对象分类"><option value="all">全部对象</option><option value="tower">杆塔</option><option value="span">档</option><option value="cross">跨越物</option></select></label></div><div class="tree-viewport" role="tree" aria-label="工程对象"><div class="tree-content"></div></div><div class="tree-count"></div>`;
    this.viewport = host.querySelector('.tree-viewport')!; this.content = host.querySelector('.tree-content')!;
    this.viewport.addEventListener('scroll', () => this.render());
    host.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.onclick = () => { this.mode = b.dataset.mode as typeof this.mode; this.rebuild(); this.onState(); });
    host.querySelector('select')!.onchange = e => { this.filter = (e.target as HTMLSelectElement).value; if (this.filter !== 'all') this.mode = 'objects'; this.rebuild(); this.onState(); };
    this.content.onclick = e => { const row = (e.target as Element).closest<HTMLButtonElement>('[data-row]'); if (!row) return; const r = this.rows[Number(row.dataset.row)]; if ((e.target as Element).closest('[data-expand]') && r.node.children.length) { this.expanded.has(r.node.id) ? this.expanded.delete(r.node.id) : this.expanded.add(r.node.id); this.rebuild(); this.onState(); } else this.onSelect(r.node.objectId); };
    this.observer = new ResizeObserver(() => this.render()); this.observer.observe(this.viewport);
  }
  setProject(project: PowerlineProject, expanded?: string[]) { this.project = project; this.objects = new Map(project.objects.map(o => [o.id, o])); this.expanded = new Set(expanded ?? ['root', ...project.tree.children.map(n => n.id)]); this.query = ''; this.rebuild(); }
  search(query: string) { this.query = query.trim().toLowerCase(); this.rebuild(); }
  select(id: string) {
    this.selected = id;
    const selected = this.objects.get(id);
    if (selected && this.filter !== 'all' && this.filter !== selected.kind) this.filter = 'all';
    if (selected && this.query && !`${selected.name} ${selected.type ?? ''}`.toLowerCase().includes(this.query)) this.query = '';
    if (this.mode === 'structure' && !this.query) {
      const find = (node: TreeNode, parents: string[]): string[] | undefined => { if (node.objectId === id) return parents; for (const child of node.children) { const result = find(child, [...parents, node.id]); if (result) return result; } };
      find(this.project!.tree, [])?.forEach(n => this.expanded.add(n));
    }
    this.rebuild(); const index = this.rows.findIndex(r => r.node.objectId === id);
    if (index >= 0) { const top = index * this.rowHeight; if (top < this.viewport.scrollTop || top + this.rowHeight > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = Math.max(0, top - this.viewport.clientHeight / 3); }
    this.render(); this.onState();
  }
  clear() { this.project = undefined; this.objects.clear(); this.rows = []; this.content.innerHTML = ''; this.content.style.height = '0px'; this.host.querySelector('.tree-count')!.textContent = ''; }
  private rebuild() {
    if (!this.project) return;
    const search = this.host.parentElement?.querySelector<HTMLInputElement>('#tree-search'); if (search && search.value !== this.query) search.value = this.query;
    this.rows = [];
    if (this.mode === 'objects' || this.query) {
      const objects = this.project.objects.filter(o => (this.query ? ['line', 'strain', 'tower', 'span', 'cross'] : ['tower', 'span', 'cross']).includes(o.kind) && (this.filter === 'all' || o.kind === this.filter) && (!this.query || `${o.name} ${o.type ?? ''} ${o.lineIds.map(id => this.objects.get(id)?.name).join(' ')} ${o.strainIds.map(id => this.objects.get(id)?.name).join(' ')}`.toLowerCase().includes(this.query)));
      objects.forEach(o => this.rows.push({ node: { id: o.id, objectId: o.id, label: o.name, children: [] }, depth: 0, kind: o.kind }));
    } else {
      const walk = (node: TreeNode, depth: number) => { this.rows.push({ node, depth, kind: this.objects.get(node.objectId)?.kind ?? 'project' }); if (this.expanded.has(node.id)) node.children.forEach(n => walk(n, depth + 1)); }; walk(this.project.tree, 0);
    }
    this.host.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === this.mode));
    this.host.querySelector('select')!.value = this.filter;
    this.content.style.height = `${this.rows.length * this.rowHeight}px`;
    this.host.querySelector('.tree-count')!.textContent = `${this.rows.length} 个可见条目 · 共 ${this.project.counts.tower} 基杆塔 / ${this.project.counts.span} 档 / ${this.project.counts.cross} 跨越`;
    this.render();
  }
  private render() {
    const start = Math.max(0, Math.floor(this.viewport.scrollTop / this.rowHeight) - 5), end = Math.min(this.rows.length, start + Math.ceil(this.viewport.clientHeight / this.rowHeight) + 10);
    this.content.innerHTML = this.rows.slice(start, end).map((r, j) => `<button role="treeitem" aria-selected="${r.node.objectId === this.selected}" ${r.node.children.length ? `aria-expanded="${this.expanded.has(r.node.id)}"` : ''} class="tree-row ${r.node.objectId === this.selected ? 'selected' : ''}" style="top:${(start + j) * this.rowHeight}px;padding-left:${12 + Math.min(4, r.depth) * 16}px" data-row="${start + j}"><span data-expand class="expander ${this.expanded.has(r.node.id) ? 'open' : ''}">${r.node.children.length ? icon('chevron', 14) : ''}</span><span class="object-icon ${r.kind}">${icon(['tower', 'cross', 'span'].includes(r.kind) ? r.kind : 'folder', 18)}</span><span class="row-name">${esc(r.node.label)}</span></button>`).join('');
  }
}
