import './style.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import { horizontalDistance, PREVIEW_VERSION, type PowerlineProject, type BusinessObject, type TowerPreview } from '@gim/powerline-core';
import * as bridge from './native/bridge';
import { ParserWorker } from './core/parser';
import { MapWorkspace, type Camera } from './map/workspace';
import { VirtualTree } from './ui/virtual-tree';
import { icon, esc } from './ui/icons';
import { PluginHost } from './plugins/host';

type InspectorTab = 'overview' | 'attributes' | 'relations' | 'sources';
interface UiState { selected?: string; camera?: Camera; expanded?: string[]; tab?: InspectorTab; treeMode?: 'structure' | 'objects'; filter?: string }
const kindNames = { project: '工程', line: '线路', strain: '耐张段', tower: '杆塔', span: '档', cross: '跨越物' };
const host = document.querySelector<HTMLDivElement>('#app')!;
host.innerHTML = `
  <header class="app-header"><button class="brand-button" id="projects-top" aria-label="我的工程">${icon('tower', 26)}</button><div class="title-block"><h1 id="project-title">线路 GIM</h1><span id="project-subtitle">工程地图 · 现场查看</span></div><button class="header-button" id="search-open" aria-label="搜索工程对象">${icon('search', 22)}</button><button class="header-button" id="settings-open" aria-label="地图设置">${icon('settings', 22)}</button></header>
  <main class="workspace" id="workspace"><aside class="tree-panel" id="tree-panel"><div class="panel-heading"><span>工程导航</span><button class="icon-button compact-only" id="tree-close" aria-label="关闭工程树">${icon('close')}</button></div><label class="tree-search">${icon('search', 18)}<input id="tree-search" placeholder="搜索塔号、塔型、耐张段…" aria-label="搜索工程对象"></label><div id="tree-host"></div></aside>
    <section class="map-region"><div id="map-host"></div><div class="map-caption"><span class="map-chip" id="map-label">无底图工程图</span><span id="map-summary"></span></div><div class="map-toolbar"><button id="layers" aria-label="选择底图">${icon('layers', 21)}</button><button id="gps" aria-label="当前位置">${icon('locate', 21)}</button><button id="fit" aria-label="显示完整工程">${icon('fit', 21)}</button></div><div class="zoom-tools"><button id="zoom-in" aria-label="放大">${icon('plus', 18)}</button><button id="zoom-out" aria-label="缩小"><span class="minus"></span></button></div><div class="map-attribution" id="fallback-attribution">工程坐标 · 无底图</div><div class="empty-welcome" id="welcome"><span class="welcome-mark">${icon('tower', 56)}</span><h2>把线路带到现场</h2><p>导入 GIM，沿地图查看杆塔、档和跨越物。<br>工程文件保存在本机，可离线查阅。</p><button class="primary" id="welcome-import">${icon('plus', 20)} 导入线路工程</button><button class="text-button" id="welcome-projects">查看我的工程</button></div></section>
    <section class="inspector" id="inspector" aria-label="对象详情"><button class="sheet-grip" id="sheet-toggle" aria-label="展开或收起详情"><span></span></button><div class="inspector-heading" id="inspector-heading"></div><div class="inspector-tabs" role="tablist">${[['overview','概览'],['attributes','属性'],['relations','关系'],['sources','来源']].map(([tab, label]) => `<button role="tab" data-tab="${tab}">${label}</button>`).join('')}</div><div class="inspector-content" id="inspector-content"></div></section>
  </main><nav class="bottom-nav" aria-label="主导航"><button id="nav-map" class="active">${icon('map', 22)}<span>地图</span></button><button id="nav-tree">${icon('tree', 22)}<span>工程树</span></button><button id="nav-projects">${icon('folder', 22)}<span>我的工程</span></button></nav><div id="toast" class="toast" role="status" hidden></div><div id="modal-root"></div>`;

