import { openPropsDrawerUI, renderInspectorTabs, sectionHtml } from './propsDrawer.js';
import { escHtml } from '../shared/html.js';
import type { EngineeringEntity, PendingWhole, EntityRelationship } from '../engineering/types.js';
import type { SourceRecord } from '../gim/engineering/sourceEvidence.js';
import { catalogPathLabel } from '../engineering/catalogLabels.js';

export interface EngineeringDetailsCursor {revision:number;offset:number}
export interface EngineeringDetailsPage {sections:readonly {title:string;rows:readonly [string,string][]}[];next?:EngineeringDetailsCursor;incomplete?:boolean}

export interface EngineeringInspectorInput {
  parts?:readonly string[];
  title: string;
  entity?: EngineeringEntity;
  pending?: PendingWhole;
  group?: { entityCount: number; pendingCount: number; declarations?: Array<{ title: string; document: string }> };
  sources: readonly SourceRecord[];
  relationships: readonly EntityRelationship[];
  relatedNames: ReadonlyMap<string, string>;
  partial: boolean;
  geometryNote: string;
  onFit(): void;
  onIsolate(): void;
  onRestore(): void;
  onSource(sourceId: string): void;
  onOwner?: () => void;
  onDocument?: (path: string) => void;
  onRefine?: (progress: (message: string) => void) => Promise<void>;
  onReleaseFine?: () => void;
  onDetails?: (cursor?:EngineeringDetailsCursor) => Promise<EngineeringDetailsPage>;
}

/** Whole summaries do not flatten component parameters or replace the entity
 * with whichever CBM/IFC record happens to appear first.
 */
