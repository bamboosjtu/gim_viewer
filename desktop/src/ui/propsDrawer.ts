import { resolveBaseFamilyReferences } from '../gim/gimValueSemantics.js';
import { parseFamSectionsWithDiagnostics, resolveSubstationBusinessIdentity, type FamSourceProperty } from '../gim/famParser.js';
import { discoverSubstationGlSidecars, substationDevIdentity, buildSubstationAliasIndex, buildSubstationIfcEvidence, findSubstationSourceDocuments, deviceOccurrenceScope } from '../gim/substationEvidence.js';
import type { CbmNode } from '../gim/types.js';
import type { AppState, SelectionRequest } from '../app/state.js';
import { beginSelectionStage } from '../services/selectionTiming.js';
import { setSelectionStatus } from './shell/statusBar.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { IfcSpatialNode, IfcSpatialObject, SubstationSpatialIndex } from '../gim/ifcSpatialParser.js';
import type { RegionalObject } from '../viewer/ifcRegionalData.js';
import { isRegionalConnectionObject } from '../viewer/ifcRegionalData.js';
import { ifcConnectionOwnershipIndex, type IfcConnectionOwnership } from '../gim/ifcConnectionOwnership.js';
import type { ConnectionEndpointEvidence } from '../gim/connectionEndpoints.js';
import { escHtml } from '../shared/html.js';
import {
  getFileByPath,
  getFirstNonEmptyKv,
  isGimEmptyValue,
  parseKeyValue,
} from '../shared/gimParsing.js';
import { getNodeDisplayName } from '../shared/displayName.js';
import {
  getGeometryDiagnostic,
  geometryReasonLabel,
  geometryStatusLabel,
} from '../gim/geometry/geometryDiagnostics.js';
import {
  findIfcEntryByModelId,
  normalizeEntryPath,
  normalizedIfcBasename,
  resolveIfcModelId,
} from '../gim/modelIdentity.js';
import { propsDrawerBody, propsDrawer, btnCloseProps, btnExportProps } from './dom.js';
import { buildCsv, downloadTextFile } from '../shared/csv.js';
import { shouldAutoShowProps } from './shell/viewerShell.js';
import {
  ensurePropertyReferenceEvents,
  fileReferenceValue,
  fileReferencesValue,
  getPropertyDefinition,
  getPropertyLabel,
  renderPropertySection,
  renderTechnicalSection,
  type FileReferenceValue,
  type PropertyComponent,
  type PropertyRow,
} from './propertyDictionary.js';

/** 刷新视口布局（面板展开/收起后调用） */
function refreshViewportLayout(ctx: ViewerContext) {
  requestAnimationFrame(() => {
    ctx.fragments.core.update(true);
  });
}

/** 打开属性面板（需要 Viewer 刷新视口） */
export function openPropsDrawer(ctx: ViewerContext, force = false): void {
  if (!force && !shouldAutoShowProps()) return;
  propsDrawer.classList.remove('collapsed');
  refreshViewportLayout(ctx);
}

/** 打开属性面板（纯 UI，不刷新视口，用于无 Viewer 场景） */
export function openPropsDrawerUI(force = false): void {
  if (!force && !shouldAutoShowProps()) return;
  propsDrawer.classList.remove('collapsed');
}

/** 关闭属性面板（纯 UI，不刷新视口，用于无 Viewer 场景） */
export function closePropsDrawerUI(): void {
  propsDrawer.classList.add('collapsed');
}

/** 关闭属性面板 */
export function closePropsDrawer(ctx: ViewerContext): void {
  propsDrawer.classList.add('collapsed');
  refreshViewportLayout(ctx);
}

let propsDrawerInteractionsReady = false;
let propsDrawerViewerContext: ViewerContext | null = null;

/**
 * 绑定属性面板的纯 DOM 交互。
 *
 * 线路工程默认不创建 ViewerRuntime，但仍复用同一个属性检查器。此前
 * 这些事件只在 setupPropsDrawer(ViewerContext) 中注册，导致线路模式的
 * 页签和来源按钮虽然渲染出来，却没有任何 click 委托。这里把 DOM 交互
 * 提升为一次性、幂等的初始化；Viewer 出现后再注入上下文即可恢复视口
 * 刷新能力。
 */
export function setupPropsDrawerInteractions(ctx?: ViewerContext): void {
  if (ctx) propsDrawerViewerContext = ctx;
  if (propsDrawerInteractionsReady) return;
  propsDrawerInteractionsReady = true;
  ensurePropertyReferenceEvents();
  btnCloseProps.addEventListener('click', () => {
    if (propsDrawerViewerContext) closePropsDrawer(propsDrawerViewerContext);
    else closePropsDrawerUI();
  });
  // 导出当前属性面板为 CSV：
  // 直接从已渲染 DOM 抓取分节标题 + 键值行，导出内容与用户所见一致
  btnExportProps.addEventListener('click', () => {
    const rows: string[][] = [['分类', '属性', '值']];
    const sections = propsDrawerBody.querySelectorAll('.props-section, .props-advanced');
    if (sections.length === 0) return;
    for (const sec of sections) {
      const title = sec.querySelector('.props-section-title, summary')?.textContent?.trim() ?? '';
      for (const tr of sec.querySelectorAll('.props-table tr')) {
        const tds = tr.querySelectorAll('td');
        if (tds.length >= 2) {
          rows.push([title, tds[0].textContent?.trim() ?? '', tds[1].textContent?.trim() ?? '']);
        }
      }
    }
    if (rows.length <= 1) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadTextFile(`gim-props-${ts}.csv`, buildCsv(rows));
  });

  // 共性 UI 契约：检查器四页签（概览/参数/关系/来源）点击委托。
  // CSV 导出遍历全部 pane（含隐藏），导出内容不受当前页签影响。
  propsDrawerBody.addEventListener('click', (ev) => {
    const element = ev.target instanceof Element ? ev.target : null;
    const copy = element?.closest<HTMLButtonElement>('[data-copy-geometry-diagnostic]');
    if (copy) {
      const container=copy.closest('[data-geometry-details]');
      const text=container?.querySelector('pre')?.textContent ?? '';
      const status=container?.querySelector('[data-copy-result]');
      const owner=propsDrawerBody.dataset.cbmSelection;
      const report=(message:string)=>{
        if(copy.isConnected&&status)status.textContent=message;
        else if(owner&&propsDrawerBody.dataset.cbmSelection===owner){const current=propsDrawerBody.querySelector('[data-copy-result]');if(current)current.textContent=message;}
      };
      if(!navigator.clipboard?.writeText){report('无法自动复制，请选中技术详情复制。');return;}
      void navigator.clipboard.writeText(text).then(()=>report('已复制诊断信息')).catch(()=>report('复制未成功，请选中技术详情复制。'));
      return;
    }
    const ref = element?.closest<HTMLElement>('[data-prop-ref]');
    if (ref) {
      ev.preventDefault();
      const kind = ref.getAttribute('data-reference-kind');
      const path = ref.getAttribute('data-reference-path');
      if (kind && path) {
        window.dispatchEvent(new CustomEvent('gim:file-reference-click', {
          detail: { kind, path },
        }));
      }
      return;
    }
    const target = element?.closest<HTMLElement>('[data-itab]');
    if (!target) return;
    const id = target.getAttribute('data-itab')!;
    propsDrawerBody.querySelectorAll('[data-itab]').forEach((t) =>
      t.classList.toggle('active', t === target),
    );
    propsDrawerBody.querySelectorAll('[data-itab-pane]').forEach((pane) =>
      pane.classList.toggle('active', pane.getAttribute('data-itab-pane') === id),
    );
  });
}

/** 绑定属性面板按钮事件（Viewer 变电场景）。 */
export function setupPropsDrawer(ctx: ViewerContext): void {
  setupPropsDrawerInteractions(ctx);
}

/** 检查器四页签内容桶 */
export interface InspectorBuckets {
  overview: string;
  params: string;
  relations: string;
  source: string;
}

/**
 * 渲染四页签结构到检查器 body（共性 ObjectInspector 契约）。
 *
 * @param titleHtml 对象标题（.props-header）
 * @param buckets 四个页签的内容 HTML（各页签内部使用 .props-section 结构）
 */
export function renderInspectorTabs(titleHtml: string, buckets: InspectorBuckets, activeTab = 'overview'): void {
  delete propsDrawerBody.dataset.cbmSelection;
  const selectedTab = (['overview', 'params', 'relations', 'source'] as const).includes(activeTab as 'overview' | 'params' | 'relations' | 'source')
    ? activeTab
    : 'overview';
  const pane = (id: string, content: string, active: boolean): string => {
    const empty = content.trim()
      ? content
      : '<div class="props-empty">暂无内容</div>';
    return `<div data-itab-pane="${id}" class="itab-pane${active ? ' active' : ''}">${empty}</div>`;
  };
  const tab = (id: string, label: string, active: boolean): string =>
    `<button type="button" data-itab="${id}" class="itab${active ? ' active' : ''}">${label}</button>`;

  propsDrawerBody.innerHTML = `
    ${titleHtml}
    <div class="itabs">
       ${tab('overview', '概览', selectedTab === 'overview')}
       ${tab('params', '参数', selectedTab === 'params')}
       ${tab('relations', '关系', selectedTab === 'relations')}
       ${tab('source', '来源', selectedTab === 'source')}
    </div>
    ${pane('overview', buckets.overview, selectedTab === 'overview')}
    ${pane('params', buckets.params, selectedTab === 'params')}
    ${pane('relations', buckets.relations, selectedTab === 'relations')}
    ${pane('source', buckets.source, selectedTab === 'source')}
  `;

  // “参数”页签提供字段搜索：按行文本过滤，不重新解析源文件。
  const paramsPane = propsDrawerBody.querySelector<HTMLElement>('[data-itab-pane="params"]');
  const hasParams = Boolean(paramsPane && paramsPane.querySelector('tr'));
  if (paramsPane && hasParams) {
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'props-search';
    search.placeholder = '搜索字段或值…';
    search.setAttribute('aria-label', '搜索参数');
    paramsPane.prepend(search);
    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      const sections = Array.from(paramsPane.querySelectorAll<HTMLElement>('.props-section, details.props-advanced'));
      for (const section of sections) {
        let visible = false;
        for (const row of Array.from(section.querySelectorAll<HTMLElement>('tr'))) {
          const match = !query || (row.textContent ?? '').toLowerCase().includes(query);
          row.hidden = !match;
          if (match) visible = true;
        }
        section.hidden = Boolean(query) && !visible;
      }
    });
  }
}