class MobileApp {
  private project?: PowerlineProject;
  private objects = new Map<string, BusinessObject>();
  private selected?: string;
  private tab: InspectorTab = 'overview';
  private settings: bridge.Settings = { tiandituKey: '', baseLayer: 'imagery' };
  private parser = new ParserWorker();
  private previewParser = new ParserWorker();
  private map: MapWorkspace;
  private tree: VirtualTree;
  private pluginHost = new PluginHost();
  private session = 0;
  private previewSession = 0;
  private pendingImport?: { id: string; newlyCreated: boolean };
  private importing = false;
  private gpsBusy = false;
  private gpsPosition?: { lon: number; lat: number; accuracy: number; timestamp: number };
  private toastTimer?: ReturnType<typeof setTimeout>;
  private timings: { kind: string; durationMs: number; phases?: { stage: string; durationMs: number }[] }[] = [];
  private phase?: { stage: string; started: number };
  private phases: { stage: string; durationMs: number }[] = [];
  constructor() {
    this.map = new MapWorkspace(this.el('map-host'), id => this.select(id), (message, base) => { this.el('map-label').textContent = message; this.el('fallback-attribution').hidden = base !== 'canvas'; }, () => this.persist());
    this.tree = new VirtualTree(this.el('tree-host'), id => this.select(id, true), () => this.persist());
    this.bind('projects-top', () => void this.showProjects()); this.bind('nav-projects', () => void this.showProjects()); this.bind('welcome-projects', () => void this.showProjects());
    this.bind('welcome-import', () => void this.showImport()); this.bind('nav-tree', () => this.showTree()); this.bind('nav-map', () => this.hideTree()); this.bind('tree-close', () => this.hideTree());
    this.bind('search-open', () => { this.showTree(); (this.el('tree-search') as HTMLInputElement).focus(); });
    this.el('tree-search').addEventListener('input', e => this.tree.search((e.target as HTMLInputElement).value));
    this.bind('settings-open', () => this.showSettings()); this.bind('layers', () => this.showSettings()); this.bind('gps', () => void this.locate());
    this.bind('fit', () => this.map.fit()); this.bind('zoom-in', () => this.map.zoom(1)); this.bind('zoom-out', () => this.map.zoom(-1));
    this.bind('sheet-toggle', () => this.el('inspector').classList.toggle('expanded'));
    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.onclick = () => { this.tab = b.dataset.tab as InspectorTab; this.renderInspector(); this.persist(); });
    window.addEventListener('beforeunload', () => this.persist());
    (window as Window & { gimHandleBack?: () => boolean }).gimHandleBack = () => {
      if (this.importing) { void this.abortImport(); return true; }
      if (this.el('modal-root').querySelector('.modal')) { this.closeModal(); return true; }
      if (this.el('tree-panel').classList.contains('visible')) { this.hideTree(); return true; }
      if (this.el('inspector').classList.contains('expanded')) { this.el('inspector').classList.remove('expanded'); return true; }
      this.persist(); return false;
    };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { this.closeModal(); this.hideTree(); } });
    void this.initialize();
  }
  private el(id: string) { return document.getElementById(id)!; }
  private bind(id: string, action: () => void) { this.el(id).onclick = action; }
  private async initialize() {
    try { this.settings = await bridge.getSettings(); await bridge.saveSettings(this.settings); void this.map.setBase(this.settings); const projects = await bridge.listProjects(); const last = localStorage.getItem('gim-mobile-last-project'); const meta = projects.find(p => p.id === last); if (meta) await this.openProject(meta); }
    catch (error) { this.notify(`初始化失败：${String(error)}`); }
    this.renderInspector();
  }
  private notify(message: string) { clearTimeout(this.toastTimer); this.el('toast').textContent = message; this.el('toast').hidden = false; this.toastTimer = setTimeout(() => { this.el('toast').hidden = true; }, 6000); }
  private showTree() { this.el('tree-panel').classList.add('visible'); this.el('nav-tree').classList.add('active'); this.el('nav-map').classList.remove('active'); }
  private hideTree() { this.el('tree-panel').classList.remove('visible'); this.el('nav-tree').classList.remove('active'); this.el('nav-map').classList.add('active'); }
  private modal(title: string, content: string, actions = '') {
    const root = this.el('modal-root'); root.innerHTML = `<div class="modal-scrim"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-heading"><h2>${esc(title)}</h2><button class="icon-button" id="modal-close" aria-label="关闭">${icon('close')}</button></div><div class="modal-body">${content}</div>${actions ? `<div class="modal-actions">${actions}</div>` : ''}</section></div>`;
    this.bind('modal-close', () => { if (this.importing) void this.abortImport(); else this.closeModal(); });
    root.querySelector('.modal-scrim')!.addEventListener('click', e => { if (e.target === e.currentTarget && !this.importing) this.closeModal(); });
    const dialog = root.querySelector<HTMLElement>('.modal')!;
    dialog.addEventListener('keydown', e => { if (e.key !== 'Tab') return; const focus = [...dialog.querySelectorAll<HTMLElement>('button,input,select,[tabindex]')].filter(n => !n.hasAttribute('disabled')); if (!focus.length) return; if (e.shiftKey && document.activeElement === focus[0]) { e.preventDefault(); focus[focus.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === focus[focus.length - 1]) { e.preventDefault(); focus[0].focus(); } });
    dialog.querySelector<HTMLElement>('button,input,select')?.focus();
  }
  private closeModal() { if (this.importing) { void this.abortImport(); return; } this.el('modal-root').innerHTML = ''; }
  private async showProjects() {
    const projects = await bridge.listProjects();
    this.modal('我的工程', `<div class="project-list">${projects.length ? projects.map((p, i) => `<div class="project-entry"><button data-open="${i}" class="project-open"><span class="project-symbol">${icon('tower', 24)}</span><span><strong>${esc(p.name)}</strong><small>${p.counts.tower ?? '—'} 基杆塔 · ${p.counts.span ?? '—'} 档 · ${(p.size / 1048576).toFixed(1)} MiB</small><small>${p.importedAt ? `导入 ${new Date(p.importedAt * 1000).toLocaleDateString('zh-CN')}` : '本地预览缓存'}${p.parserVersion ? '' : ' · 待完成解析'}</small></span></button><button class="icon-button" data-delete="${i}" aria-label="删除 ${esc(p.name)}">${icon('trash', 18)}</button></div>`).join('') : '<div class="empty-state">尚未导入工程。<br>使用系统文件选择器打开线路 .gim。</div>'}</div>`, `<button class="primary" id="import-project">${icon('plus', 18)}导入工程</button>`);
    this.bind('import-project', () => void this.showImport());
    document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(b => b.onclick = () => { this.closeModal(); void this.openProject(projects[Number(b.dataset.open)]); });
    document.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach(b => b.onclick = () => this.confirmDelete(projects[Number(b.dataset.delete)]));
  }
  private confirmDelete(meta: bridge.ProjectMeta) {
    this.modal('删除本地工程', `<p>删除「${esc(meta.name)}」的源包、SQLite 缓存、塔形预览与工程设置。再次查看时需要重新导入。</p>`, '<button class="secondary" id="delete-cancel">保留工程</button><button class="danger" id="delete-confirm">删除工程</button>');
    this.bind('delete-cancel', () => void this.showProjects()); this.bind('delete-confirm', () => void (async () => {
      try { await bridge.deleteProject(meta.id); localStorage.removeItem(`gim-mobile-ui:${meta.id}`); if (this.project?.id === meta.id) { this.persist(); localStorage.removeItem(`gim-mobile-ui:${meta.id}`); localStorage.removeItem('gim-mobile-last-project'); this.project = undefined; this.objects.clear(); this.tree.clear(); this.selected = undefined; this.el('project-title').textContent = '线路 GIM'; this.el('project-subtitle').textContent = '工程地图 · 现场查看'; this.el('welcome').hidden = false; this.el('workspace').classList.remove('has-project'); this.el('map-summary').textContent = ''; this.map.setProject({ objects: [], bounds: undefined } as unknown as PowerlineProject); this.renderInspector(); } await this.showProjects(); }
      catch (error) { this.notify(`删除失败：${String(error)}`); }
    })());
  }
  private async showImport() {
    if (this.importing) return;
    if (bridge.native) { await this.importNative(); return; }
    const samples = await bridge.sampleNames();
    this.modal('导入线路工程', `<p>Android 应用通过系统文件选择器导入 .gim，文件仅保存在应用私有目录。</p>${bridge.previewMode ? `<label class="field">本地浏览器开发预览<select id="sample-select">${samples.map(s => `<option>${esc(s)}</option>`).join('')}</select></label><p class="muted">这些输入由本机 demo 源包读取，正式应用中没有样本入口。</p>` : ''}`, bridge.previewMode ? '<button class="primary" id="sample-import">打开本地样本</button>' : '');
    if (bridge.previewMode) this.bind('sample-import', () => void this.importSample((this.el('sample-select') as HTMLSelectElement).value));
  }
  private progress(p: bridge.ImportProgress) {
    if (this.phase?.stage !== p.stage) { if (this.phase) this.phases.push({ stage: this.phase.stage, durationMs: performance.now() - this.phase.started }); this.phase = { stage: p.stage, started: performance.now() }; }
    const label = this.el('progress-label'); if (!label) return; label.textContent = p.stage;
    const progress = this.el('import-progress') as HTMLProgressElement;
    if (p.total != null && p.total > 0 && p.done != null) { progress.max = p.total; progress.value = p.done; this.el('progress-detail').textContent = p.total > 100000 ? `${(p.done / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MiB` : `${p.done.toLocaleString()} / ${p.total.toLocaleString()}`; }
    else { progress.removeAttribute('value'); this.el('progress-detail').textContent = p.done ? `${p.done.toLocaleString()} 个条目` : '正在处理'; }
  }
  private beginImport() {
    this.phase = undefined; this.phases = []; this.importing = true; const token = ++this.session;
    this.modal('打开线路工程', '<div class="import-status"><span class="import-mark">'+icon('folder', 36)+'</span><strong id="progress-label">选择文件</strong><progress id="import-progress"></progress><span id="progress-detail">正在处理</span><p class="muted">文件与缓存保存在本机，完成后进入工程地图。</p></div>', '<button class="secondary" id="import-cancel">取消导入</button>');
    this.bind('import-cancel', () => void this.abortImport()); return token;
  }
  private async abortImport() {
    ++this.session; this.parser.cancel(); await bridge.cancelImport();
    if (this.pendingImport?.newlyCreated) await bridge.deleteProject(this.pendingImport.id).catch(() => {});
    this.pendingImport = undefined; this.importing = false; this.closeModal(); this.notify('导入已取消');
  }
  private async importNative() {
    const token = this.beginImport(); let remove = () => {}; let started = performance.now();
    try {
      remove = await bridge.importProgress(p => { if (token === this.session) this.progress(p); });
      const input = await bridge.chooseNativeFile(p => { if (token === this.session) this.progress(p); }); if (token !== this.session) { await bridge.discardImport(input.path); return; }
      started = performance.now() - input.copyMs;
      const prepared = await bridge.prepareNative(input); this.pendingImport = { id: prepared.meta.id, newlyCreated: !prepared.duplicate };
      if (token !== this.session) { if (!prepared.duplicate) await bridge.deleteProject(prepared.meta.id); return; }
      let p = prepared.cache ?? undefined;
      if (!p) { const files = await bridge.readEntries(prepared.meta.id); p = await this.parser.project(files, { id: prepared.meta.id, name: prepared.meta.name, sha256: prepared.meta.sha256, size: prepared.meta.size }, v => this.progress(v)); this.progress({ stage: '保存本地缓存' }); if (token !== this.session) return; await bridge.commit(p); }
      if (token !== this.session) return; this.activate(p); this.timings.push({ kind: prepared.cache ? 'duplicate-warm-open' : 'cold-import', durationMs: performance.now() - started, phases: [...this.phases, ...(this.phase ? [{ stage: this.phase.stage, durationMs: performance.now() - this.phase.started }] : [])].map(p => p.stage === "复制文件与 SHA 校验" ? { ...p, durationMs: input.copyMs } : p) }); this.pendingImport = undefined; this.importing = false; this.closeModal(); if (prepared.duplicate) this.notify('已存在相同源包，打开本地工程');
    } catch (error) { if (token === this.session) { if (this.pendingImport?.newlyCreated) await bridge.deleteProject(this.pendingImport.id).catch(() => {}); this.pendingImport = undefined; this.importing = false; this.closeModal(); this.notify(String(error)); } }
    finally { remove(); }
  }
  private async importSample(name: string) {
    const token = this.beginImport(), started = performance.now();
    try {
      this.progress({ stage: '读取本地预览输入' }); const data = await bridge.prepareSample(name); if (token !== this.session) return;
      const cached = await bridge.loadCache(data.identity.id); const project = cached ?? await this.parser.project(data.files, data.identity, p => this.progress(p));
      if (token !== this.session) return; if (!cached) { this.progress({ stage: '保存预览缓存' }); await bridge.commit(project); }
      this.activate(project); this.timings.push({ kind: cached ? 'browser-warm-preview' : 'browser-cold-preview', durationMs: performance.now() - started }); this.importing = false; this.closeModal();
    } catch (error) { if (token === this.session) { this.importing = false; this.closeModal(); this.notify(String(error)); } }
  }
  private async openProject(meta: bridge.ProjectMeta) {
    this.persist(); const token = this.beginImport(), start = performance.now();
    try {
      this.progress({ stage: '恢复本地缓存' }); let project = await bridge.loadCache(meta.id);
      if (!project) { this.progress({ stage: '更新工程索引' }); const files = await bridge.readEntries(meta.id); project = await this.parser.project(files, { id: meta.id, name: meta.name, sha256: meta.sha256, size: meta.size }, p => this.progress(p)); if (token !== this.session) return; await bridge.commit(project); }
      if (token !== this.session) return; this.activate(project); this.timings.push({ kind: 'warm-open', durationMs: performance.now() - start }); this.importing = false; this.closeModal();
    } catch (error) { if (token === this.session) { this.importing = false; this.closeModal(); this.notify(`打开失败：${String(error)}`); } }
  }
  private activate(project: PowerlineProject) {
    this.persist(); this.project = project; this.objects = new Map(project.objects.map(o => [o.id, o]));
    let state: UiState = {}; try { state = JSON.parse(localStorage.getItem(`gim-mobile-ui:${project.id}`) ?? '{}'); } catch { /* damaged UI preferences do not damage project data */ }
    this.selected = state.selected && this.objects.has(state.selected) ? state.selected : project.tree.objectId; this.tab = state.tab ?? 'overview';
    this.tree.mode = state.treeMode ?? 'structure'; this.tree.filter = state.filter ?? 'all'; this.tree.setProject(project, state.expanded); this.tree.select(this.selected!);
    this.el('workspace').classList.add('has-project'); this.map.refreshLayout();
    this.map.setProject(project, state.camera); this.map.select(this.selected!); this.el('project-title').textContent = project.name; this.el('project-subtitle').textContent = `${project.counts.line} 条线路 · ${project.counts.tower} 基杆塔`;
    this.el('map-summary').textContent = `${project.counts.tower} 塔 · ${project.counts.span} 档 · ${project.counts.cross} 跨越`;
    this.el('welcome').hidden = true; localStorage.setItem('gim-mobile-last-project', project.id); this.renderInspector(); this.persist();
    void this.pluginHost.load({ id: project.id, name: project.name, sourceSha256: project.sourceSha256, towerIds: project.objects.filter(o => o.kind === 'tower').map(o => o.id), lineIds: project.objects.filter(o => o.kind === 'line').map(o => o.id) }).catch(() => {});
  }
  private persist() { if (!this.project) return; const value: UiState = { selected: this.selected, tab: this.tab, camera: this.map.getCamera(), expanded: [...this.tree.expanded], treeMode: this.tree.mode, filter: this.tree.filter }; localStorage.setItem(`gim-mobile-ui:${this.project.id}`, JSON.stringify(value)); }
  private select(id: string, focus = false) { if (!this.objects.has(id)) return; this.selected = id; this.tree.select(id); this.map.select(id, focus); this.el('inspector').classList.remove('expanded'); this.hideTree(); this.renderInspector(); this.persist(); }
  private renderInspector() {
    const object = this.selected ? this.objects.get(this.selected) : undefined;
    const title = this.el('inspector-heading'), content = this.el('inspector-content');
    if (!object || !this.project) { title.innerHTML = '<div><span class="eyebrow">工程详情</span><h2>选择地图上的对象</h2></div>'; content.innerHTML = '<p class="muted">塔位、物理档与跨越物会在这里显示。</p>'; return; }
    title.innerHTML = `<span class="selection-icon ${object.kind}">${icon(['tower', 'span', 'cross'].includes(object.kind) ? object.kind : 'folder', 26)}</span><div><span class="eyebrow">${kindNames[object.kind]}${object.type ? ' · '+esc(object.type) : ''}</span><h2>${esc(object.name)}</h2></div><button class="icon-button" id="focus-object" aria-label="定位到所选对象">${icon('fit', 19)}</button>`;
    this.bind('focus-object', () => this.map.fit(object));
    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => { b.classList.toggle('active', b.dataset.tab === this.tab); b.setAttribute('aria-selected', String(b.dataset.tab === this.tab)); });
    this.previewSession++; this.previewParser.cancel();
    if (this.tab === 'overview') this.renderOverview(object, content);
    if (this.tab === 'attributes') content.innerHTML = `<div class="attribute-table">${object.attributes.map(a => `<div class="attribute-row"><span>${esc(a.label)}</span><strong>${esc(a.value || '—')}</strong><small>${esc(a.key)} · ${esc(a.source.split('/').pop())}</small></div>`).join('')}</div>`;
    if (this.tab === 'relations') this.renderRelations(object, content);
    if (this.tab === 'sources') this.renderSources(object, content);
  }
  private values(values: [string, unknown][]) { return `<dl class="values">${values.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value ?? '未提供')}</dd></div>`).join('')}</dl>`; }
  private renderOverview(o: BusinessObject, content: HTMLElement) {
    const coordinate = o.coordinate;
    const location: [string, unknown][] = coordinate ? [['纬度', coordinate[1].toFixed(7)+'°'], ['经度', coordinate[0].toFixed(7)+'°'], ['高程', coordinate[2] != null ? coordinate[2].toFixed(2)+' m' : undefined]] : [];
    let fields: [string, unknown][] = [];
    if (o.kind === 'tower') fields = [['塔型', o.type], ['呼称高', o.height ? `${o.height} m` : undefined], ...location, ['方位角', Number.isFinite(o.azimuth) ? o.azimuth!.toFixed(2)+'°' : undefined], ['所属线路', o.lineIds.map(id => this.objects.get(id)?.name).join(' / ')], ['耐张段', o.strainIds.map(id => this.objects.get(id)?.name).join(' / ')]];
    else if (o.kind === 'span') fields = [['起始塔', this.objects.get(o.startTowerId ?? '')?.name], ['终止塔', this.objects.get(o.endTowerId ?? '')?.name], ['水平档距', o.horizontalMeters != null ? o.horizontalMeters.toFixed(2)+' m' : undefined], ['三维直线距离', o.spatialMeters != null ? o.spatialMeters.toFixed(2)+' m' : undefined], ['原始导线记录', o.rawWireIds?.length], ...Object.entries(o.wireCounts ?? {}).map(([key, value]): [string, unknown] => [key, value]), ['耐张段', o.strainIds.map(id => this.objects.get(id)?.name).join(' / ')]];
    else if (o.kind === 'cross') fields = [['类型 / 业务码', o.type], ...location, ['几何点数', o.geometry?.length ?? 0], ['所属线路', o.lineIds.map(id => this.objects.get(id)?.name).join(' / ')], ['耐张段', o.strainIds.map(id => this.objects.get(id)?.name).join(' / ')]];
    else {
      const members = o.kind === 'project' ? this.project!.objects : this.project!.objects.filter(v => v.lineIds.includes(o.id) || v.strainIds.includes(o.id));
      fields = [['杆塔', members.filter(v => v.kind === 'tower').length+' 基'], ['物理档', members.filter(v => v.kind === 'span').length+' 档'], ['跨越物', members.filter(v => v.kind === 'cross').length+' 处'], ['去重档水平长度', (members.filter(v => v.kind === 'span').reduce((s, v) => s+(v.horizontalMeters ?? 0), 0)/1000).toFixed(3)+' km'], ['源线路长度', o.attributes.filter(a => a.key.toUpperCase() === 'LINELENGTH').map(a => a.value+' km').join(' / ') || '参见各线路属性']];
    }
    const warnings = this.project!.findings.filter(f => f.objectId === o.id || o.kind === 'project').slice(0, 5);
    content.innerHTML = `<div class="overview-grid"><div>${this.values(fields)}${o.kind === 'tower' ? '<div id="tower-distance" class="distance-box"></div><button class="text-button" id="distance-refresh">'+icon('locate', 16)+' 当前位置与该塔距离</button>' : ''}</div>${o.kind === 'tower' ? '<section class="tower-preview"><div class="preview-title">塔形 · X/Z</div><div id="preview-host" class="preview-host"><span class="muted">'+(o.previewRef ? '读取塔形…' : '未提供 HNum 塔形')+'</span></div><button class="text-button" id="preview-reset">重置视图</button></section>' : ''}</div>${warnings.length ? `<button class="finding-strip" id="show-findings">${icon('info', 16)} ${this.project!.findings.filter(f => f.objectId === o.id || o.kind === 'project').length} 条工程诊断 · 查看详情</button>` : ''}`;
    if (o.kind === 'tower') { this.bind('distance-refresh', () => void this.locate(false)); this.updateDistance(o); if (o.previewRef) void this.loadPreview(o); }
    if (warnings.length) this.bind('show-findings', () => this.showFindings(o));
  }
  private renderRelations(o: BusinessObject, content: HTMLElement) {
    const related = [...new Set([...o.lineIds, ...o.strainIds, ...o.relatedIds])].filter(id => id !== o.id);
    content.innerHTML = `<div class="relation-list">${related.map(id => { const v = this.objects.get(id); if (!v) return ''; return `<button data-related="${esc(id)}">${icon(['tower','span','cross'].includes(v.kind) ? v.kind : 'folder', 18)}<span><strong>${esc(v.name)}</strong><small>${kindNames[v.kind]}</small></span>${icon('chevron', 14)}</button>`; }).join('')}</div><div class="raw-wire-list">${(o.rawWireIds ?? o.relatedIds.filter(id => id.startsWith('wire:'))).map(id => { const wire = this.project!.rawWires.find(w => w.id === id); return wire ? `<button class="raw-wire-button" data-wire="${esc(id)}">${esc(wire.type)}${wire.jumper ? ' · 同塔跳线' : ''}<small>${esc(wire.sourcePath.split('/').pop())}</small>${icon('chevron', 14)}</button>` : ''; }).join('')}</div>${!related.length && !o.rawWireIds?.length ? '<p class="muted">没有可用的关联对象。</p>' : ''}`;
    content.querySelectorAll<HTMLButtonElement>('[data-related]').forEach(b => b.onclick = () => this.select(b.dataset.related!, true));
    content.querySelectorAll<HTMLButtonElement>('[data-wire]').forEach(b => b.onclick = () => { const wire = this.project!.rawWires.find(w => w.id === b.dataset.wire)!; this.modal('原始导线记录', `${this.values([['类型', wire.type], ['同塔跳线', wire.jumper ? '是' : '否'], ['端点 0', wire.start?.join(', ')], ['端点 1', wire.end?.join(', ')]])}<pre>${esc(wire.attributes.map(a => `${a.label}=${a.value}`).join('\n'))}</pre>`); });
  }
  private renderSources(o: BusinessObject, content: HTMLElement) {
    content.innerHTML = `<p class="source-note">仅查看与当前对象关联的来源，按需读取单个文件。</p>${o.sourceRefs.filter(p => /\.(cbm|fam|dev|phm|mod)$/i.test(p)).map((path, i) => `<details class="source-entry" data-source="${i}"><summary><span>${esc(path)}</span><small>${path.split('.').pop()!.toUpperCase()}</small></summary><pre>展开后读取</pre></details>`).join('')}`;
    const token = this.previewSession, projectId = this.project!.id;
    content.querySelectorAll<HTMLDetailsElement>('[data-source]').forEach(d => d.ontoggle = () => { if (!d.open || d.dataset.loaded) return; d.dataset.loaded = 'true'; const path = o.sourceRefs.filter(p => /\.(cbm|fam|dev|phm|mod)$/i.test(p))[Number(d.dataset.source)]; d.querySelector('pre')!.textContent = '读取中…'; void bridge.readSource(projectId, path).then(text => { if (token === this.previewSession) d.querySelector('pre')!.textContent = text; }).catch(() => { d.querySelector('pre')!.textContent = '来源读取失败'; d.dataset.loaded = ''; }); });
  }
  private showFindings(object: BusinessObject) {
    const findings = this.project!.findings.filter(f => f.objectId === object.id || object.kind === 'project');
    this.modal('工程诊断', `<p class="muted">局部数据问题保留原始来源，不阻断其他对象查看。</p><div class="findings">${findings.map(f => `<div><span class="severity ${f.severity.toLowerCase()}">${esc(f.severity)}</span><p>${esc(f.message)}</p><small>${esc(f.code)}${f.source ? ' · '+esc(f.source) : ''}</small></div>`).join('')}</div>`);
  }
  private async loadPreview(object: BusinessObject) {
    const token = this.previewSession, project = this.project!;
    try { const key = `${project.sourceSha256}:${object.previewRef}:${PREVIEW_VERSION}`; let preview = await bridge.previewCache(project.id, key); if (!preview) { const text = await bridge.readSource(project.id, object.previewRef!); if (token !== this.previewSession) return; preview = await this.previewParser.preview(text, object.previewRef!); await bridge.previewCache(project.id, key, preview); } if (token !== this.previewSession) return; this.drawPreview(preview); }
    catch { if (token === this.previewSession) this.el('preview-host').innerHTML = '<span class="muted">塔形暂不可用<br>可在来源页查看原始 MOD</span>'; }
  }
  private drawPreview(preview: TowerPreview) {
    const [minX, minZ, maxX, maxZ] = preview.bounds, width = Math.max(1, maxX - minX), height = Math.max(1, maxZ - minZ), margin = Math.max(width, height)*0.04;
    const initial = [minX-margin, -maxZ-margin, width+2*margin, height+2*margin]; let box = [...initial];
    const container = this.el('preview-host'); container.innerHTML = `<svg viewBox="${box.join(' ')}" preserveAspectRatio="xMidYMid meet" aria-label="杆塔二维骨架" role="img"><path d="${preview.segments.map(([a,b,c,d]) => `M${a} ${-b}L${c} ${-d}`).join('')}" fill="none" stroke="#346ea2" stroke-width=".7" vector-effect="non-scaling-stroke"/></svg>`;
    const svg = container.querySelector('svg')!; const update = () => svg.setAttribute('viewBox', box.join(' '));
    let drag: [number,number] | undefined;
    svg.addEventListener('pointerdown', e => { svg.setPointerCapture(e.pointerId); drag = [e.clientX,e.clientY]; });
    svg.addEventListener('pointermove', e => { if (!drag) return; const scale = Math.max(box[2]/svg.clientWidth,box[3]/svg.clientHeight); box[0] -= (e.clientX-drag[0])*scale; box[1] -= (e.clientY-drag[1])*scale; drag = [e.clientX,e.clientY]; update(); });
    svg.addEventListener('pointerup', () => { drag = undefined; }); svg.addEventListener('pointercancel', () => { drag = undefined; });
    svg.addEventListener('wheel', e => { e.preventDefault(); const factor = e.deltaY > 0 ? 1.15 : .87; box[0]+=(box[2]-box[2]*factor)/2; box[1]+=(box[3]-box[3]*factor)/2; box[2]*=factor; box[3]*=factor; update(); },{passive:false});
    const zoom = (factor: number) => { if (box[2]*factor < initial[2]/20 || box[2]*factor > initial[2]*20) return; box[0]+=(box[2]-box[2]*factor)/2; box[1]+=(box[3]-box[3]*factor)/2; box[2]*=factor; box[3]*=factor; update(); };
    const controls = document.createElement('div'); controls.className = 'preview-zoom-controls';
    controls.innerHTML = '<button class="text-button" aria-label="放大塔形">＋</button><button class="text-button" aria-label="缩小塔形">−</button>';
    container.after(controls); const [zoomIn,zoomOut] = controls.querySelectorAll<HTMLButtonElement>('button'); zoomIn.onclick = () => zoom(.8); zoomOut.onclick = () => zoom(1.25);
    this.bind('preview-reset', () => { box = [...initial]; update(); });
  }
  private showSettings() {
    this.modal('地图设置', `<label class="field">底图<select id="base-layer">${[['imagery','天地图 · 影像'],['vector','天地图 · 矢量'],['terrain','天地图 · 地形'],['osm','OpenStreetMap'],['canvas','无底图工程图']].map(([v,n]) => `<option value="${v}" ${v === this.settings.baseLayer ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label class="field">天地图密钥<input type="password" id="tdt-key" autocomplete="off" spellcheck="false" placeholder="输入天地图访问密钥" value="${esc(this.settings.tiandituKey)}"></label><p class="muted">密钥保存在本机。在线底图请求发送至相应地图服务，工程文件不上传。</p><button class="text-button" id="show-diagnostics">查看本机运行信息</button>`, '<button class="primary" id="settings-save">保存设置</button>');
    this.bind('settings-save', () => void (async () => { const settings = { baseLayer: (this.el('base-layer') as HTMLSelectElement).value as bridge.Settings['baseLayer'], tiandituKey: (this.el('tdt-key') as HTMLInputElement).value.trim() }; try { await bridge.saveSettings(settings); this.settings = settings; this.closeModal(); await this.map.setBase(settings); } catch { this.notify('设置保存失败，请检查密钥格式'); } })());
    this.bind('show-diagnostics', () => { const data = { parserVersion: this.project?.parserVersion, counts: this.project?.counts, findingCount: this.project?.findings.length ?? 0, timings: this.timings.map(t => ({ kind: t.kind, durationMs: Math.round(t.durationMs), phases: t.phases?.map(p => ({stage:p.stage,durationMs:Math.round(p.durationMs)})) })) }; this.modal('本机运行信息', '<pre>'+esc(JSON.stringify(data,null,2))+'</pre><p class="muted">这些记录不包含地图密钥、当前位置或源文件正文，不会自动上传。</p>'); });
  }
  private async locate(center = true) {
    if (this.gpsBusy) return;
    if (localStorage.getItem('gim-mobile-location-consent') !== 'yes') {
      this.modal('使用当前位置', '<p>仅在你点击定位时读取一次当前位置，用于地图标记与到杆塔的水平直线距离。</p><p>不持续跟踪，不在后台定位，不上传或保存位置。距离仅用于现场查看。</p>', '<button class="secondary" id="location-cancel">暂不使用</button><button class="primary" id="location-confirm">继续定位</button>');
      this.bind('location-cancel', () => this.closeModal()); this.bind('location-confirm', () => { localStorage.setItem('gim-mobile-location-consent','yes'); this.closeModal(); void this.locate(center); }); return;
    }
    this.gpsBusy = true; this.el('gps').classList.add('busy');
    try {
      if (!bridge.native) throw new Error('定位需在 Android 应用中使用');
      let permission = await bridge.checkLocationPermissions();
      if (permission.coarseLocation !== 'granted' && (permission.location === 'prompt' || permission.location === 'prompt-with-rationale')) permission = await bridge.requestLocationPermissions();
      if (permission.location !== 'granted' && permission.coarseLocation !== 'granted') throw new Error('未授予前台定位权限，可在 Android 设置中开启');
      const position = await bridge.getPosition();
      const p = { coords: position, timestamp: position.timestamp };
      this.gpsPosition = { lon: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy, timestamp: p.timestamp };
      this.map.setGps([p.coords.longitude,p.coords.latitude],p.coords.accuracy); if (center) this.map.locateGps();
      const tower = this.selected ? this.objects.get(this.selected) : undefined; if (tower?.kind === 'tower') this.updateDistance(tower);
      this.notify(`已定位 · 精度约 ${Math.round(p.coords.accuracy)} m`);
    } catch (error) { this.notify(String(error)); }
    finally { this.gpsBusy = false; this.el('gps').classList.remove('busy'); }
  }
  private updateDistance(tower: BusinessObject) {
    const el = document.getElementById('tower-distance'); if (!el) return;
    if (!this.gpsPosition || !tower.coordinate) { el.textContent = tower.coordinate ? '尚未读取当前位置' : '杆塔缺少坐标，无法计算距离'; return; }
    const p = this.gpsPosition, meters = horizontalDistance([p.lon,p.lat],tower.coordinate);
    el.innerHTML = `<strong>${meters >= 1000 ? (meters/1000).toFixed(2)+' km' : meters.toFixed(0)+' m'}</strong><span>水平直线距离 · 精度约 ${Math.round(p.accuracy)} m<br>${new Date(p.timestamp).toLocaleTimeString('zh-CN')}</span>`;
  }
}
new MobileApp();
