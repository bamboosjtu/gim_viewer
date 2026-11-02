import type { AppState, SelectionRequest } from '../app/state.js';
import { engineeringSourceRecord } from './engineeringViewService.js';
import { selectEngineeringTarget } from './engineeringSelection.js';
import { escHtml } from '../shared/html.js';

/** Reads a source document on explicit request; never opens an IFC STEP
 * definition tree or promotes a document to an engineering entity.
 */
export async function inspectEngineeringDocument(state: AppState, path: string, cbmOccurrenceId?: string, existing?: SelectionRequest): Promise<void> {
  const sources = state.engineeringSources, snapshot = state.engineeringSnapshot;
  if (!sources || !snapshot) return;
  const inventory = new Set([...state.substationEntryPaths, ...sources.graph.documents.map(doc => doc.path), ...sources.graph.ifcPaths]);
  if (!inventory.has(path)) return;
  const request = existing ?? state.beginSelection({ kind: 'engineering-source', key: cbmOccurrenceId ?? `document:${path}` }), guard = state.selectionGuard(request);
  if (!guard.isCurrent()) return;
  const tree = await import('../ui/engineeringTreeView.js');
  if (!guard.isCurrent()) return;
  state.engineeringNavMode = 'source'; tree.renderEngineeringTree(state); tree.syncEngineeringTreeSelection(state);
  const { openPropsDrawerUI, renderInspectorTabs, sectionHtml } = await import('../ui/propsDrawer.js');
  if (!guard.isCurrent()) return;
  openPropsDrawerUI();
  let doc = sources.graph.documents.find(doc => doc.path === path);
  const isIfc = /\.ifc$/i.test(path);
  if (!doc && !isIfc && /\.(?:cbm|dev|fam|phm|mod|sch|std)$/i.test(path)) {
    let bytes: Uint8Array;
    try {
      const file = state.currentFiles?.get(path);
      if (file) {
        if (file.size > 16 * 1024 * 1024) throw Error('来源文本超过单次查看上限');
        bytes = new Uint8Array(await file.arrayBuffer());
      } else {
        if (state.currentProjectId == null) throw Error('来源文件不可用');
        if ((state.substationEntrySizes.get(path) ?? 0) > 16 * 1024 * 1024) throw Error('来源文本超过单次查看上限');
        const { readCachedEntry } = await import('@desktop/database.js');
        bytes = await readCachedEntry(state.currentProjectId, path);
      }
      if (!guard.isCurrent()) return;
      if (bytes.length > 16 * 1024 * 1024) throw Error('来源文本超过单次查看上限');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
      const rawLines = text.split(/\r?\n/);
      doc = { path, rawLines, fields: rawLines.flatMap((rawLine, index) => {
        const at = rawLine.indexOf('=');
        return at > 0 ? [{ path, line: index + 1, keys: [rawLine.slice(0, at).trim()], value: rawLine.slice(at + 1).trim(), rawLine }] : [];
      }) };
    } catch (error) {
      if (guard.isCurrent()) renderInspectorTabs(`<div class="props-header">${escHtml(path)}</div>`, { overview: sectionHtml('来源', [['文件', path], ['状态', String(error)]]), params: '', relations: '', source: '' });
      return;
    }
  }
  if (!guard.isCurrent()) return;
  const candidateIds = new Set<string>();
  const occurrenceIds = new Set(cbmOccurrenceId ? [cbmOccurrenceId] : sources.graph.cbmOccurrences.filter(node => node.documentPath === path).map(node => node.id));
  if (occurrenceIds.size) {
    for (const row of sources.graph.records) if (row.devOccurrence && occurrenceIds.has(row.devOccurrence.cbmOccurrenceId) && row.devOccurrence.rootSourceId === row.id) candidateIds.add(row.id);
    sources.graph.aliases.filter(alias => occurrenceIds.has(alias.sourceId)).forEach(alias => alias.candidates.forEach(id => candidateIds.add(id)));
    sources.ifcMatches.filter(match => occurrenceIds.has(match.cbmOccurrenceId)).forEach(match => match.ifcSourceIds.forEach(id => candidateIds.add(id)));
  }
  const references = sources.graph.references.filter(reference => reference.owner === path);
  const ifcModel = sources.models.find(model => model.path === path);
  const rows: [string, string][] = [['文件', path], ['浏览对象', isIfc ? 'IFC 交付文件' : '来源文档'],
    ...(doc ? [['原始行数', String(doc.rawLines.length)]] as [string, string][] : []),
    ...(isIfc ? [['外露对象与特征', String(sources.ifcRecords.filter(row => row.sources.includes(path)).length)], ['读取状态', ifcModel?.error ?? (ifcModel ? '已解析外露接口' : '尚未完成')]] as [string, string][] : [])];
  const render = (page = 0, active = 'overview') => {
    if (!guard.isCurrent()) return;
    const start = page * 200, lines = doc?.rawLines ?? [], last = Math.max(0, Math.ceil(lines.length / 200) - 1);
    renderInspectorTabs(`<div class="props-header">${escHtml(path.split('/').pop()!)}</div>`, {
      overview: sectionHtml('来源文档', rows),
      params: doc ? sectionHtml('原始字段', doc.fields.filter(field => (field.line ?? 0) > start && (field.line ?? 0) <= start + 200).map(field => [field.keys.join(' / '), field.value])) : sectionHtml('来源范围', [['说明', isIfc ? '只展示交付的外露对象与特征，内部类型作为属性和证据按需查看。' : '通过引用关系查看该来源。']]),
      relations: sectionHtml('引用状态', references.map(reference => [reference.field, `${reference.value} · ${reference.status === 'resolved' ? '已找到' : reference.status === 'ambiguous' ? '存在多个候选' : '未找到'}`])) +
        references.map((reference, i) => reference.target ? `<button type="button" class="prop-ref-link" data-engineering-document-ref="${i}">${escHtml(reference.target)}</button>` : '').join(''),
      source: doc ? `<p class="props-note">原始行 ${start + 1}–${Math.min(start + 200, lines.length)} / ${lines.length}</p><pre>${escHtml(lines.slice(start, start + 200).join('\n'))}</pre>` : sectionHtml('来源', [['文件', path]]),
    }, active);
    const controls = `<div class="props-actions"><button type="button" class="prop-ref-link" data-source-page="${Math.max(0, page - 1)}" ${page === 0 ? 'disabled' : ''}>上一页</button><button type="button" class="prop-ref-link" data-source-page="${Math.min(last, page + 1)}" ${page === last ? 'disabled' : ''}>下一页</button></div>`;
    if (doc && lines.length > 200) for (const pane of ['params', 'source']) document.querySelector(`[data-itab-pane="${pane}"]`)?.insertAdjacentHTML('beforeend', controls);
    const candidates = [...candidateIds].slice(0, 100);
    document.querySelector('[data-itab-pane="overview"]')?.insertAdjacentHTML('beforeend', candidates.map((id, i) => `<button class="prop-ref-link" data-source-candidate="${i}">${escHtml(engineeringSourceRecord(state, id)?.name ?? '关联来源')}</button>`).join(''));
    if (candidateIds.size > 100) document.querySelector('[data-itab-pane="overview"]')?.insertAdjacentHTML('beforeend', '<p class="props-note">全部实例可在来源视图逐项查看。</p>');
    document.querySelectorAll<HTMLElement>('[data-source-page]').forEach(button => button.addEventListener('click', () => render(Number(button.dataset.sourcePage), button.closest('[data-itab-pane]')?.getAttribute('data-itab-pane') ?? 'source')));
    document.querySelectorAll<HTMLElement>('[data-source-candidate]').forEach(button => button.addEventListener('click', () => { if (guard.isCurrent()) void selectEngineeringTarget(state, { kind: 'engineering-source', key: candidates[Number(button.dataset.sourceCandidate)] }); }));
    document.querySelectorAll<HTMLElement>('[data-engineering-document-ref]').forEach(button => button.addEventListener('click', () => {
      const reference = references[Number(button.dataset.engineeringDocumentRef)]; if (guard.isCurrent() && reference.target) void inspectEngineeringDocument(state, reference.target);
    }));
  };
  render();
  if (state.initialized) {
    const [{ getViewerRuntimeWithUI }, { commitSelectionHighlight }] = await Promise.all([import('./viewerUIBinding.js'), import('../viewer/highlight.js')]);
    if (guard.isCurrent()) { const { ctx } = await getViewerRuntimeWithUI(state, () => {}); if (guard.isCurrent()) await commitSelectionHighlight(ctx, state, guard); }
  }
}