/** Product near representation uses the original IFC identity and source properties. */
export async function showIfcRegionalProperties(ctx:ViewerContext,state:AppState,
  runtime:import('../viewer/ifcRegionalRuntime.js').IfcRegionalRuntime,
  object:import('../viewer/ifcRegionalData.js').RegionalObject,request:SelectionRequest):Promise<void>{
  const refinement = ifcRefinementHtml(runtime, object);
  const render=(properties:any,error='')=>{
    if(!state.isCurrentSelection(request))return;openPropsDrawer(ctx);setSelectionStatus(`${object.name||object.ifcType} · IFC 近景`);
    const rows=properties?Object.entries(properties.attributes).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)] as [string,string]):[];
    renderInspectorTabs(`<div class="props-header">${escHtml(object.name||object.ifcType)} · 近景</div>`,{
      overview:sectionHtml('原 IFC 对象',[['GlobalId',object.globalId],['ExpressId',String(object.expressId)],['IFC 类型',object.ifcType],['表示','近景区域；≤50mm 已识别关系孔省略，中型及未知开洞保留']]) + refinement,
      params:properties?sectionHtml('IFC 原始属性',rows)+[...properties.propertySets,...(properties.typeProperties??[]),...(properties.materials??[])].map((set:unknown)=>sectionHtml('属性集 / 类型 / 材料',[['原始值',JSON.stringify(set)]],true)).join(''):`<div class="props-note">${escHtml(error||'正在读取属性…')}</div>`,
      relations:'<div class="props-note">沿用原始 IFC 对象身份。</div>',source:sectionHtml('来源',[['IFC 文件',runtime.sourcePath],['几何','仅相机附近30m区域计算']]),
    });
    bindIfcRefinementControls(state, runtime, object, request);
  };render(null);try{render(await runtime.properties(object.expressId));}catch(error){render(null,String(error));}
}

/** 渲染 FAM 分节属性为 HTML */
function renderFamSections(sections: Map<string, Map<string, string>>, component: PropertyComponent = 'substation-fam'): string {
  let html = '';
  for (const [secName, props] of sections) {
    if (props.size === 0) continue;
    const rows: PropertyRow[] = Array.from(props)
      .filter(([, value]) => isUsefulPropertyValue(value))
      .map(([key, value]) => ({ key, value }));
    const primary = rows.filter((row) => (getPropertyDefinition(component, row.key)?.priority ?? 2) < 2);
    const technical = rows.filter((row) => (getPropertyDefinition(component, row.key)?.priority ?? 2) >= 2);
    html += renderPropertySection(secName, component, primary);
    if (technical.length > 0) html += renderTechnicalSection(`${secName} · 技术字段`, component, technical);
  }
  return html;
}

function countChildGeometryEntries(node: CbmNode): number {
  let count = 0;
  const visit = (current: CbmNode): void => {
    for (const child of current.children) {
      if (child.devPath) count++;
      visit(child);
    }
  };
  visit(node);
  return count;
}

/**
 * 将已有 geometry pipeline 结果显示在设备检查器中。
 *
 * 这里不重新扫描 DEV/PHM/MOD；首次打开和 warm manifest 都由 runtime
 * 写入同一 session-local index，避免属性点击反过来制造一条慢解析路径。
 */
function renderNodeGeometryDiagnostics(state: AppState, node: CbmNode): string {
  const childDevCount = countChildGeometryEntries(node);
  if (!node.devPath && childDevCount === 0 && state.selectionRequest?.target?.key !== node.path) return '';

  const diagnostic = getGeometryDiagnostic(state, node.devPath);
  const rows: PropertyRow[] = [];
  if (state.selectionRequest?.target?.kind === 'cbm' && state.selectionRequest.target.key === node.path && state.selectionGeometry) {
    rows.push({ key: '当前选择几何', value: state.selectionGeometry.detail });
  }
  if (diagnostic) {
    rows.push({ key: '几何状态', value: diagnostic.reason==='source-invalid' ? '源几何异常' : geometryStatusLabel(diagnostic.status) });
    rows.push({ key: '诊断来源', value: diagnostic.source === 'cold' ? '首次打开/编译' : diagnostic.source === 'warm' ? '缓存 manifest' : '按需回退' });
    if (diagnostic.reason) rows.push({ key: '原因', value: diagnostic.reason==='source-invalid' ? '模型坐标超出合理范围' : geometryReasonLabel(diagnostic.reason) });
    if (diagnostic.discoveredModCount != null) rows.push({ key: '发现 MOD/GL', value: String(diagnostic.discoveredModCount) });
    if (diagnostic.discoveredStlCount != null) rows.push({ key: '发现 STL', value: String(diagnostic.discoveredStlCount) });
    if (diagnostic.renderableModCount != null) rows.push({ key: '可渲染 MOD/GL', value: String(diagnostic.renderableModCount) });
    if (diagnostic.renderableStlCount != null) rows.push({ key: '可渲染 STL', value: String(diagnostic.renderableStlCount) });
    if (diagnostic.emptySourceCount != null && diagnostic.emptySourceCount > 0) {
      rows.push({ key: '空几何源', value: String(diagnostic.emptySourceCount) });
    }
    if (diagnostic.unsupportedSourceCount != null && diagnostic.unsupportedSourceCount > 0) {
      rows.push({ key: '未支持几何源', value: String(diagnostic.unsupportedSourceCount) });
    }
    const unsupportedTypes = Object.entries(diagnostic.unsupportedPrimitiveTypeCounts)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => `${type} × ${count}`)
      .join('、');
    if (unsupportedTypes) rows.push({ key: '未支持 primitive', value: unsupportedTypes });
    if (diagnostic.detail && diagnostic.reason!=='source-invalid') rows.push({ key: '说明', value: diagnostic.detail });
  } else {
    const selection=state.selectionRequest?.target?.key===node.path ? state.selectionGeometry : null;
    const labels:Record<NonNullable<AppState['selectionGeometry']>['status'],string>={
      'not-loaded':'尚未加载',unknown:'完整性或可达性尚未确认',available:'有可显示几何，完整性未确认',
      renderable:'可渲染',empty:'确定性空几何',unsupported:'当前解析器不支持',partial:'部分可渲染',failed:'加载失败',
      unlinked:'未关联真实装配',ambiguous:'多候选，完整性未确认','file-only':'仅 IFC 文件来源，无对象 GUID 关联',unassociated:'无直接几何关联',
    };
    rows.push({ key: '几何状态', value: selection ? labels[selection.status] : '尚未完成几何发现或当前 DEV 尚未加载' });
  }
  if (childDevCount > 0) {
    rows.push({ key: '子设备 DEV 入口', value: String(childDevCount) });
  }
  const technical=diagnostic?.reason==='source-invalid' && diagnostic.detail
    ? `<div data-geometry-details class="props-section"><details><summary>查看技术详情</summary><pre style="max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere">${escHtml(`${diagnostic.devPath}\n${diagnostic.reason}\n${diagnostic.detail}`)}</pre></details><button type="button" class="prop-ref-link" data-copy-geometry-diagnostic>复制诊断信息</button><span role="status" data-copy-result></span></div>` : '';
  const retry = diagnostic?.status === 'failed' && diagnostic.reason !== 'source-invalid' && node.devPath && state.deviceLodRuntime?.retry
    ? `<div class="props-actions" data-geometry-retry-box><button type="button" class="prop-ref-link" data-geometry-retry>局部重试</button><span role="status" data-geometry-retry-result>只重试该设备的浏览表示</span></div>`
    : '';
  return renderPropertySection('几何状态', 'substation-dev', rows)+technical+retry;
}

/**
 * L2 is a deliberate browser action.  The normal tree/search/click path only
 * asks the DEV runtime for an L0/L1 representation; this control is the sole
 * UI entry point that requests the precise DEV model.  Keep the action in the
 * inspector so users can distinguish “浏览表示” from “查看精细模型”.
 */
function devRefinementHtml(state: AppState, node: CbmNode): string {
  if (!node.devPath) return '';
  const runtime = state.deviceLodRuntime;
  if (!runtime?.refine || !runtime.releaseFine) {
    return '<div class="props-note">精细模型入口将在设备浏览表示就绪后提供。</div>';
  }
  const root = deviceOccurrenceScope(state.currentCbmTree, node).rootOccurrence;
  return `<div class="props-section dev-refinement" data-dev-refinement-root="${escHtml(root)}">
    <div class="props-section-title">设备表示</div>
    <div class="props-note">当前浏览使用低成本轮廓；精细模型只在明确请求后生成。</div>
    <div class="props-actions">
      <button type="button" class="prop-ref-link" data-dev-refine>查看精细模型</button>
      <button type="button" class="prop-ref-link" data-dev-release-fine>返回浏览表示</button>
      <span role="status" data-dev-refine-result></span>
    </div>
  </div>`;
}

function bindDevRefinementControls(state: AppState, node: CbmNode, request: SelectionRequest): void {
  const root = deviceOccurrenceScope(state.currentCbmTree, node).rootOccurrence;
  const refine = propsDrawerBody.querySelector<HTMLButtonElement>('[data-dev-refine]');
  const release = propsDrawerBody.querySelector<HTMLButtonElement>('[data-dev-release-fine]');
  const result = propsDrawerBody.querySelector<HTMLElement>('[data-dev-refine-result]');
  let action = 0;
  if (refine) refine.onclick = async () => {
    if (!state.isCurrentSelection(request) || !state.deviceLodRuntime?.refine) return;
    const ownAction = ++action;
    refine.disabled = true;
    if (release) { release.disabled = false; release.textContent = '取消精化'; }
    if (result) result.textContent = '正在生成…';
    try {
      await state.deviceLodRuntime.refine(root);
      if (!state.isCurrentSelection(request) || ownAction !== action) return;
      state.selectionGeometry = { status: 'renderable', detail: '已显示精细模型；返回浏览表示可释放 L2。' };
      if (result) result.textContent = '精细模型已显示';
      setSelectionStatus(`${getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries)} · 精细模型`);
    } catch (error) {
      if (state.isCurrentSelection(request) && ownAction === action && result) result.textContent = `生成失败：${String(error)}`;
    } finally {
      if (ownAction === action) {
        refine.disabled = false;
        if (release) { release.disabled = false; release.textContent = '返回浏览表示'; }
      }
    }
  };
  if (release) release.onclick = () => {
    if (!state.isCurrentSelection(request) || !state.deviceLodRuntime?.releaseFine) return;
    action++;
    if (refine) refine.disabled = false;
    release.textContent = '返回浏览表示';
    state.deviceLodRuntime.releaseFine(root);
    if (state.isCurrentSelection(request)) {
      state.selectionGeometry = { status: 'available', detail: '已返回浏览表示。' };
      if (result) result.textContent = '已返回浏览表示';
      setSelectionStatus(getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries));
    }
  };
}