export function renderEngineeringInspector(input: EngineeringInspectorInput): void {
  openPropsDrawerUI();
  const { entity, pending, sources } = input;
  const single = !entity && !pending && !input.group && sources.length === 1 ? sources[0] : undefined;
  const unassignedDeclaration = !!input.group?.declarations?.length && input.group.entityCount === 0 && input.group.pendingCount === 0;
  const rows:[string,string][]=[
    ...(entity?[['名称',entity.name],['分类',catalogPathLabel(entity)]] as [string,string][]:[]),
    ...(pending?[['状态','所属对象待确认']] as [string,string][]:[]),
    ...(input.group?[['对象数量',String(input.group.entityCount)],['待确认对象',String(input.group.pendingCount)]] as [string,string][]:[]),
    ...(input.partial?[['加载状态','部分数据尚未加载完成']] as [string,string][]:[]),
  ];
  const parts=entity?'<div class="props-section"><h3>部件</h3>'+(input.parts?.length?'<ul>'+input.parts.map(name=>`<li>${escHtml(name)}</li>`).join('')+'</ul>':'<p class="props-note">未提供部件信息</p>')+'</div>':'';
  const params: [string, string][] = single
    ? single.properties.map(p => [[...(p.keys ?? []), ...(p.key ? [p.key] : [])].join(' / '), p.value])
    : entity?.phaseBodyCount ? [['单相本体数', String(entity.phaseBodyCount)]] : [['属性', '选择具体对象或部件查看属性']];
  renderInspectorTabs(`<div class="props-header">${escHtml(input.title)}</div>`, {
    overview: sectionHtml('对象信息', rows) +parts+ `<p class="props-note" data-engineering-geometry-note>${escHtml(unassignedDeclaration ? '当前分组暂无可用对象。' : input.geometryNote)}</p>` + '<div class="props-actions"><button class="prop-ref-link" id="engineering-fit">定位</button><button class="prop-ref-link" id="engineering-isolate">仅显示此范围</button><button class="prop-ref-link" id="engineering-restore">恢复显示</button></div>' + (input.onOwner ? '<button class="prop-ref-link" id="engineering-owner">查看所属对象</button>' : '') +
      (input.onRefine ? '<div class="props-actions"><button class="prop-ref-link" id="engineering-refine">查看精细模型</button><button class="prop-ref-link" id="engineering-release-fine">返回浏览表示</button></div><p class="props-note" id="engineering-refine-status"></p>' : ''),
    params: sectionHtml(single ? '来源属性' : '属性', params) + (input.onDetails ? '<button class="prop-ref-link" id="engineering-details">读取详细来源属性</button><div id="engineering-details-result"></div>' : ''),
    relations: sectionHtml('整体关系', input.relationships.length ? input.relationships.map(r => ['关联整体', `${input.relatedNames.get(r.from) ?? '待归整体集合'} → ${input.relatedNames.get(r.to) ?? '待归整体集合'}`]) : [['关系', '当前没有已建立的独立整体关系']]),
    source: sectionHtml('来源概要', single ? [['类型', single.source_type], ['文件', single.source], ['来源名称',single.name]] : [['成员', `${sources.length} 个来源记录`]]) +
      (input.group?.declarations?.length ? '<div class="engineering-source-links">' + input.group.declarations.slice(0,100).map((item,index)=>`<button type="button" class="prop-ref-link" data-engineering-declaration-index="${index}">查看 ${escHtml(item.title)} 的来源声明</button>`).join('') + '</div>' : '') +
      (single && input.onDocument ? '<button class="prop-ref-link" id="engineering-document">查看来源文件</button>' : '') +
      `<div class="engineering-source-links">${sources.slice(0, 100).map((s, i) => `<button type="button" class="prop-ref-link" data-engineering-source-index="${i}">${escHtml(s.name || s.source)}</button>`).join('')}</div>` +
      (sources.length > 100 ? '<p class="props-note">更多来源可在来源视图中查看。</p>' : ''),
  });
  document.getElementById('engineering-fit')?.addEventListener('click', input.onFit);
  if (input.group && !sources.length) for (const id of ['engineering-fit', 'engineering-isolate']) (document.getElementById(id) as HTMLButtonElement | null)?.setAttribute('disabled', '');
  document.getElementById('engineering-isolate')?.addEventListener('click', input.onIsolate);
  document.getElementById('engineering-restore')?.addEventListener('click', input.onRestore);
  if (input.onOwner) document.getElementById('engineering-owner')?.addEventListener('click', input.onOwner);
  if (single) document.getElementById('engineering-document')?.addEventListener('click', () => input.onDocument?.(single.sources[0] || single.source));
  document.querySelectorAll<HTMLElement>('[data-engineering-declaration-index]').forEach(button=>button.addEventListener('click',()=>{
    const item=input.group?.declarations?.[Number(button.dataset.engineeringDeclarationIndex)]; if(item)input.onDocument?.(item.document);
  }));
  let action = 0;
  const refine = document.getElementById('engineering-refine') as HTMLButtonElement | null;
  const status = document.getElementById('engineering-refine-status');
  refine?.addEventListener('click', async () => {
    const owned = ++action; refine.disabled = true;
    try { await input.onRefine?.(message => { if (owned === action && status) status.textContent = message; }); }
    catch (error) { if (owned === action && status) status.textContent = `精细模型未能完成：${String(error)}`; }
    finally { if (owned === action) refine.disabled = false; }
  });
  document.getElementById('engineering-release-fine')?.addEventListener('click', () => {
    action++; input.onReleaseFine?.(); if (refine) refine.disabled = false; if (status) status.textContent = '已返回浏览表示';
  });
  const details = document.getElementById('engineering-details') as HTMLButtonElement | null, detailHost = document.getElementById('engineering-details-result');
  let cursor:EngineeringDetailsCursor|undefined;
  details?.addEventListener('click', async () => {
    details.disabled = true;
    if (detailHost && !cursor) detailHost.textContent = '正在读取来源属性…';
    try {
      const page = await input.onDetails?.(cursor);
      if (!detailHost?.isConnected || !page) return;
      if (!cursor) detailHost.replaceChildren();
      detailHost.insertAdjacentHTML('beforeend',page.sections.map(section=>sectionHtml(section.title,section.rows.map(row=>[...row] as [string,string]),true)).join(''));
      cursor=page.next;
      details.textContent=cursor?'加载更多属性':page.incomplete?'已显示可用属性，部分属性尚未加载':'详细属性已全部显示';
      details.disabled=!cursor;
    } catch (error) {
      if(detailHost?.isConnected)detailHost.insertAdjacentHTML('beforeend',`<p class="props-note">${escHtml(`来源属性未能读取：${String(error)}；可重新读取。`)}</p>`);
      cursor=undefined;details.textContent='重新读取详细来源属性';details.disabled=false;
    }
  });
  document.querySelectorAll<HTMLElement>('[data-engineering-source-index]').forEach(button => button.addEventListener('click', () => {
    const source = sources[Number(button.dataset.engineeringSourceIndex)]; if (source) input.onSource(source.id);
  }));
}