/** IFC spatial containers are provenance context, never extra engineering
 * entities. Their delivered hierarchy and outward members remain inspectable. */
export async function inspectEngineeringContext(state: AppState, key: string, existing?: SelectionRequest): Promise<void> {
  const sources = state.engineeringSources, node = sources?.spatialNodes.find(node => node.key === key);
  if (!sources || !node) return;
  const request = existing ?? state.beginSelection({ kind: 'engineering-source', key: `context:${key}` }), guard = state.selectionGuard(request);
  if (!guard.isCurrent()) return;
  const [{ renderInspectorTabs, sectionHtml, openPropsDrawerUI }, tree] = await Promise.all([import('../ui/propsDrawer.js'), import('../ui/engineeringTreeView.js')]);
  if (!guard.isCurrent()) return;
  state.engineeringNavMode = 'source'; tree.renderEngineeringTree(state); tree.syncEngineeringTreeSelection(state);
  const children = new Map<string, string[]>();
  for (const context of sources.spatialNodes) if (context.parentKey) { const rows = children.get(context.parentKey) ?? []; rows.push(context.key); children.set(context.parentKey, rows); }
  const subtree = new Set<string>(), queue = [node.key];
  while (queue.length) { const next = queue.pop()!; if (subtree.has(next)) continue; subtree.add(next); for (const child of children.get(next) ?? []) queue.push(child); }
  const members = sources.ifcRecords.filter(row => row.context.some(context => subtree.has(context)));
  const parent = sources.spatialNodes.find(context => context.key === node.parentKey);
  openPropsDrawerUI(); renderInspectorTabs(`<div class="props-header">${escHtml(node.name)}</div>`, {
    overview: sectionHtml('空间来源', [['浏览对象', 'IFC 交付空间容器'], ['类型', node.ifcType], ['外露对象与特征（含下级）', String(members.length)]]),
    params: sectionHtml('原始身份', [['名称', node.name], ['GlobalId', node.globalId], ['ExpressId', String(node.expressId)]]),
    relations: sectionHtml('来源关系', [['上级容器', parent?.name ?? '文件根级'], ['下级容器', String(children.get(node.key)?.length ?? 0)]]),
    source: sectionHtml('文件', [['路径', node.sourcePath]]) + '<button class="prop-ref-link" id="engineering-context-document">查看交付文件</button>' +
      members.slice(0, 100).map((member, index) => `<button class="prop-ref-link" data-context-member="${index}">${escHtml(member.name)}</button>`).join('') + (members.length > 100 ? '<p class="props-note">全部对象可在来源树展开或搜索。</p>' : ''),
  });
  document.getElementById('engineering-context-document')?.addEventListener('click', () => { if (guard.isCurrent()) void inspectEngineeringDocument(state, node.sourcePath); });
  document.querySelectorAll<HTMLElement>('[data-context-member]').forEach(button => button.addEventListener('click', () => {
    if (guard.isCurrent()) void selectEngineeringTarget(state, { kind: 'engineering-source', key: members[Number(button.dataset.contextMember)].id });
  }));
  if (state.initialized) {
    const [{ getViewerRuntimeWithUI }, { commitSelectionHighlight }] = await Promise.all([import('./viewerUIBinding.js'), import('../viewer/highlight.js')]);
    if (guard.isCurrent()) { const { ctx } = await getViewerRuntimeWithUI(state, () => {}); if (guard.isCurrent()) await commitSelectionHighlight(ctx, state, guard); }
  }
}