function bindDevGeometryRetryControls(state: AppState, node: CbmNode, request: SelectionRequest): void {
  const retry = propsDrawerBody.querySelector<HTMLButtonElement>('[data-geometry-retry]');
  const result = propsDrawerBody.querySelector<HTMLElement>('[data-geometry-retry-result]');
  if (!retry || !node.devPath || !state.deviceLodRuntime?.retry) return;
  const root = deviceOccurrenceScope(state.currentCbmTree, node).rootOccurrence;
  retry.onclick = async () => {
    if (!state.isCurrentSelection(request) || !state.deviceLodRuntime?.retry) return;
    retry.disabled = true;
    if (result) result.textContent = '正在重试…';
    try {
      await state.deviceLodRuntime.retry(root);
      if (!state.isCurrentSelection(request)) return;
      state.selectionGeometry = { status: 'available', detail: '局部重试已提交，保留当前浏览表示。' };
      if (result) result.textContent = '重试已提交';
    } catch (error) {
      if (result) result.textContent = `重试失败：${String(error)}`;
    } finally {
      retry.disabled = false;
    }
  };
}

type IfcRefinementRuntime = {
  refine(object: RegionalObject): Promise<unknown>;
  releaseFine(expressId: number): void;
};

function ifcRefinementHtml(runtime: IfcRefinementRuntime | undefined, object: RegionalObject): string {
  if (!runtime) return '';
  return `<div class="props-section ifc-refinement">
    <div class="props-section-title">IFC 表示</div>
    <div class="props-note">当前为远景/近景浏览表示；精细模型只在明确请求后读取。</div>
    <div class="props-actions">
      <button type="button" class="prop-ref-link" data-ifc-refine data-ifc-express-id="${object.expressId}">查看精细模型</button>
      <button type="button" class="prop-ref-link" data-ifc-release-fine data-ifc-express-id="${object.expressId}">返回浏览表示</button>
      <span role="status" data-ifc-refine-result></span>
    </div>
  </div>`;
}

function bindIfcRefinementControls(state: AppState, runtime: IfcRefinementRuntime | undefined, object: RegionalObject, request: SelectionRequest): void {
  if (!runtime) return;
  const refine = propsDrawerBody.querySelector<HTMLButtonElement>('[data-ifc-refine]');
  const release = propsDrawerBody.querySelector<HTMLButtonElement>('[data-ifc-release-fine]');
  const result = propsDrawerBody.querySelector<HTMLElement>('[data-ifc-refine-result]');
  let action = 0;
  if (refine) refine.onclick = async () => {
    if (!state.isCurrentSelection(request)) return;
    const ownAction = ++action;
    refine.disabled = true;
    if (release) { release.disabled = false; release.textContent = '取消精化'; }
    if (result) result.textContent = '正在生成…';
    try {
      await runtime.refine(object);
      if (!state.isCurrentSelection(request) || ownAction !== action) return;
      state.selectionGeometry = { status: 'renderable', detail: '已显示 IFC 精细模型；返回浏览表示可释放 L2。' };
      if (result) result.textContent = '精细模型已显示';
      setSelectionStatus(`${object.name || object.ifcType} · IFC 精细模型`);
    } catch (error) {
      if (state.isCurrentSelection(request) && ownAction === action && result) result.textContent = `生成失败：${String(error)}`;
    } finally {
      if (ownAction === action) {
        refine.disabled = false;
        if (release) { release.disabled = false; release.textContent = '返回浏览表示'; }
      }
    }
  };
  if (release) release.onclick = () => {
    if (!state.isCurrentSelection(request)) return;
    action++;
    if (refine) refine.disabled = false;
    release.textContent = '返回浏览表示';
    runtime.releaseFine(object.expressId);
    state.selectionGeometry = { status: 'available', detail: '已返回 IFC 浏览表示。' };
    if (result) result.textContent = '已返回浏览表示';
    setSelectionStatus(`${object.name || object.ifcType} · IFC 近景`);
  };
}

function nodeIfcRefinement(state: AppState, node: CbmNode): { runtime: IfcRefinementRuntime; object: RegionalObject } | undefined {
  if (!node.ifcGuid) return undefined;
  const modelId = node.ifcFile ? resolveIfcModelId(node.ifcFile, state.currentIfcEntries) : findDeviceIfcModel(state, node.path);
  if (!modelId) return undefined;
  const runtime = state.ifcRegionalRuntimes.get(modelId) as IfcRefinementRuntime | undefined;
  if (!runtime) return undefined;
  const matches = (state.ifcRegionalRuntimes.get(modelId) as import('../viewer/ifcRegionalRuntime.js').IfcRegionalRuntime).index.objects
    .filter((object) => object.globalId === node.ifcGuid);
  return matches.length === 1 ? { runtime, object: matches[0] } : undefined;
}

/**
 * 渲染节点的 FAM/DEV 属性为 HTML。
 * 优先从 currentFiles 读取（首次打开），回退到 cachedFamProperties/cachedDevProperties（缓存命中）。
 */
async function renderNodeFamDevProperties(state: AppState, node: CbmNode): Promise<string> {
  let html = renderNodeGeometryDiagnostics(state, node);

  const properties: FamSourceProperty[] = [];
  const rendered = new Set<string>();
  const renderFamily = async (path: string): Promise<void> => {
    if (rendered.has(path.toLowerCase())) return;
    rendered.add(path.toLowerCase());
    let records: FamSourceProperty[] = [];
    if (state.currentFiles) {
      const file = getFileByPath(state.currentFiles, path);
      if (file) {
        const parsed = parseFamSectionsWithDiagnostics(await file.text(), path);
        records = parsed.properties;
        html += renderFamSections(parsed.sections, 'substation-fam');
      }
    } else {
      records = getCachedByPath(state.cachedFamSourceProperties, path) ?? [];
      const sections = getCachedByPath(state.cachedFamProperties, path);
      if (sections) html += renderFamSections(sections, 'substation-fam');
    }
    properties.push(...records);
    html += sectionHtml('属性来源', [['FAM 文件', fileReferenceValue('fam', path)]]);
    if (records.length > 0) {
      const duplicates = new Map<string, FamSourceProperty[]>();
      for (const record of records) {
        const key = `${record.section}\0${record.label}`;
        duplicates.set(key, [...(duplicates.get(key) ?? []), record]);
      }
      const repeated = [...duplicates.values()].filter((rows) => rows.length > 1);
      const conflicts = repeated.filter((rows) => new Set(rows.map((r) => r.rawValue)).size > 1);
      if (repeated.length) html += sectionHtml('重复属性诊断', [['重复键', String(repeated.length)], ['冲突键', String(conflicts.length)], ['单值查询策略', '按来源行顺序，最后一行生效；原始记录全部保留']]);
      html += `<details class="props-section"><summary>原始属性键与值</summary><table><thead><tr><th>来源行</th><th>分节</th><th>标签</th><th>原始键</th><th>原始值</th></tr></thead><tbody>${records.map((p) =>
        `<tr title="${escHtml(p.rawLine)}"><td>${p.sourceLine ?? ''}</td><td>${escHtml(p.section)}</td><td>${escHtml(p.label)}</td><td>${escHtml(p.rawKey)}</td><td>${escHtml(p.rawValue)}</td></tr>`).join('')}</tbody></table></details>`;
    }
  };
  const cbmRefs = node.rawProperties ? resolveBaseFamilyReferences(node.rawProperties) : [];
  if (node.famPath && !cbmRefs.some((r) => r.path === node.famPath)) cbmRefs.unshift({ key: 'BASEFAMILY', path: node.famPath });
  for (const ref of cbmRefs) await renderFamily(withEntryPrefix('CBM', ref.path));

  // DEV 属性（DEV/{devPath}）
  if (node.devPath) {
    const devKey = withEntryPrefix('DEV', node.devPath);
    let kv: Record<string, string> | null = null;
    if (state.currentFiles) {
      const f = getFileByPath(state.currentFiles, devKey);
      if (f) kv = parseKeyValue(await f.text());
    } else {
      kv = getCachedByPath(state.cachedDevProperties, devKey) ?? null;
    }
    if (kv) {
      const deviceRows: PropertyRow[] = [
        ...(isUsefulPropertyValue(getFirstNonEmptyKv(kv, ['SYMBOLNAME'])) ? [{ key: 'SYMBOLNAME', value: getFirstNonEmptyKv(kv, ['SYMBOLNAME']) }] : []),
        ...(isUsefulPropertyValue(getFirstNonEmptyKv(kv, ['TYPE', 'DEVICETYPE'])) ? [{ key: 'TYPE', value: getFirstNonEmptyKv(kv, ['TYPE', 'DEVICETYPE']) }] : []),
      ];
      html += renderPropertySection('设备信息', 'substation-dev', deviceRows);
      const otherDevRows = Object.entries(kv)
        .filter(([key, value]) => isUsefulPropertyValue(value) && !['SYMBOLNAME', 'TYPE', 'DEVICETYPE'].includes(key.toUpperCase()))
        .map(([key, value]) => ({ key, value }));
      if (otherDevRows.length > 0) {
        const primaryDevRows = otherDevRows.filter((row) => (getPropertyDefinition('substation-dev', row.key)?.priority ?? 2) < 2);
        const technicalDevRows = otherDevRows.filter((row) => (getPropertyDefinition('substation-dev', row.key)?.priority ?? 2) >= 2);
        html += renderPropertySection('DEV 参数', 'substation-dev', primaryDevRows);
        html += renderTechnicalSection('DEV 技术字段', 'substation-dev', technicalDevRows);
      }
      for (const ref of resolveBaseFamilyReferences(kv)) await renderFamily(withEntryPrefix('DEV', ref.path));
    }
  }

  const identity = resolveSubstationBusinessIdentity(properties);
  if (identity) html += sectionHtml('业务身份候选', [
    ['身份值', identity.value], ['身份类型', identity.kind],
    ['来源', fileReferenceValue('fam', identity.source.path)], ['原始键', identity.source.key],
  ]);
  return html;
}

