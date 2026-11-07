/** Pure inspector HTML formatting, without DOM or application state. */
import { escHtml } from '../shared/html.js';
import { isGimEmptyValue } from '../shared/gimParsing.js';
import type { InspectorSummary } from './inspectorService.js';
import { getPropertyDefinition, getPropertyLabel, renderPropertySection, renderTechnicalSection, type FileReferenceValue, type PropertyComponent, type PropertyRow } from './propertyPresentation.js';

export interface InspectorBuckets { overview: string; params: string; relations: string; source: string }
export function inspectorTabsHtml(titleHtml: string, buckets: InspectorBuckets, activeTab = 'overview'): string {
  const selected = (['overview','params','relations','source'] as const).includes(activeTab as keyof InspectorBuckets) ? activeTab : 'overview';
  const tab = (id: keyof InspectorBuckets, label: string) =>
    `<button type="button" data-itab="${id}" class="itab${selected === id ? ' active' : ''}">${label}</button>`;
  const pane = (id: keyof InspectorBuckets) =>
    `<div data-itab-pane="${id}" class="itab-pane${selected === id ? ' active' : ''}">${buckets[id].trim() || '<div class="props-empty">暂无内容</div>'}</div>`;
  return `${titleHtml}<div class="itabs">${tab('overview','概览')}${tab('params','参数')}${tab('relations','关系')}${tab('source','来源')}</div>${pane('overview')}${pane('params')}${pane('relations')}${pane('source')}`;
}


/** 渲染 FAM 分节属性为 HTML */
export function renderFamSections(sections: Map<string, Map<string, string>>, component: PropertyComponent = 'substation-fam'): string {
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


/** 渲染 getItemsData 返回的属性数据为 HTML */
export function renderIfcItemData(data: Record<string, unknown>, depth = 0): string {
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


/** CbmNode → 概览 + 来源 内容（基础字段，不含 IFC 原生属性） */
/**
 * 属性面板设计（research/property-panel-design.md）第一层：关键参数。
 *
 * 业务字段散落在 CBM / FAM / DEV 三类来源中，且大量值带 `-`、`/`、
 * `&其他` 等占位符或重复键前缀。这里统一归一化、按业务优先级取第一个
 * 有效值，最多展示 8 行；原始键值仍在“参数/来源”页签完整保留。
 */
export function renderInspectorSummary(summary: InspectorSummary): string {
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


/** FAM/DEV 导出器常用的空值哨兵不占用首屏；真实负数等正常值不受影响。 */
export function isUsefulPropertyValue(value: unknown): boolean {
  return !isGimEmptyValue(value);
}
