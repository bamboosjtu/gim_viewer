import type { CbmNode } from '../gim/types.js';
import type { AppState } from '../app/state.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import type { IfcSpatialNode, IfcSpatialObject, SubstationSpatialIndex } from '../gim/ifcSpatialParser.js';
import { escHtml } from '../shared/html.js';
import { parseFamSections, parseKeyValue } from '../shared/gimParsing.js';
import { getNodeDisplayName } from '../shared/displayName.js';
import {
  findIfcEntryByModelId,
  normalizeEntryPath,
  normalizedIfcBasename,
  resolveIfcModelId,
} from '../gim/modelIdentity.js';
import { propsDrawerBody, propsDrawer, btnToggleProps, btnCloseProps, btnExportProps } from './dom.js';
import { buildCsv, downloadTextFile } from '../shared/csv.js';
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
export function openPropsDrawer(ctx: ViewerContext): void {
  propsDrawer.classList.remove('collapsed');
  btnToggleProps.style.right = '364px';
  refreshViewportLayout(ctx);
}

/** 打开属性面板（纯 UI，不刷新视口，用于无 Viewer 场景） */
export function openPropsDrawerUI(): void {
  propsDrawer.classList.remove('collapsed');
  btnToggleProps.style.right = '364px';
}

/** 关闭属性面板（纯 UI，不刷新视口，用于无 Viewer 场景） */
export function closePropsDrawerUI(): void {
  propsDrawer.classList.add('collapsed');
  btnToggleProps.style.right = '12px';
}

/** 关闭属性面板 */
export function closePropsDrawer(ctx: ViewerContext): void {
  propsDrawer.classList.add('collapsed');
  btnToggleProps.style.right = '12px';
  refreshViewportLayout(ctx);
}