/** 渲染 getItemsData 返回的属性数据为 HTML */
function renderIfcItemData(data: Record<string, unknown>, depth = 0): string {
  if (!data || typeof data !== 'object') return '';
  const scalarRows: PropertyRow[] = [];
  const nested: Array<[string, Record<string, unknown>]> = [];

  for (const [key, value] of Object.entries(data)) {
    if (isGimEmptyValue(value) || key.startsWith('_')) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      nested.push([key, value as Record<string, unknown>]);
      continue;
    }
    if (Array.isArray(value)) {
      for (const elem of value) {
        if (elem && typeof elem === 'object' && !Array.isArray(elem)) {
          nested.push([key, elem as Record<string, unknown>]);
        }
      }
      continue;
    }
    const displayVal = String(value);
    // web-ifc returns several sentinel ExpressIds as zero.  They are not
    // useful to a reviewer and only make the inspector look like raw dumps.
    if (displayVal === '0' && key.toLowerCase().includes('id')) continue;
    scalarRows.push({ key, value: displayVal });
  }

  let html = '';
  if (scalarRows.length > 0) {
    const primary = scalarRows.filter((row) => (getPropertyDefinition('ifc-object', row.key)?.priority ?? 2) < 2);
    const technical = scalarRows.filter((row) => (getPropertyDefinition('ifc-object', row.key)?.priority ?? 2) >= 2);
    html += renderPropertySection(depth === 0 ? 'IFC 属性' : '属性', 'ifc-object', primary);
    if (technical.length > 0) html += renderTechnicalSection('IFC 技术字段', 'ifc-object', technical);
  }
  for (const [key, value] of nested) {
    const child = renderIfcItemData(value, depth + 1);
    if (child) html += `<div class="props-section"><div class="props-section-title">${escHtml(getPropertyLabel('ifc-object', key))}</div>${child}</div>`;
  }
  return html;
}

/** 键值对 → 分节属性表 HTML。值可使用 fileReferenceValue 生成可读链接。 */
export function sectionHtml(
  title: string,
  pairs: Array<[string, string | FileReferenceValue]>,
  monoValue = false,
  component: PropertyComponent = 'generic',
): string {
  const rows: PropertyRow[] = pairs
    .filter(([, value]) => typeof value === 'string'
      ? !isGimEmptyValue(value)
      : !isGimEmptyValue(value?.text))
    .map(([key, value]) => {
      if (typeof value === 'string') return { key, value, mono: monoValue };
      return { key, value: value.text, valueHtml: value.html, valueText: value.text, mono: monoValue };
    });
  return renderPropertySection(title, component, rows);
}

function appendAuxiliarySources(rows: Array<[string, string | FileReferenceValue]>, state: AppState, node: CbmNode): void {
  const sourceDocuments = findSubstationSourceDocuments(node, state.currentCbmTree, state.fileDevRelations);
  if (sourceDocuments.length) rows.push(['原始设计文档', sourceDocuments.join('、')]);
  for (const link of buildSubstationIfcEvidence(state.currentCbmTree, state.currentIfcEntries).filter((l) => l.cbmPath === node.path)) {
    rows.push(['IFC 关联证据', `${link.evidence} · ${link.confidence} · ${link.rawReference}`]);
  }
  const identity = substationDevIdentity(node.devPath);
  const sidecars = discoverSubstationGlSidecars(state.currentFiles?.keys() ?? state.substationEntryPaths, state.currentCbmTree)
    .filter((sidecar) => sidecar.devIdentity === identity);
  for (const sidecar of sidecars) rows.push(['辅助连接来源', fileReferenceValue('gl', sidecar.path)]);
  if (sidecars.length) rows.push(['关联证据', '同 UUID 辅助来源；未推断连接点空间位置']);
  const child = buildSubstationAliasIndex(state.currentCbmTree).partToChildDev.get(node.path);
  if (child) rows.push(['部件语义别名', fileReferenceValue('dev', `DEV/${child}`)]);
}

/** CbmNode → 概览 + 来源 内容（基础字段，不含 IFC 原生属性） */
/**
 * 属性面板设计（research/property-panel-design.md）第一层：关键参数。
 *
 * 业务字段散落在 CBM / FAM / DEV 三类来源中，且大量值带 `-`、`/`、
 * `&其他` 等占位符或重复键前缀。这里统一归一化、按业务优先级取第一个
 * 有效值，最多展示 8 行；原始键值仍在“参数/来源”页签完整保留。
 */
interface InspectorSummary {
  name: string;
  identity: string;
  keyRows: Array<{ label: string; value: string }>;
  idRows: Array<{ label: string; value: string }>;
  systemPath: string;
  componentCount: number;
}

const PLACEHOLDER_VALUES = new Set(['-', '/', '\\', '—', '&其他', '未填写', 'null', 'undefined']);

/** 去掉占位符与值内重复键名（如 `工程中名称=开关柜`）。 */
function normalizeBusinessValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text = String(value).trim();
  if (!text) return null;
  const separator = text.indexOf('=');
  if (separator > 0 && separator <= 24) {
    const prefix = text.slice(0, separator).trim();
    if (prefix && !/\s/.test(prefix) && !/[=,]/.test(prefix)) text = text.slice(separator + 1).trim();
  }
  if (!text || PLACEHOLDER_VALUES.has(text)) return null;
  return text;
}

function pickBusinessValue(
  sources: ReadonlyArray<Record<string, string>>,
  candidates: readonly string[],
): { value: string; key: string } | null {
  for (const candidate of candidates) {
    for (const source of sources) {
      const normalized = normalizeBusinessValue(source[candidate]);
      if (normalized) return { value: normalized, key: candidate };
      const upper = candidate.toUpperCase();
      for (const [key, raw] of Object.entries(source)) {
        if (key.toUpperCase() !== upper) continue;
        const match = normalizeBusinessValue(raw);
        if (match) return { value: match, key };
      }
    }
  }
  return null;
}

/**
 * 设备由多个部件（PARTINDEX / DEV_SUBDEVICE）组成。GIM 把部分业务属性写在
 * 部件自己的 DEV/FAM 上，而用户是按“设备”阅读属性的，所以这里把设备下
 * 组件的属性并按设备优先合并；组件自身的值只补缺，不覆盖设备值。
 */
function collectComponentNodes(node: CbmNode, out: CbmNode[], limit = 120): void {
  for (const child of node.children) {
    if (out.length >= limit) return;
    out.push(child);
    collectComponentNodes(child, out, limit);
  }
}

async function readDevKv(state: AppState, devKey: string): Promise<Record<string, string> | null> {
  if (state.currentFiles) {
    const file = getFileByPath(state.currentFiles, devKey);
    return file ? parseKeyValue(await file.text()) : null;
  }
  return getCachedByPath(state.cachedDevProperties, devKey) ?? null;
}

async function collectPropertySources(
  state: AppState,
  node: CbmNode,
): Promise<{ sources: Record<string, string>[]; componentCount: number }> {
  const cbmKv = node.rawProperties ?? {};
  const componentNodes: CbmNode[] = [];
  collectComponentNodes(node, componentNodes);
  const devMerged: Record<string, string> = {};
  const famKv: Record<string, string> = {};
  const famPaths = new Set<string>();
  if (node.famPath) famPaths.add(withEntryPrefix('CBM', node.famPath));
  for (const ref of resolveBaseFamilyReferences(cbmKv)) famPaths.add(withEntryPrefix('CBM', ref.path));

  let componentCount = 0;
  const devSources: Array<{ key: string; kv: Record<string, string> }> = [];
  if (node.devPath) {
    const key = withEntryPrefix('DEV', node.devPath);
    const kv = await readDevKv(state, key);
    if (kv) devSources.push({ key, kv });
  }
  for (const component of componentNodes) {
    if (devSources.length >= 64) break;
    const refs = new Set<string>();
    if (component.devPath) refs.add(withEntryPrefix('DEV', component.devPath));
    for (const ref of resolveBaseFamilyReferences(component.rawProperties ?? {})) {
      refs.add(withEntryPrefix('DEV', ref.path));
    }
    for (const key of refs) {
      if (devSources.some((row) => row.key === key)) continue;
      const kv = await readDevKv(state, key);
      if (kv) devSources.push({ key, kv });
    }
    if (component.famPath) famPaths.add(withEntryPrefix('CBM', component.famPath));
    for (const ref of resolveBaseFamilyReferences(component.rawProperties ?? {})) {
      famPaths.add(withEntryPrefix('CBM', ref.path));
    }
  }
  for (let i = 0; i < devSources.length; i++) {
    const { kv } = devSources[i];
    let contributed = false;
    for (const [key, value] of Object.entries(kv)) {
      if (devMerged[key] !== undefined) continue;
      devMerged[key] = value;
      contributed = true;
    }
    if (contributed && i > 0) componentCount++;
    for (const ref of resolveBaseFamilyReferences(kv)) famPaths.add(withEntryPrefix('DEV', ref.path));
  }

  for (const path of famPaths) {
    let sections = getCachedByPath(state.cachedFamProperties, path);
    if (!sections && state.currentFiles) {
      const file = getFileByPath(state.currentFiles, path);
      if (file) sections = parseFamSectionsWithDiagnostics(await file.text(), path).sections;
    }
    if (!sections) continue;
    for (const section of sections.values()) {
      for (const [key, value] of section) {
        if (famKv[key] !== undefined) continue;
        const normalized = normalizeBusinessValue(value);
        if (normalized) famKv[key] = normalized;
      }
    }
  }
  return { sources: [famKv, devMerged, cbmKv], componentCount };
}

