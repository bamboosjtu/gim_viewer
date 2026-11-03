import type { AppState } from '../app/state.js';
import { cbmTreePanel } from './dom.js';
import { renderSearchBox } from './searchBox.js';
import { renderVirtualOutline, type OutlineElement, type OutlineNode } from './virtualOutline.js';
import { getEngineeringNavigation, type EngineeringNavigationData } from '../services/engineeringViewService.js';
import { setEngineeringDeviceCount } from './shell/statusBar.js';
import { downloadEngineeringTree, copyEngineeringTree } from './engineeringTreeExport.js';

interface Navigation {
  generation: number;
  data: EngineeringNavigationData | null;
  mode: AppState['engineeringNavMode'];
  bar: HTMLElement;
  quality: HTMLElement;
  outline?: OutlineElement;
  query: { composition: string; source: string; inventory:string };
  scroll: { composition: number; source: number; inventory:number };
  listener: () => void;
}
const navigations = new WeakMap<AppState, Navigation>();

function rowKey(state: AppState, data: EngineeringNavigationData): string {
  const target = state.selectionRequest?.target;
  if (!target) return '';
  if(state.engineeringNavMode==='inventory'){
    if(target.kind==='engineering-group')return data.inventory?.nodes.has(target.key)?target.key:'';
    if(target.kind==='engineering-source')return data.inventory?.rowsBySource.get(target.key)??'';
    return target.kind==='engineering'?data.inventory?.rowsByEntity.get(target.key)?.[0]??'':'';
  }
  if (state.engineeringNavMode === 'composition') {
    if (target.kind === 'engineering-group') return data.composition.nodes.has(target.key) ? target.key : '';
    const owner = target.kind === 'engineering' ? target.key
      : state.engineeringSnapshot?.memberships.find(m => m.sourceId === target.key)?.ownerId;
    return owner ? data.composition.rowsByEntity.get(owner)?.[0] ?? '' : '';
  }
  if (target.kind === 'engineering-source') {
    if (target.key.startsWith('context:')) {
      const key = `source:spatial:${target.key.slice('context:'.length)}`; return data.sourceNodes.has(key) ? key : '';
    }
    if (data.sourceRows.has(target.key)) return data.sourceRows.get(target.key)!;
    const cbm = `source:cbm:${target.key}`;
    if (data.sourceNodes.has(cbm)) return cbm;
    if (target.key.startsWith('document:')) {
      const path = target.key.slice('document:'.length);
      const matches = [...data.sourceNodes.values()].filter(n => n.documentPath === path && n.kind !== 'record');
      return matches.length === 1 ? matches[0].key : '';
    }
  }
  if (target.kind === 'engineering') {
    const source = state.engineeringSnapshot?.memberships.find(m => m.ownerId === target.key);
    return source ? data.sourceRows.get(source.sourceId) ?? '' : '';
  }
  return '';
}

function qualityText(state: AppState): string {
  const snapshot = state.engineeringSnapshot;
  if (!snapshot) return state.engineeringStatus === 'error' ? '工程来源未能建立' : '正在建立工程来源…';
  return `整体候选 ${snapshot.entities.length.toLocaleString()} · 待归集合 ${snapshot.pending.length.toLocaleString()}`
    + (state.engineeringStatus === 'partial' ? ' · 来源未完成' : state.engineeringStatus === 'error' ? ' · 来源未完成' : '');
}

function qualityDetail(state: AppState): string {
  const labels: Record<string, string> = {
    'ifc-manifest-incomplete': '部分 IFC 来源尚未完成读取',
    'ifc-parse-failed': '部分 IFC 来源未能解析',
    'ifc-spatial-context-incomplete': '部分 IFC 对象的空间来源尚不完整',
    'source-graph-incomplete': '部分来源引用存在缺失或循环',
    'source-reference-unresolved': '部分来源文件引用未能解析',
  };
  return [state.engineeringError, ...(state.engineeringSources?.incompleteReasons ?? []).map(reason => labels[reason] ?? '部分来源尚未确认完整')]
    .filter(Boolean).join('；');
}