/** 切换属性面板 */
export function togglePropsDrawer(ctx: ViewerContext): void {
  if (propsDrawer.classList.contains('collapsed')) {
    openPropsDrawer(ctx);
  } else {
    closePropsDrawer(ctx);
  }
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
  btnToggleProps.addEventListener('click', () => {
    if (propsDrawerViewerContext) togglePropsDrawer(propsDrawerViewerContext);
    else {
      if (propsDrawer.classList.contains('collapsed')) openPropsDrawerUI();
      else closePropsDrawerUI();
    }
  });
  btnCloseProps.addEventListener('click', () => {
    if (propsDrawerViewerContext) closePropsDrawer(propsDrawerViewerContext);
    else closePropsDrawerUI();
  });
  // 导出当前属性面板为 CSV（dev-log「无导出」项）：
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

  // M0 设计系统：检查器四页签（概览/参数/关系/来源）点击委托。
  // CSV 导出遍历全部 pane（含隐藏），导出内容不受当前页签影响。
  propsDrawerBody.addEventListener('click', (ev) => {
    const element = ev.target instanceof Element ? ev.target : null;
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
 * 渲染四页签结构到检查器 body（M0 设计系统 §18 ObjectInspector）。
 *
 * @param titleHtml 对象标题（.props-header）
 * @param buckets 四个页签的内容 HTML（各页签内部使用 .props-section 结构）
 */
export function renderInspectorTabs(titleHtml: string, buckets: InspectorBuckets, activeTab = 'overview'): void {
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

/**
 * 渲染节点的 FAM/DEV 属性为 HTML。
 * 优先从 currentFiles 读取（首次打开），回退到 cachedFamProperties/cachedDevProperties（缓存命中）。
 */
async function renderNodeFamDevProperties(state: AppState, node: CbmNode): Promise<string> {
  let html = '';

  // FAM 属性（CBM/{famPath}）
  if (node.famPath) {
    const famKey = `CBM/${node.famPath}`;
    if (state.currentFiles) {
      const f = state.currentFiles.get(famKey);
      if (f) html += renderFamSections(parseFamSections(await f.text()), 'substation-fam');
    } else {
      const cached = state.cachedFamProperties.get(famKey);
      if (cached) html += renderFamSections(cached, 'substation-fam');
    }
  }

  // DEV 属性（DEV/{devPath}）
  if (node.devPath) {
    const devKey = `DEV/${node.devPath}`;
    let kv: Record<string, string> | null = null;
    if (state.currentFiles) {
      const f = state.currentFiles.get(devKey);
      if (f) kv = parseKeyValue(await f.text());
    } else {
      kv = state.cachedDevProperties.get(devKey) ?? null;
    }
    if (kv) {
      const deviceRows: PropertyRow[] = [
        ...(isUsefulPropertyValue(kv['SYMBOLNAME']) ? [{ key: 'SYMBOLNAME', value: kv['SYMBOLNAME'] }] : []),
        ...(isUsefulPropertyValue(kv['TYPE']) ? [{ key: 'TYPE', value: kv['TYPE'] }] : []),
      ];
      html += renderPropertySection('设备信息', 'substation-dev', deviceRows);
      const otherDevRows = Object.entries(kv)
        .filter(([key, value]) => isUsefulPropertyValue(value) && key !== 'SYMBOLNAME' && key !== 'TYPE')
        .map(([key, value]) => ({ key, value }));
      if (otherDevRows.length > 0) {
        const primaryDevRows = otherDevRows.filter((row) => (getPropertyDefinition('substation-dev', row.key)?.priority ?? 2) < 2);
        const technicalDevRows = otherDevRows.filter((row) => (getPropertyDefinition('substation-dev', row.key)?.priority ?? 2) >= 2);
        html += renderPropertySection('DEV 参数', 'substation-dev', primaryDevRows);
        html += renderTechnicalSection('DEV 技术字段', 'substation-dev', technicalDevRows);
      }
      // DEV BASEFAMILY 引用的 FAM 属性
      const famRef = kv['BASEFAMILY'];
      if (famRef) {
        const famKey = `DEV/${famRef}`;
        if (state.currentFiles) {
          const famFile = state.currentFiles.get(famKey);
          if (famFile) html += renderFamSections(parseFamSections(await famFile.text()), 'substation-fam');
        } else {
          const cached = state.cachedFamProperties.get(famKey);
          if (cached) html += renderFamSections(cached, 'substation-fam');
        }
      }
    }
  }

  return html;
}

/** 渲染 getItemsData 返回的属性数据为 HTML */
function renderIfcItemData(data: Record<string, unknown>, depth = 0): string {
  if (!data || typeof data !== 'object') return '';
  const scalarRows: PropertyRow[] = [];
  const nested: Array<[string, Record<string, unknown>]> = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === '' || key.startsWith('_')) continue;
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
    .filter(([, value]) => typeof value === 'string' ? Boolean(value) : Boolean(value?.text))
    .map(([key, value]) => {
      if (typeof value === 'string') return { key, value, mono: monoValue };
      return { key, value: value.text, valueHtml: value.html, valueText: value.text, mono: monoValue };
    });
  return renderPropertySection(title, component, rows);
}

/** CbmNode → 概览 + 来源 内容（基础字段，不含 IFC 原生属性） */
function buildCbmOverviewAndSource(state: AppState, node: CbmNode): { overview: string; source: string } {
  const ov: Array<[string, string | FileReferenceValue]> = [
    ['实体类型', node.entityName],
    ['分类名称', node.classifyName],
  ];
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

  return { overview: sectionHtml('基本信息', ov), source: sectionHtml('来源引用', src) };
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
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  return text !== '' && text !== '/' && text !== '-';
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

/** IFC Pset/工程量详情；属性值按原始单位保留，避免检查器只剩“有几个属性集”。 */
function renderIfcPropertyGroups(groups: NonNullable<IfcSpatialObject['propertySets']> | undefined): string {
  if (!groups || groups.length === 0) return '';
  let html = '';
  for (const group of groups) {
    if (group.values.length === 0 && !group.truncated) continue;
    const title = `${group.name} · ${group.kind === 'quantity' ? '工程量' : '属性'}`;
    const rows: PropertyRow[] = group.values.map((value) => ({
      key: value.name,
      value: value.value,
      unit: value.unit,
    }));
    const primary = rows.filter((row) => (getPropertyDefinition('ifc-object', row.key)?.priority ?? 2) < 2);
    const technical = rows.filter((row) => (getPropertyDefinition('ifc-object', row.key)?.priority ?? 2) >= 2);
    html += renderPropertySection(title, 'ifc-object', primary);
    if (technical.length > 0) html += renderTechnicalSection(`${title} · 技术字段`, 'ifc-object', technical);
    if (group.truncated) {
      html += '<div class="props-note">属性过多，仅显示前 256 项</div>';
    }
  }
  return html;
}

function renderIfcExtendedMetadata(item: Pick<IfcSpatialObject, 'materials' | 'classifications' | 'typeName' | 'groupNames'>): string {
  const rows: Array<[string, string | FileReferenceValue]> = [];
  if (item.typeName) rows.push(['类型定义', item.typeName]);
  if (item.materials && item.materials.length > 0) rows.push(['材质', item.materials.join('、')]);
  if (item.classifications && item.classifications.length > 0) rows.push(['分类引用', item.classifications.join('、')]);
  if (item.groupNames && item.groupNames.length > 0) rows.push(['所属组/系统', item.groupNames.join('、')]);
  return sectionHtml('IFC 扩展信息', rows);
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
): void {
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
  const params = renderIfcPropertyGroups(node.propertySets)
    + renderIfcExtendedMetadata(node);
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

/** 显示未直接关联 CBM 的 IFC 构件属性，避免空间树中的 IFC 对象成为“死节点”。 */
export function showIfcSpatialObjectPropertiesBasic(
  state: AppState,
  object: IfcSpatialObject,
  index: SubstationSpatialIndex,
): void {
  const spatial = object.spatialKey ? index.nodeByKey.get(object.spatialKey) : undefined;
  const spatialPaths = object.spatialKeys
    .map((key) => buildSpatialPath(index, key))
    .filter(Boolean);
  const links = index.linksByIfcObjectKey.get(object.key) ?? [];
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
  ]);
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
    ...(object.propertySetNames && object.propertySetNames.length > 0
      ? [['属性集', object.propertySetNames.join('、')] as [string, string]]
      : [['属性集', '未发现 IFCRELDEFINESBYPROPERTIES 关联'] as [string, string]]),
    ['关系记录', String(object.relationshipCount)],
    ...(object.relationshipTypes
      ? [['关系类型', Object.entries(object.relationshipTypes).map(([type, count]) => `${type} ×${count}`).join('、')] as [string, string]]
      : []),
    ...(object.parentObjectKey ? [['父构件', object.parentObjectKey] as [string, string]] : []),
    ...(object.hostObjectKey ? [['宿主构件', object.hostObjectKey] as [string, string]] : []),
    ...(object.childObjectKeys.length > 0 ? [['子构件', String(object.childObjectKeys.length)] as [string, string]] : []),
  ]);
  const params = renderIfcPropertyGroups(object.propertySets) + renderIfcExtendedMetadata(object);
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
  renderInspectorTabs(title, { overview, params, relations, source });
}

/** 显示 CbmNode 属性（基础版，不需要 Viewer，不含 IFC 原生属性） */
export async function showNodePropertiesBasic(state: AppState, node: CbmNode): Promise<void> {
  const { overview, source } = buildCbmOverviewAndSource(state, node);
  const params = await buildCbmParams(state, node);
  const relations = buildCbmRelations(state, node);
  const title = `<div class="props-header">${escHtml(getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries))}</div>`;
  renderInspectorTabs(title, { overview, params, relations, source });
}

/** 显示 CbmNode 属性（完整版，包含 IFC 原生属性，需要 Viewer） */
export async function showNodeProperties(ctx: ViewerContext, state: AppState, node: CbmNode): Promise<void> {
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
  overview += sectionHtml('基本信息', bp);

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
  source += sectionHtml('来源引用', sp);
  if (node.transformMatrix && node.transformMatrix !== '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1') {
    source += sectionHtml('变换矩阵', [['矩阵（列主序）', node.transformMatrix]], true);
  }

  // IFC 构件原生属性 → 参数；GUID 关联 → 关系
  if (node.ifcFile && node.ifcGuid) {
    const modelId = resolveIfcModelId(node.ifcFile, state.currentIfcEntries);
    const model = modelId ? ctx.fragments.list.get(modelId) : undefined;
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
  renderInspectorTabs(title, {
    overview,
    params,
    relations,
    source,
  });
}

/** 展示 IFC 构件属性（从 3D 点击触发） */
export async function showIfcElementProperties(ctx: ViewerContext, state: AppState, modelId: string, localId: number): Promise<void> {
  const model = ctx.fragments.list.get(modelId);
  if (!model) return;

  let guid: string | null = null;
  let gimNode: CbmNode | null = null;
  try {
    const guids = await model.getGuidsByLocalIds([localId]);
    guid = guids[0] || null;
    if (guid) {
      gimNode = state.ifcGuidIndex.get(`${modelId}:${guid}`)
        // 兼容升级前以 basename.ifc 为 key 的旧内存索引。
        ?? state.ifcGuidIndex.get(`${modelId}.ifc:${guid}`)
        ?? null;
    }
  } catch { /* GUID 获取失败 */ }

  // 概览：构件身份 + GIM 设备
  const ov: Array<[string, string | FileReferenceValue]> = [
    ['模型', fileReferenceValue('ifc', ifcReferencePath(modelId, state.currentIfcEntries))],
    ['LocalId', String(localId)],
  ];
  if (guid) {
    ov.push(['GUID', guid]);
    if (gimNode) {
      ov.push(['GIM 设备', getNodeDisplayName(gimNode, state.ifcGuidToName, state.currentIfcEntries)]);
      ov.push(['GIM 分类', gimNode.classifyName]);
    }
  }
  const overview = sectionHtml('基本信息', ov);

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
  if (gimNode) {
    params += await renderNodeFamDevProperties(state, gimNode);
  }

  // 关系：GIM 设备关联
  const relations = gimNode
    ? sectionHtml('GIM 设备关联', [
        ['关联设备', getNodeDisplayName(gimNode, state.ifcGuidToName, state.currentIfcEntries)],
        ['分类', gimNode.classifyName],
      ])
    : '';

  // 来源：模型与 GUID
  const source = sectionHtml('来源引用', [
    ['IFC 模型', fileReferenceValue('ifc', ifcReferencePath(modelId, state.currentIfcEntries))],
    ['LocalId', String(localId)],
    ...(guid ? ([['GUID', guid]] as Array<[string, string | FileReferenceValue]>) : []),
  ]);

  const title = '<div class="props-header">IFC 构件</div>';
  renderInspectorTabs(title, { overview, params, relations, source });
}