async function buildInspectorSummary(state: AppState, node: CbmNode): Promise<InspectorSummary> {
  const { sources, componentCount } = await collectPropertySources(state, node);
  const cbmKv = sources[2];

  const namePick = pickBusinessValue(sources, ['工程中名称', 'PARTNAME', 'SYMBOLNAME', '设备名称', 'NAME']);
  const name = namePick?.value
    ?? getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries);
  const typeLabel = normalizeBusinessValue(node.entityName)
    ?? normalizeBusinessValue(cbmKv['ENTITYNAME'])
    ?? '';
  const voltage = pickBusinessValue(sources, ['电压等级', 'VOLTAGEGRADE', 'VOLTAGE', '额定电压'])?.value ?? '';
  const systemPath = ['SYSTEMNAME1', 'SYSTEMNAME2', 'SYSTEMNAME3', 'SYSTEMNAME4']
    .map((key) => normalizeBusinessValue(cbmKv[key]))
    .filter((value): value is string => Boolean(value))
    .join(' / ');

  const keyDefinitions: Array<{ label: string; candidates: string[] }> = [
    { label: '设备名称', candidates: ['工程中名称', 'PARTNAME', 'SYMBOLNAME', '设备名称', 'NAME'] },
    { label: '电压等级', candidates: ['电压等级', 'VOLTAGEGRADE', 'VOLTAGE'] },
    { label: '制造商', candidates: ['生产厂家', '厂家', 'MANUFACTURER', '制造厂家'] },
    { label: '型号', candidates: ['装置型号', '型号', '设备型号', 'MODEL'] },
    { label: '额定容量', candidates: ['额定容量', 'RATEDCAPACITY'] },
    { label: '额定电压', candidates: ['额定电压', 'RATEDVOLTAGE'] },
    { label: '装置名称', candidates: ['装置名称'] },
    { label: '建设期次', candidates: ['建设期次', 'CONSTRUCTIONPHASE'] },
  ];
  const keyRows: Array<{ label: string; value: string }> = [];
  for (const definition of keyDefinitions) {
    if (keyRows.length >= 8) break;
    const picked = pickBusinessValue(sources, definition.candidates);
    if (picked) keyRows.push({ label: definition.label, value: picked.value });
  }

  const idDefinitions: Array<{ label: string; candidates: string[] }> = [
    { label: '调度编码', candidates: ['调度编码', 'SCHEDULCODE', 'DISPATCHCODE'] },
    { label: '实物 ID', candidates: ['实物ID', 'MATERIALID', 'ASSETID'] },
    { label: '电网标识编码', candidates: ['电网工程标识系统编码', 'GRIDIDENTIFICATIONSYSTEMCODE'] },
    { label: '设计模型编码', candidates: ['三维设计模型编码', 'DESIGNMODELCODE'] },
    { label: '装置编号', candidates: ['装置编号', '设备编号'] },
  ];
  const idRows: Array<{ label: string; value: string }> = [];
  for (const definition of idDefinitions) {
    const picked = pickBusinessValue(sources, definition.candidates);
    if (picked) idRows.push({ label: definition.label, value: picked.value });
  }

  return {
    name,
    identity: [typeLabel, voltage, systemPath].filter(Boolean).join(' · '),
    keyRows,
    idRows,
    systemPath,
    componentCount,
  };
}

function renderInspectorSummary(summary: InspectorSummary): string {
  const keyHtml = summary.keyRows.length > 0
    ? `<div class="props-section inspector-key"><div class="props-section-title">关键参数</div><div class="key-grid">${summary.keyRows.map((row) =>
      `<div class="key-cell"><span class="key-label">${escHtml(row.label)}</span><span class="key-value" title="${escHtml(row.value)}">${escHtml(row.value)}</span></div>`).join('')}</div></div>`
    : '';
  const idHtml = summary.idRows.length > 0
    ? `<details class="props-section inspector-ids"><summary>工程标识（${summary.idRows.length}）</summary><div class="id-grid">${summary.idRows.map((row) =>
      `<div class="id-row"><span class="id-label">${escHtml(row.label)}</span><code class="id-value" title="${escHtml(row.value)}">${escHtml(row.value)}</code></div>`).join('')}</div></details>`
    : '';
  const identity = summary.identity
    ? `<div class="inspector-identity">${escHtml(summary.identity)}</div>`
    : '';
  const components = summary.componentCount > 0
    ? `<div class="inspector-components">已合并 ${summary.componentCount} 个组件来源的属性</div>`
    : '';
  return `<div class="inspector-summary"><div class="inspector-name" title="${escHtml(summary.name)}">${escHtml(summary.name)}</div>${identity}${components}</div>${keyHtml}${idHtml}`;
}

function buildCbmOverviewAndSource(state: AppState, node: CbmNode, summaryHtml: string = ''): { overview: string; source: string } {
  const ov: Array<[string, string | FileReferenceValue]> = [
    ['实体类型', node.entityName],
    ['分类名称', node.classifyName],
  ];
  if (state.deviceUnknownBounds.has(node.path)) ov.push(['设备范围', '完整范围未确定，自动加载可支持几何；选择可查看细节']);
  const spatial = state.substationSpatialIndex?.linksByCbmPath.get(node.path);
  const ifcModelId = findDeviceIfcModel(state, node.path);
  // modelId 是 Fragments 的运行时标识（当前为 ifc_<hash>），不能拼成
  // 文件名；必须通过当前工程的 IfcEntry 反查真实包内路径。
  const inferredIfcPath = ifcModelId
    ? ifcReferencePath(ifcModelId, state.currentIfcEntries)
    : '';
  if (inferredIfcPath && !node.ifcFile) {
    ov.push(['所属 IFC 文件', fileReferenceValue('ifc', inferredIfcPath)]);
  }
  if (node.children.length > 0) ov.push(['子节点数', String(node.children.length)]);

  const src: Array<[string, string | FileReferenceValue]> = [['CBM 文件', fileReferenceValue('cbm', node.path, '定位当前 CBM')]];
  const directIfcPath = node.ifcFile
    ? ifcReferencePath(node.ifcFile, state.currentIfcEntries)
    : '';
  if (directIfcPath) src.push(['IFC 文件', fileReferenceValue('ifc', directIfcPath)]);
  if (node.ifcGuid) src.push(['IFC GUID', node.ifcGuid]);
  appendSourceDesignRows(src, spatial);
  appendAuxiliarySources(src, state, node);

  return { overview: summaryHtml + sectionHtml('基本信息', ov), source: sectionHtml('来源引用', src) };
}

/** CbmNode → FAM/DEV 参数内容 */
async function buildCbmParams(state: AppState, node: CbmNode): Promise<string> {
  return renderNodeFamDevProperties(state, node);
}

/** CbmNode → 关系内容（M0：子设备/DEV 引用占位，后续接入关系索引） */
function buildCbmRelations(state: AppState, node: CbmNode): string {
  const rel: Array<[string, string | FileReferenceValue]> = [];
  if (node.children.length > 0) rel.push(['子节点', `${node.children.length} 个`]);
  if (node.devPath) rel.push(['DEV 引用', fileReferenceValue('dev', node.devPath)]);
  let html = sectionHtml('对象关系', rel);
  const spatial = state.substationSpatialIndex?.linksByCbmPath.get(node.path);
  if (!spatial) return html;
  const spatialNode = spatial.spatialKey
    ? state.substationSpatialIndex?.nodeByKey.get(spatial.spatialKey)
    : undefined;
  const spatialPath = spatialNode
    ? buildSpatialPath(state.substationSpatialIndex!, spatialNode.key)
    : '';
  const evidence = spatial.confidence === 'confirmed'
    ? (spatial.spatialKey ? 'IFC 包含关系 + IFC GUID（已确认）' : 'IFC GUID 命中，但没有空间容器')
    : spatial.confidence === 'inferred' ? 'CBM/DEV 变换矩阵（位置推断）' : '未关联';
  const spatialRows: Array<[string, string | FileReferenceValue]> = [
    ['空间状态', evidence],
    ...(spatialPath ? [['空间路径', spatialPath] as [string, string]] : []),
    ...(spatial.sourceIfcFile ? [['IFC 文件', fileReferenceValue('ifc', spatial.sourceIfcFile)] as [string, string | FileReferenceValue]] : []),
    ...(spatial.sourceIfcGuid ? [['IFC GUID', spatial.sourceIfcGuid] as [string, string]] : []),
    ...(spatial.sourceDesignNames?.length ? [['来源图纸', spatial.sourceDesignNames.join('、')] as [string, string]] : []),
    ...(spatial.sourceDesignFiles?.length ? [['来源 IFC 文件', fileReferencesValue('ifc', spatial.sourceDesignFiles)] as [string, string | FileReferenceValue]] : []),
    ...(spatial.unlocatedReason ? [['未定位原因', spatial.unlocatedReason] as [string, string]] : []),
    ...(spatial.position ? [['位置（原始坐标）', spatial.position.map((value) => formatSpatialNumber(value)).join(', ')] as [string, string]] : []),
  ];
  return html + sectionHtml('空间关系', spatialRows);
}

function buildSpatialPath(
  index: NonNullable<AppState['substationSpatialIndex']>,
  key: string,
): string {
  const labels: string[] = [];
  const seen = new Set<string>();
  let current = index.nodeByKey.get(key);
  while (current && !seen.has(current.key)) {
    seen.add(current.key);
    labels.push(current.name);
    current = current.parentKey ? index.nodeByKey.get(current.parentKey) : undefined;
  }
  return labels.reverse().join(' / ');
}

function formatSpatialNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** FAM/DEV 导出器常用的空值哨兵不占用首屏；真实负数等正常值不受影响。 */
function isUsefulPropertyValue(value: unknown): boolean {
  return !isGimEmptyValue(value);
}

function withEntryPrefix(prefix: string, value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  return normalized.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
    ? normalized
    : `${prefix}/${normalized}`;
}