/** Opens ancestors in the logical projection, including rows outside the DOM
 * window. A view row never becomes an entity or a physical occurrence.
 */
export function syncEngineeringTreeSelection(state: AppState): void {
  const nav = navigations.get(state);
  if (!nav?.data || !nav.outline?.isConnected || nav.generation !== state.projectGeneration) return;
  const key = rowKey(state, nav.data);
  if (!key) {
    cbmTreePanel.querySelectorAll('.tree-row.selected').forEach(row => row.classList.remove('selected'));
    return;
  }
  const expanded = state.engineeringExpandedRows[state.engineeringNavMode];
  const nodes = state.engineeringNavMode === 'composition' ? nav.data.composition.nodes : state.engineeringNavMode==='inventory'?nav.data.inventory!.nodes:nav.data.sourceNodes;
  let cursor = nodes.get(key)?.parent;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) { seen.add(cursor); expanded.add(cursor); cursor = nodes.get(cursor)?.parent; }
  nav.outline.__gimRevealOutline?.(key);
}

export function renderEngineeringTree(state: AppState): void {
  if (state.currentProjectType !== 'substation') return;
  setEngineeringDeviceCount(state.engineeringSnapshot ? state.engineeringSnapshot.entities.filter(entity => entity.category.startsWith('E')).length : null);
  let nav = navigations.get(state);
  if (!nav || nav.generation !== state.projectGeneration || !state.engineeringListeners.has(nav.listener)) {
    state.engineeringNavigationCleanup?.();
    const listener = () => renderEngineeringTree(state);
    nav = { generation: state.projectGeneration, data: null, mode: state.engineeringNavMode,
      bar: document.createElement('div'), quality: document.createElement('span'), query: { composition: '', source: '', inventory:'' }, scroll: { composition: 0, source: 0, inventory:0 }, listener };
    navigations.set(state, nav); state.engineeringListeners.add(listener);
    const owned = nav;
    state.engineeringNavigationCleanup = () => {
      state.engineeringListeners.delete(listener);
      if (navigations.get(state) === owned) { navigations.delete(state); state.engineeringNavigationCleanup = null; }
    };
  }
  const data = getEngineeringNavigation(state), mode = state.engineeringNavMode;
  if (nav.data === data && nav.mode === mode && cbmTreePanel.contains(nav.bar)) {
    nav.quality.textContent = qualityText(state); nav.quality.title = qualityDetail(state);
    return;
  }
  if (cbmTreePanel.contains(nav.bar)) {
    nav.query[nav.mode] = cbmTreePanel.querySelector<HTMLInputElement>('.search-box-wrap input')?.value ?? '';
    nav.scroll[nav.mode] = cbmTreePanel.scrollTop;
  }
  nav.data = data; nav.mode = mode; nav.outline = undefined;
  cbmTreePanel.replaceChildren();
  const bar = document.createElement('div'); bar.className = 'substation-nav-mode'; nav.bar = bar;
  bar.style.flexWrap='wrap';
  for (const [value, label] of [['composition', '工程组成'], ['source', '来源'],['inventory','设备材料清册']] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'substation-nav-mode-btn';
    button.dataset.engineeringMode = value; button.textContent = label; button.classList.toggle('active', value === mode);
    button.setAttribute('aria-pressed', String(value === mode));
    button.addEventListener('click', () => { state.engineeringNavMode = value; renderEngineeringTree(state); }); bar.append(button);
  }
  const quality = document.createElement('span'); quality.className = 'substation-nav-quality'; quality.textContent = qualityText(state);
  quality.title = qualityDetail(state); nav.quality = quality; bar.append(quality);
  const generationForExport=state.projectGeneration;
  const feedback=document.createElement('span');feedback.id='engineering-tree-feedback';feedback.setAttribute('role','status');feedback.style.cssText='flex-basis:100%;font-size:11px;color:#94a3b8';
  const message=(text:string)=>{if(state.projectGeneration===generationForExport){const target=cbmTreePanel.querySelector<HTMLElement>('#engineering-tree-feedback');if(target)target.textContent=text;}};
  for(const copy of [false,true]){
    const button=document.createElement('button');button.type='button';button.className='substation-nav-export';button.textContent=copy?'复制 JSON':'导出 JSON';button.setAttribute('aria-label',copy?'复制当前模型树为 JSON':'导出当前模型树为 JSON');button.disabled=!data;
    button.style.cssText='padding:3px 7px;font-size:12px;background:#1e293b;color:#e2e8f0;border:1px solid #475569;border-radius:4px';
    button.addEventListener('click',()=>{if(!data)return;button.disabled=true;message(copy?'正在复制模型树…':'正在导出模型树…');
      void(copy?copyEngineeringTree(data,mode,state.projectName).then(()=>message('模型树 JSON 已复制到剪贴板')):downloadEngineeringTree(data,mode,state.projectName).then(path=>message(path?`模型树已保存/下载：${path}`:'已取消导出')))
        .catch(error=>{message(`${copy?'复制':'导出'}失败：${String(error)}`);console.warn('[模型树导出]',error);}).finally(()=>{button.disabled=false;});});bar.append(button);
  }bar.append(feedback);
  const host = document.createElement('div'); host.className = 'tree-view-host'; host.setAttribute('role', 'tree'); cbmTreePanel.append(bar, host);
  if (!data) {
    const empty = document.createElement('div'); empty.className = 'props-empty';
    empty.textContent = state.engineeringError || (mode === 'source' ? '正在读取来源引用与装配…' : '正在识别工程整体…'); host.append(empty); return;
  }
  const generation = state.projectGeneration;
  const select = async (key: string) => {
    if (generation !== state.projectGeneration || navigations.get(state)?.data !== data) return;
    try {
      if (mode === 'composition' || mode==='inventory') {
        const node = mode==='inventory'?data.inventory!.nodes.get(key):data.composition.nodes.get(key);
        if (!node) return;
        if('sourceId' in node && node.sourceId){const target={kind:'engineering-source' as const,key:node.sourceId},request=state.beginSelection(target);syncEngineeringTreeSelection(state);const {selectEngineeringTarget}=await import('../services/engineeringSelection.js');if(state.isCurrentSelection(request))await selectEngineeringTarget(state,target,request);return;}
        const target = node.targetId ? { kind: 'engineering' as const, key: node.targetId } : { kind: 'engineering-group' as const, key };
        const request = state.beginSelection(target); syncEngineeringTreeSelection(state);
        const { selectEngineeringTarget } = await import('../services/engineeringSelection.js');
        if (state.isCurrentSelection(request)) await selectEngineeringTarget(state, target, request);
      } else {
        const node = data.sourceNodes.get(key); if (!node) return;
        if (node.kind === 'spatial') {
          const contextKey = key.slice('source:spatial:'.length);
          const request = state.beginSelection({ kind: 'engineering-source', key: `context:${contextKey}` }); syncEngineeringTreeSelection(state);
          const { inspectEngineeringContext } = await import('../services/engineeringSourceInspector.js');
          if (state.isCurrentSelection(request)) await inspectEngineeringContext(state, contextKey, request);
        } else if (node.sourceId) {
          const request = state.beginSelection({ kind: 'engineering-source', key: node.sourceId }); syncEngineeringTreeSelection(state);
          const { selectEngineeringTarget } = await import('../services/engineeringSelection.js');
          if (state.isCurrentSelection(request)) await selectEngineeringTarget(state, { kind: 'engineering-source', key: node.sourceId }, request);
        } else if (node.documentPath) {
          const occurrence = node.kind === 'cbm' ? node.key.slice('source:cbm:'.length) : undefined;
          const request = state.beginSelection({ kind: 'engineering-source', key: occurrence ?? `document:${node.documentPath}` }); syncEngineeringTreeSelection(state);
          const { inspectEngineeringDocument } = await import('../services/engineeringSourceInspector.js');
          if (state.isCurrentSelection(request)) await inspectEngineeringDocument(state, node.documentPath, occurrence, request);
        }
      }
    } catch (error) { if (generation === state.projectGeneration) { state.selectionMessage = String(error); quality.textContent = '该对象暂未能打开，来源仍保留'; quality.title = String(error); } }
    if (generation === state.projectGeneration) syncEngineeringTreeSelection(state);
  };
  const expanded = state.engineeringExpandedRows[mode];
  const root = mode === 'composition' ? data.composition.rootKey : mode==='inventory'?data.inventory!.rootKey:data.sourceRoot;
  expanded.add(root);
  const outlineNode = (key: string): OutlineNode => {
    const node = mode === 'composition' ? data.composition.nodes.get(key)! : mode==='inventory'?data.inventory!.nodes.get(key)!:data.sourceNodes.get(key)!;
    return { key, ...(node.children.length ? { children: () => node.children.map(outlineNode) } : {}), render: parent => {
      const wrapper = document.createElement('div'); wrapper.className = 'tree-node';
      const row = document.createElement('div'); row.className = 'tree-row'; row.dataset.nodePath = key; row.tabIndex = 0; row.setAttribute('role', 'treeitem');
      const toggle = document.createElement('span'); toggle.className = `tree-toggle${node.children.length ? '' : ' leaf'}`; toggle.textContent = '▶';
      const icon = document.createElement('span'); icon.className = 'tree-icon'; icon.textContent = node.kind === 'entity' ? '◆' : node.kind === 'record' ? '◇' : '□';
      const label = document.createElement('span'); label.className = 'tree-label'; label.textContent = key === root ? state.projectName || node.title : node.title; label.title = label.textContent;
      if (mode === 'composition') {
        const group = data.composition.nodes.get(key)!;
        if (group.declaredContextIds?.length && group.entityCount === 0) { label.textContent += ' · 归属待确认'; label.title = '来源已声明此工程单元，整体归属尚未确认'; }
      }
      row.append(toggle, icon, label); wrapper.append(row); parent.append(wrapper);
      row.addEventListener('click', () => {
        if (mode === 'composition' || mode==='inventory') { void select(key); }
        else if (node.kind === 'group') { if (node.children.length) toggle.click(); }
        else void select(key);
      });
      row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); } });
    } };
  };
  nav.outline = renderVirtualOutline(host, [outlineNode(root)], { expanded, selectedKey: () => rowKey(state, data) });
  renderSearchBox(cbmTreePanel, mode === 'composition' || mode==='inventory' ? data.compositionSearch : data.sourceSearch, key => {
    const row = mode === 'composition' ? data.composition.rowsByEntity.get(key)?.[0] : mode==='inventory'?data.inventory!.rowsByEntity.get(key)?.[0]:key;
    if (row) void select(row);
  });
  const input = cbmTreePanel.querySelector<HTMLInputElement>('.search-box-wrap input');
  if (input && nav.query[mode]) { input.value = nav.query[mode]; input.dispatchEvent(new Event('input')); }
  cbmTreePanel.scrollTop = nav.scroll[mode];
  if (state.selectionRequest?.target) syncEngineeringTreeSelection(state);
}

export function revealEngineeringSource(state: AppState, sourceId: string): void {
  if(state.engineeringNavMode==='inventory'){renderEngineeringTree(state);syncEngineeringTreeSelection(state);return;}
  state.engineeringNavMode = 'source'; renderEngineeringTree(state); syncEngineeringTreeSelection(state);
  const nav = navigations.get(state), key = nav?.data?.sourceRows.get(sourceId);
  if (key) nav?.outline?.__gimRevealOutline?.(key);
}