function getCachedByPath<T>(map: Map<string, T>, path: string): T | undefined {
  const exact = map.get(path);
  if (exact !== undefined) return exact;
  const wanted = path.replace(/\\/g, '/').toLowerCase();
  for (const [candidate, value] of map) {
    if (candidate.replace(/\\/g, '/').toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** 将 Fragments 的模型标识转成来源按钮可用的 IFC 路径。 */
function ifcReferencePath(modelId: string, entries: readonly import('../gim/types.js').IfcEntry[] = []): string {
  const value = modelId.trim();
  if (!value) return '';
  const entry = findIfcEntryByModelId(value, entries);
  if (entry) return entry.path;

  // CBM/FileDevRelation 中的引用经常只有 basename（例如 `foo.ifc`），
  // 而 IfcEntry.path 才是 GIM 包内真实资源身份。优先通过同一套三态
  // 解析规则反查真实路径；重复 basename 时返回 null，避免来源按钮
  // 指向不确定的文件。
  const resolvedModelId = resolveIfcModelId(value, entries);
  if (resolvedModelId) {
    const resolved = findIfcEntryByModelId(resolvedModelId, entries);
    if (resolved) return resolved.path;
  }

  // `resolveIfcModelId` 返回 null 既可能表示未知引用，也可能表示重复
  // basename。后者不能回退为 `foo.ifc`，否则 UI 会制造看似确定但实际
  // 不可定位的来源。只有确实没有任何候选时才保留原始引用作为诊断文本。
  const basename = normalizedIfcBasename(value);
  const basenameCandidates = entries.filter((item) => normalizedIfcBasename(item.path) === basename);
  if (basenameCandidates.length > 1) return '';

  // `ifc_<hash>` 是运行时身份，不是包内文件名。若当前工程没有对应
  // IfcEntry，宁可不显示来源按钮，也不能把内部 ID 拼成虚假的路径。
  // 任意 `ifc_` 前缀都属于内部 runtime 身份；只有能在当前 entry 清单
  // 反查成功时才显示来源，避免未知/未来格式的 ID 被拼成伪造路径。
  if (/^ifc_/i.test(value)) return '';
  return /\.ifc$/i.test(value) ? value : `${value}.ifc`;
}

function findDeviceIfcModel(state: AppState, cbmPath: string): string {
  const direct = state.deviceToIfcFile.get(cbmPath);
  if (direct) return direct;
  const normalizedPath = normalizeEntryPath(cbmPath);
  const exactMatches = Array.from(state.deviceToIfcFile)
    .filter(([key, modelId]) => modelId && normalizeEntryPath(key) === normalizedPath)
    .map(([, modelId]) => modelId);
  const exactIds = [...new Set(exactMatches)];
  if (exactIds.length === 1) return exactIds[0];
  if (exactIds.length > 1) return '';

  // FileDevRelation 既可能存完整 CBM 路径，也可能只存 basename。basename
  // 只在候选 modelId 唯一时采用，避免多个同名 CBM 被静默关联到第一个 IFC。
  const basename = normalizedPath.split('/').pop() || normalizedPath;
  const basenameMatches = Array.from(state.deviceToIfcFile)
    .filter(([key, modelId]) => {
      const keyBase = normalizeEntryPath(key).split('/').pop() || normalizeEntryPath(key);
      return Boolean(modelId) && keyBase === basename;
    })
    .map(([, modelId]) => modelId);
  const basenameIds = [...new Set(basenameMatches)];
  return basenameIds.length === 1 ? basenameIds[0] : '';
}

function appendSourceDesignRows(
  rows: Array<[string, string | FileReferenceValue]>,
  link: Pick<NonNullable<AppState['substationSpatialIndex']>['links'][number], 'sourceDesignNames' | 'sourceDesignFiles'> | undefined,
): void {
  if (link?.sourceDesignNames?.length) rows.push(['来源图纸', link.sourceDesignNames.join('、')]);
  if (link?.sourceDesignFiles?.length) rows.push(['来源 IFC 文件', fileReferencesValue('ifc', link.sourceDesignFiles)]);
}

function collectSourceDesigns(
  links: Array<Pick<NonNullable<AppState['substationSpatialIndex']>['links'][number], 'sourceDesignNames' | 'sourceDesignFiles'>>,
): { names: string[]; files: string[] } {
  const names: string[] = [];
  const files: string[] = [];
  const add = (target: string[], values: string[] | undefined): void => {
    for (const value of values ?? []) if (value && !target.some((item) => item.toLowerCase() === value.toLowerCase())) target.push(value);
  };
  for (const link of links) {
    add(names, link.sourceDesignNames);
    add(files, link.sourceDesignFiles);
  }
  return { names, files };
}

function findCbmNodeByPath(root: CbmNode | null, path: string): CbmNode | null {
  if (!root) return null;
  const queue: CbmNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.path === path) return node;
    queue.push(...node.children);
  }
  return null;
}

/** 显示 IFC 空间容器属性（空间树点击或搜索命中触发）。 */
export function showSpatialNodePropertiesBasic(
  state: AppState,
  node: IfcSpatialNode,
  index: SubstationSpatialIndex,
  request: SelectionRequest = state.beginSelection({kind:'spatial-node',key:node.key}),
): void {
  if (!state.isCurrentSelection(request)) return;
  setSelectionStatus(node.name || '未命名空间');
  const directObjects = node.directObjectKeys.length;
  const boundaryObjects = node.boundaryObjectKeys.length;
  const totalObjects = node.objectKeys.length;
  // 继承证据按空间节点的关系集合统计；对象级 spatialContainment 只是主空间
  // 兼容字段，不能覆盖一个构件在多个空间中的其它继承关系。
  const decompositionInheritedObjects = node.decompositionObjectKeys.length;
  const hostInheritedObjects = node.hostObjectKeys.length;
  const directLinks = index.linksBySpatialKey.get(node.key)?.length ?? 0;
  const children = node.childKeys.length;
  const modelPath = ifcReferencePath(node.modelId, state.currentIfcEntries);
  const overview = sectionHtml('空间容器', [
    ...(state.projectName ? [['工程', state.projectName] as [string, string]] : []),
    ['空间类型', node.ifcType],
    ['名称', node.name],
    ...(node.description ? [['描述', node.description] as [string, string]] : []),
    ...(node.objectType ? [['对象类型', node.objectType] as [string, string]] : []),
    ...(node.longName ? [['长名称', node.longName] as [string, string]] : []),
    ...(node.compositionType ? [['组成类型', node.compositionType] as [string, string]] : []),
    ...(modelPath ? [['模型', fileReferenceValue('ifc', modelPath)] as [string, string | FileReferenceValue]] : []),
    ...(node.elevation != null ? [['标高', formatSpatialNumber(node.elevation)] as [string, string]] : []),
    ...(node.placement ? [['位置', `${node.placement.position.map(formatSpatialNumber).join(', ')}${node.placement.unit ? ` (${node.placement.unit})` : ''}`] as [string, string]] : []),
    ['IFC 几何', node.geometryStatus === 'represented' ? '已提供 Representation' : '未提供 Representation'],
    ['空间内 IFC 构件', String(totalObjects)],
    ['直接 IFC 构件', String(directObjects)],
    ['空间边界关联', String(boundaryObjects)],
    ['分解关系继承', String(decompositionInheritedObjects)],
    ['宿主关系继承', String(hostInheritedObjects)],
    ['直接 CBM 关联', String(directLinks)],
    ['子空间容器', String(children)],
  ]);
  const relations = sectionHtml('空间关系', [
    ...(node.parentKey
      ? [['父空间', buildSpatialPath(index, node.parentKey)] as [string, string]]
      : [['父空间', '无（根空间）'] as [string, string]]),
    ['空间路径', buildSpatialPath(index, node.key)],
    ['包含关系', directObjects > 0 ? 'IFCRELCONTAINEDINSPATIALSTRUCTURE' : '暂无直接包含构件'],
    ...(boundaryObjects > 0 ? [['空间边界', 'IFCRELSPACEBOUNDARY（不等同于直接包含）'] as [string, string]] : []),
    ...(decompositionInheritedObjects > 0 ? [['分解继承规则', '沿 IFCRELAGGREGATES / IFCRELDECOMPOSES / IFCRELNESTS 继承空间'] as [string, string]] : []),
    ...(hostInheritedObjects > 0 ? [['宿主继承规则', '沿 IFCRELVOIDSELEMENT / IFCRELCONNECTSPORTTOELEMENT 继承空间'] as [string, string]] : []),
    ...(node.placementRef ? [['IFC 放置引用', node.placementRef] as [string, string]] : []),
    ...(node.representationRef ? [['IFC 表示引用', node.representationRef] as [string, string]] : []),
  ]);
  const params = '<div class="props-note">IFC 属性、材质、类型和分组在选中具体构件后通过 Fragments 按需读取。</div>';
  const source = sectionHtml('来源引用', [
    ['IFC 文件', fileReferenceValue('ifc', node.sourcePath)],
    ...(node.globalId ? [['IFC GUID', node.globalId] as [string, string]] : []),
  ]) + renderTechnicalSection('IFC 技术标识', 'ifc-space', [
    { key: 'expressId', value: String(node.expressId), mono: true },
    ...(node.placementRef ? [{ key: 'placementRef', value: node.placementRef, mono: true }] : []),
    { key: 'stableKey', value: node.key, mono: true },
  ]);
  const title = `<div class="props-header">${escHtml(node.name || '未命名空间')}</div>`;
  renderInspectorTabs(title, { overview, params, relations, source });
}

async function loadSpatialIfcItemData(state: AppState, object: IfcSpatialObject): Promise<string> {
  const ctx = propsDrawerViewerContext;
  if (!ctx || !object.globalId) {
    return '<div class="props-note">IFC 属性需在模型加载后按需读取（Fragments getItemsData）。</div>';
  }
  const logicalModelId = object.modelId;
  const runtimeModelId = state.ifcRuntimeModelIds.get(logicalModelId)
    ?? state.getRuntimeModelId(logicalModelId);
  const model = ctx.fragments.list.get(runtimeModelId);
  if (!model) return '<div class="props-note">对应 IFC 模型尚未完成加载，属性将在模型就绪后可读。</div>';
  try {
    const localIds = await model.getLocalIdsByGuids([object.globalId]);
    const localId = localIds[0];
    if (localId == null) return '<div class="props-empty">未在当前 IFC 模型中找到该 GUID。</div>';
    const itemsData = await model.getItemsData([localId], { attributesDefault: true });
    const data = itemsData[0] as unknown as Record<string, unknown> | undefined;
    return data ? renderIfcItemData(data) : '<div class="props-empty">该构件暂无 IFC 属性。</div>';
  } catch (error) {
    console.warn(`读取 IFC 构件属性失败 (${object.globalId}):`, error);
    return '<div class="props-note">IFC 属性读取失败，请稍后重试。</div>';
  }
}

function connectionOwnershipRows(state: AppState, evidence: IfcConnectionOwnership): Array<[string,string]> {
  return [
    ['CBM 来源关联', evidence.status === 'confirmed' ? '源 IFCGUID 已核对'
      : evidence.status === 'ambiguous' ? `${evidence.semanticNodes.length} 个来源候选` : '源模型未提供可验证关联'],
    ['DEV 装配归属', evidence.deviceNodes.length === 1
      ? getNodeDisplayName(evidence.deviceNodes[0], state.ifcGuidToName, state.currentIfcEntries)
      : evidence.deviceNodes.length ? `${evidence.deviceNodes.length} 个候选，未自动归属` : '未建立'],
  ];
}
function connectionEndpointRows(state: AppState, modelId: string, references?: readonly ConnectionEndpointEvidence[]): Array<[string,string]> {
  if(references===undefined)return [['设备端点关联','端点证据尚未收集；未据此推断设备归属']];
  if(!references.length)return [['设备端点关联','未发现可用的已支持引用；整站显示不依赖此关联']];
  const groups=new Map<string,ConnectionEndpointEvidence[]>();
  for(const ref of references){const key=`${ref.kind}:${ref.reference}`,items=groups.get(key)??[];items.push(ref);groups.set(key,items);}
  const index=ifcConnectionOwnershipIndex(state.currentCbmTree,state.currentIfcEntries);
  return [...groups.values()].slice(0,32).map(items=>{
    const ref=items[0];
    if(ref.kind==='ifc-element'){
      const evidence=index.get(modelId,ref.reference);
      return ['IFC 端点对象',evidence.semanticNodes.length===1
        ? `${getNodeDisplayName(evidence.semanticNodes[0],state.ifcGuidToName,state.currentIfcEntries)} · 源连接关系已核对`
        : `${ref.reference} · ${evidence.semanticNodes.length?`${evidence.semanticNodes.length} 个 CBM 候选`:'尚无 CBM/DEV 映射'}`] as [string,string];
    }
    const ports=state.substationConnectionPorts?.get(ref.reference)??[];
    const owners=[...new Map(ports.map(port=>[port.key,port])).values()];
    const names=owners.map(owner=>{
      const node=state.cbmNodeIndex.get(owner.nodePath)??findCbmNodeByPath(state.currentCbmTree,owner.nodePath);
      return node?getNodeDisplayName(node,state.ifcGuidToName,state.currentIfcEntries):owner.nodePath;
    });
    const label=[...new Set(items.map(item=>`${item.propertySet??''} / ${item.propertyName??''}`))].join('；');
    return [label||'源接线点',owners.length===1?`${names[0]} · GUID 与 DEV 装配引用已核对`
      : owners.length?`${owners.length} 个实例候选：${names.join('、')}；未自动归属`
        : `${ref.reference} · ${state.substationConnectionPorts?'没有可验证的 DEV 实例':'接线点 sidecar 证据尚未就绪'}`] as [string,string];
  });
}

/** 显示未直接关联 CBM 的 IFC 构件属性，属性详情由 Fragments 按需读取。 */
export async function showIfcSpatialObjectPropertiesBasic(
  state: AppState,
  object: IfcSpatialObject,
  index: SubstationSpatialIndex,
  request: SelectionRequest = state.beginSelection({kind:'ifc-object',key:object.key}),
): Promise<void> {
  const spatial = object.spatialKey ? index.nodeByKey.get(object.spatialKey) : undefined;
  const spatialPaths = object.spatialKeys
    .map((key) => buildSpatialPath(index, key))
    .filter(Boolean);
  const links = index.linksByIfcObjectKey.get(object.key) ?? [];
  const regional = state.ifcRegionalRuntimes.get(object.modelId);
  const regionalObject = regional?.index.objects.find((candidate) => candidate.expressId === object.expressId && candidate.globalId === object.globalId);
  const refinement = regionalObject ? ifcRefinementHtml(regional, regionalObject) : '';
  const linkedCbms = links
    .map((link) => findCbmNodeByPath(state.currentCbmTree, link.cbmPath))
    .filter((node): node is CbmNode => !!node);
  const sourceDesign = collectSourceDesigns(links);
  const modelPath = ifcReferencePath(object.modelId, state.currentIfcEntries);
  const overview = sectionHtml('IFC 构件', [
    ['名称', object.name],
    ['IFC 类型', object.ifcType],
    ...(object.description ? [['描述', object.description] as [string, string]] : []),
    ...(object.objectType ? [['对象类型', object.objectType] as [string, string]] : []),
    ...(object.predefinedType ? [['预定义类型', object.predefinedType] as [string, string]] : []),
    ...(object.tag ? [['Tag', object.tag] as [string, string]] : []),
    ...(modelPath ? [['模型', fileReferenceValue('ifc', modelPath)] as [string, string | FileReferenceValue]] : []),
    ['空间状态', spatial
      ? object.spatialContainment === 'inherited'
        ? object.spatialInheritanceKind === 'host-relation' ? '由宿主关系继承空间归属' : '由 IFC 分解关系继承空间归属'
        : object.spatialContainment === 'boundary' ? '由 IFC 空间边界关系关联'
          : '已由 IFC 包含关系确认'
      : '未落入 IFC 空间容器'],
    ...(spatialPaths.length > 0 ? [['空间路径', spatialPaths.join('；')] as [string, string]] : []),
    ['IFC 几何', object.geometryStatus === 'represented' ? '已提供 Representation' : '未提供 Representation'],
    ...(object.placement ? [['位置', `${object.placement.position.map(formatSpatialNumber).join(', ')}${object.placement.unit ? ` (${object.placement.unit})` : ''}`] as [string, string]] : []),
  ]) + (isRegionalConnectionObject({...object,bounds:[]}) ? sectionHtml('连接对象归属',[
    ...connectionOwnershipRows(state,ifcConnectionOwnershipIndex(state.currentCbmTree,state.currentIfcEntries).get(object.modelId,object.globalId)),
    ...connectionEndpointRows(state,object.modelId,regionalObject?.connectionEndpoints),
  ]) : '') + refinement;
  const relations = sectionHtml('对象关系', [
    ...(linkedCbms.length > 0
      ? [['CBM 关联', linkedCbms.map((node) => getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries)).join('、')] as [string, string]]
      : [['CBM 关联', '未命中（保留为 IFC 构件）'] as [string, string]]),
    ['CBM 关联数量', String(links.length)],
    ...(sourceDesign.names.length > 0
      ? [['来源图纸', sourceDesign.names.join('、')] as [string, string]]
      : []),
    ...(sourceDesign.files.length > 0
      ? [['来源 IFC 文件', fileReferencesValue('ifc', sourceDesign.files)] as [string, string | FileReferenceValue]]
      : []),
    ...(spatial ? [['所属空间', spatial.name] as [string, string]] : []),
    ...(object.spatialKeys.length > 1 ? [['空间关系数量', String(object.spatialKeys.length)] as [string, string]] : []),
    ['IFC 属性', object.propertyDataDeferred ? '参数页按需读取（Fragments）' : '未发现 IFC 属性'],
    ['关系记录', String(object.relationshipCount)],
    ...(object.relationshipTypes
      ? [['关系类型', Object.entries(object.relationshipTypes).map(([type, count]) => `${type} ×${count}`).join('、')] as [string, string]]
      : []),
    ...(object.parentObjectKey ? [['父构件', object.parentObjectKey] as [string, string]] : []),
    ...(object.hostObjectKey ? [['宿主构件', object.hostObjectKey] as [string, string]] : []),
    ...(object.childObjectKeys.length > 0 ? [['子构件', String(object.childObjectKeys.length)] as [string, string]] : []),
  ]);
  const source = sectionHtml('来源引用', [
    ['IFC 文件', fileReferenceValue('ifc', object.sourcePath)],
    ...(object.globalId ? [['IFC GUID', object.globalId] as [string, string]] : [['IFC GUID', '未提供'] as [string, string]]),
  ]) + renderTechnicalSection('IFC 技术标识', 'ifc-object', [
    { key: 'expressId', value: String(object.expressId), mono: true },
    ...(object.placementRef ? [{ key: 'placementRef', value: object.placementRef, mono: true }] : []),
    ...(object.representationRef ? [{ key: 'representationRef', value: object.representationRef, mono: true }] : []),
    { key: 'stableKey', value: object.key, mono: true },
  ]);
  const title = `<div class="props-header">${escHtml(object.name || 'IFC 构件')}</div>`;
  let params = '<div class="props-note">正在准备 IFC 属性（按需读取）…</div>';
  const render = (): void => { if (state.isCurrentSelection(request)) { setSelectionStatus(object.name || 'IFC 构件');renderInspectorTabs(title, { overview, params, relations, source }); if (regionalObject) bindIfcRefinementControls(state, regional, regionalObject, request); } };
  render();
  params = await loadSpatialIfcItemData(state, object);
  render();
}

/** 显示 CbmNode 属性（基础版，不需要 Viewer，不含 IFC 原生属性） */
export function showUnlinkedSldProperties(state: AppState, gridId: string, request: SelectionRequest): void {
  if (!state.isCurrentSelection(request)) return;
  openPropsDrawerUI();
  setSelectionStatus(`SLD ${gridId}`);
  state.selectionGeometry={status:'unlinked',detail:'此拓扑对象未关联 CBM 设备，保留相机位置。'};
  renderInspectorTabs('<div class="props-header">SLD 拓扑对象</div>',{
    overview:sectionHtml('拓扑对象',[['gridId',gridId],['关联状态',state.selectionGeometry.detail]]),
    params:'',relations:'',source:'',
  });
}

export async function showNodePropertiesBasic(state: AppState, node: CbmNode, request: SelectionRequest = state.beginSelection({kind:'cbm',key:node.path})): Promise<void> {
  if (!state.isCurrentSelection(request)) return;
  setSelectionStatus(getNodeDisplayName(node,state.ifcGuidToName,state.currentIfcEntries));
  const endSummary=beginSelectionStage(state,request,'propertySummary');
  let summaryHtml: string;
  try { summaryHtml=renderInspectorSummary(await buildInspectorSummary(state,node)); }
  finally { endSummary(); }
  if (!state.isCurrentSelection(request)) return;
  const { overview, source } = buildCbmOverviewAndSource(state, node, summaryHtml);
  const title = `<div class="props-header">${escHtml(getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries))}</div>`;
  const owner=`${request.session.generation}:${request.id}:${node.path}`;
  const devControl = devRefinementHtml(state, node);
  const ifcControl = nodeIfcRefinement(state, node);
  const overviewWithRefinement = overview + devControl + (ifcControl ? ifcRefinementHtml(ifcControl.runtime, ifcControl.object) : '');
  // Same-request geometry refresh must not close a tab/details the user has
  // just opened. Keep the completed inspector visible while its refresh reads.
  if(propsDrawerBody.dataset.cbmSelection!==owner){
    renderInspectorTabs(title, { overview: overviewWithRefinement, params:'<div class="props-note">正在读取属性…</div>', relations:buildCbmRelations(state,node), source });
    propsDrawerBody.dataset.cbmSelection=owner;
    bindDevRefinementControls(state, node, request);
    bindDevGeometryRetryControls(state, node, request);
    if (ifcControl) bindIfcRefinementControls(state, ifcControl.runtime, ifcControl.object, request);
  }
  const endParams=beginSelectionStage(state,request,'propertyParams');
  let params: string;
  try { params=await buildCbmParams(state,node); } finally { endParams(); }
  if (!state.isCurrentSelection(request)) return;
  const relations = buildCbmRelations(state, node);
  const activeTab=propsDrawerBody.dataset.cbmSelection===owner ? propsDrawerBody.querySelector('[data-itab].active')?.getAttribute('data-itab')??'overview' : 'overview';
  const technicalOpen=propsDrawerBody.dataset.cbmSelection===owner && Boolean(propsDrawerBody.querySelector<HTMLDetailsElement>('[data-geometry-details] details')?.open);
  renderInspectorTabs(title, { overview: overviewWithRefinement, params, relations, source }, activeTab);
  propsDrawerBody.dataset.cbmSelection=owner;
  bindDevRefinementControls(state, node, request);
  bindDevGeometryRetryControls(state, node, request);
  if (ifcControl) bindIfcRefinementControls(state, ifcControl.runtime, ifcControl.object, request);
  if(technicalOpen){const details=propsDrawerBody.querySelector<HTMLDetailsElement>('[data-geometry-details] details');if(details)details.open=true;}
}

/** 显示 CbmNode 属性（完整版，包含 IFC 原生属性，需要 Viewer） */
export async function showNodeProperties(ctx: ViewerContext, state: AppState, node: CbmNode, request: SelectionRequest = state.beginSelection({kind:'cbm',key:node.path})): Promise<void> {
  if (!state.isCurrentSelection(request)) return;
  setSelectionStatus(getNodeDisplayName(node,state.ifcGuidToName,state.currentIfcEntries));
  let overview = '';
  let params = '';
  let relations = buildCbmRelations(state, node);
  let source = '';

  // 概览：基本信息
  const bp: Array<[string, string | FileReferenceValue]> = [
    ['实体类型', node.entityName],
    ['分类名称', node.classifyName],
  ];
  const spatialLink = state.substationSpatialIndex?.linksByCbmPath.get(node.path);
  const ifcModelId = findDeviceIfcModel(state, node.path);
  const inferredIfcPath = ifcModelId
    ? ifcReferencePath(ifcModelId, state.currentIfcEntries)
    : '';
  if (inferredIfcPath && !node.ifcFile) {
    bp.push(['所属 IFC 文件', fileReferenceValue('ifc', inferredIfcPath)]);
  }
  if (node.children.length > 0) bp.push(['子节点数', String(node.children.length)]);
  const ifcControl = nodeIfcRefinement(state, node);
  overview += sectionHtml('基本信息', bp)
    + devRefinementHtml(state, node)
    + (ifcControl ? ifcRefinementHtml(ifcControl.runtime, ifcControl.object) : '');

  // 参数：FAM/DEV 属性
  params += await renderNodeFamDevProperties(state, node);

  // 来源：路径 + GUID + 变换矩阵
  const sp: Array<[string, string | FileReferenceValue]> = [['CBM 文件', fileReferenceValue('cbm', node.path, '定位当前 CBM')]];
  const directIfcPath = node.ifcFile
    ? ifcReferencePath(node.ifcFile, state.currentIfcEntries)
    : '';
  if (directIfcPath) sp.push(['IFC 文件', fileReferenceValue('ifc', directIfcPath)]);
  if (node.ifcGuid) sp.push(['IFC GUID', node.ifcGuid]);
  appendSourceDesignRows(sp, spatialLink);
  appendAuxiliarySources(sp, state, node);
  source += sectionHtml('来源引用', sp);
  if (node.transformMatrix && node.transformMatrix !== '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1') {
    source += sectionHtml('变换矩阵', [['矩阵（列主序）', node.transformMatrix]], true);
  }

  // IFC 构件原生属性 → 参数；GUID 关联 → 关系
  if (node.ifcFile && node.ifcGuid) {
    const modelId = resolveIfcModelId(node.ifcFile, state.currentIfcEntries);
    const runtimeModelId = modelId ? state.getRuntimeModelId(modelId) : '';
    const model = runtimeModelId ? ctx.fragments.list.get(runtimeModelId) : undefined;
    if (modelId && model) {
      try {
        const localIds = await model.getLocalIdsByGuids([node.ifcGuid]);
        const localId = localIds[0];
        if (localId !== null && localId !== undefined) {
          relations += sectionHtml('IFC 构件关联', [
            ['模型', fileReferenceValue('ifc', ifcReferencePath(modelId, state.currentIfcEntries))],
            ['LocalId', String(localId)],
            ['GUID', node.ifcGuid],
          ]);
          try {
            const itemsData = await model.getItemsData([localId], { attributesDefault: true });
            if (itemsData.length > 0) {
              params += renderIfcItemData(itemsData[0] as unknown as Record<string, unknown>);
            }
          } catch (err) {
            console.warn('读取 IFC 属性失败:', err);
          }
        }
      } catch (err) {
        console.warn(`IFC GUID 查找失败 (${node.ifcGuid}):`, err);
      }
    }
  }

  const title = `<div class="props-header">${escHtml(getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries))}</div>`;
  if (!state.isCurrentSelection(request)) return;
  const summaryHtml = renderInspectorSummary(await buildInspectorSummary(state, node));
  if (!state.isCurrentSelection(request)) return;
  renderInspectorTabs(title, {
    overview: summaryHtml + overview,
    params,
    relations,
    source,
  });
  bindDevRefinementControls(state, node, request);
  bindDevGeometryRetryControls(state, node, request);
  if (ifcControl) bindIfcRefinementControls(state, ifcControl.runtime, ifcControl.object, request);
}

/** 展示 IFC 构件属性（从 3D 点击触发） */
export async function showIfcElementProperties(ctx: ViewerContext, state: AppState, modelId: string, localId: number, request: SelectionRequest = state.beginSelection({kind:'ifc-element',key:`${modelId}:${localId}`})): Promise<void> {
  if (!state.isCurrentSelection(request)) return;
  const logicalModelId = state.resolveLogicalModelId(modelId) ?? modelId;
  const runtimeModelId = state.ifcRuntimeModelIds.get(logicalModelId) ?? modelId;
  const model = ctx.fragments.list.get(runtimeModelId);
  setSelectionStatus(`IFC ${logicalModelId} / ${localId}`);
  renderInspectorTabs('<div class="props-header">IFC 构件</div>',{overview:'<div class="props-note">正在读取选中 IFC 构件…</div>',params:'',relations:'',source:''});
  if (!model) {
    state.selectionGeometry={status:'not-loaded',detail:'对应 IFC 模型尚未加载或已卸载，无法读取对象详情。'};
    renderInspectorTabs('<div class="props-header">IFC 构件</div>',{overview:sectionHtml('当前选择',[['LocalId',String(localId)],['状态',state.selectionGeometry.detail]]),params:'',relations:'',source:''});
    return;
  }
  let guid: string | null = null;
  let gimNode: CbmNode | null = null;
  try {
    const guids = await model.getGuidsByLocalIds([localId]);
    guid = guids[0] || null;
    if (guid) {
      gimNode = state.ifcGuidIndex.get(`${logicalModelId}:${guid}`)
        // 兼容升级前以 basename.ifc 为 key 的旧内存索引。
        ?? state.ifcGuidIndex.get(`${logicalModelId}.ifc:${guid}`)
        ?? null;
    }
  } catch { /* GUID 获取失败 */ }

  // 概览：构件身份 + GIM 设备
  const ov: Array<[string, string | FileReferenceValue]> = [
    ['模型', fileReferenceValue('ifc', ifcReferencePath(logicalModelId, state.currentIfcEntries))],
    ['LocalId', String(localId)],
  ];
  if (guid) {
    ov.push(['GUID', guid]);
  }
  const regional=state.ifcRegionalRuntimes.get(logicalModelId);
  const regionalObject = guid
    ? regional?.index.objects.find((object) => object.globalId === guid)
    : undefined;
  const connectionEvidence = regionalObject && isRegionalConnectionObject(regionalObject) && guid
    ? ifcConnectionOwnershipIndex(state.currentCbmTree, state.currentIfcEntries).get(logicalModelId, guid)
    : undefined;
  // Connection objects may have a CBM identity without a physical DEV or any
  // electrical endpoint references. Do not select an arbitrary alias owner.
  if (connectionEvidence) {
    gimNode = connectionEvidence.semanticNodes.length === 1 ? connectionEvidence.semanticNodes[0] : null;
    ov.push(...connectionOwnershipRows(state,connectionEvidence));
    ov.push(...connectionEndpointRows(state,logicalModelId,regionalObject?.connectionEndpoints));
  }
  if (gimNode) {
    ov.push([connectionEvidence ? 'CBM 来源对象' : 'GIM 设备', getNodeDisplayName(gimNode, state.ifcGuidToName, state.currentIfcEntries)]);
    ov.push(['GIM 分类', gimNode.classifyName]);
  }
  const overview = sectionHtml('基本信息', ov)
    + (regionalObject && regional ? ifcRefinementHtml(regional, regionalObject) : '');

  // 参数：IFC 原生属性 + GIM 设备 FAM/DEV
  let params = '';
  try {
    const itemsData = await model.getItemsData([localId], { attributesDefault: true });
    if (itemsData.length > 0) {
      params += renderIfcItemData(itemsData[0] as unknown as Record<string, unknown>);
    }
  } catch (err) {
    console.warn('读取 IFC 属性失败:', err);
  }
  if(regional&&guid){
    const matches=regional.index.objects.filter(object=>object.globalId===guid);
    if(matches.length===1){
      try{
        if(!state.isCurrentSelection(request))return;
        openPropsDrawer(ctx);
        renderInspectorTabs('<div class="props-header">IFC 构件</div>',{overview,params:params+'<div class="props-note">正在读取源属性集、类型与材料…</div>',relations:'',source:''});
        const source=await regional.properties(matches[0].expressId);
        if(!state.isCurrentSelection(request))return;
        params+=sectionHtml('IFC 原始属性',Object.entries(source.attributes).map(([key,value])=>[key,typeof value==='object'?JSON.stringify(value):String(value)] as [string,string]));
        for(const item of [...source.propertySets,...(source.typeProperties??[]),...(source.materials??[])])params+=sectionHtml('属性集 / 类型 / 材料',[['原始值',JSON.stringify(item)]],true);
      }catch(error){params+=`<div class="props-note">${escHtml(`源属性暂不可用：${error}`)}</div>`;}
    }
  }
  if (gimNode) {
    params += await renderNodeFamDevProperties(state, gimNode);
  }

  // 关系：GIM 设备关联
  const relations = connectionEvidence
    ? sectionHtml('连接对象来源证据', [
        ['CBM 对象', connectionEvidence.semanticNodes.length
          ? connectionEvidence.semanticNodes.map(node => `${getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries)} · ${node.path}`).join('；') : '没有匹配的源引用'],
        ['归属规则', '仅采用同一 IFC 来源中的精确 IFCGUID；空间邻近不作为已确认连接'],
      ])
    : gimNode
    ? sectionHtml('GIM 设备关联', [
        ['关联设备', getNodeDisplayName(gimNode, state.ifcGuidToName, state.currentIfcEntries)],
        ['分类', gimNode.classifyName],
      ])
    : '';

  // 来源：模型与 GUID
  const source = sectionHtml('来源引用', [
    ['IFC 模型', fileReferenceValue('ifc', ifcReferencePath(logicalModelId, state.currentIfcEntries))],
    ['LocalId', String(localId)],
    ...(guid ? ([['GUID', guid]] as Array<[string, string | FileReferenceValue]>) : []),
  ]);

  const title = '<div class="props-header">IFC 构件</div>';
  if (!state.isCurrentSelection(request)) return;
  renderInspectorTabs(title, { overview, params, relations, source });
  if (regionalObject && regional) bindIfcRefinementControls(state, regional, regionalObject, request);
}
