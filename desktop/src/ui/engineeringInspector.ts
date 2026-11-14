import { openPropsDrawerUI, renderInspectorTabs, sectionHtml } from './propsDrawer.js';
import { escHtml } from '../shared/html.js';
import type { EngineeringEntity, PendingWhole, EntityRelationship } from '../engineering/types.js';
import type { SourceRecord } from '../gim/engineering/sourceEvidence.js';
import { categoryLabel,classificationReasonLabel } from '../engineering/catalogLabels.js';

export interface EngineeringDetailsCursor {revision:number;offset:number}
export interface EngineeringDetailsPage {values:Record<string,unknown>;next?:EngineeringDetailsCursor;incomplete?:boolean}

export interface EngineeringInspectorInput {
  evidenceSummary?:readonly [string,string][];
  title: string;
  entity?: EngineeringEntity;
  pending?: PendingWhole;
  group?: { entityCount: number; pendingCount: number; confirmedCount?:number; attachmentCount?:number; declarations?: Array<{ title: string; document: string }> };
  sources: readonly SourceRecord[];
  relationships: readonly EntityRelationship[];
  relatedNames: ReadonlyMap<string, string>;
  partial: boolean;
  geometryNote: string;
  projectionInferred?: boolean;
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
  const rows: [string, string][] = [
    ...input.evidenceSummary??[],
    ['浏览对象', entity ? '工程整体' : pending ? '待归整体集合' : input.group ? '工程分组范围' : '来源范围'],
    ...(input.group ? [['整体候选', String(input.group.entityCount)], ['待归集合', String(input.group.pendingCount)]] as [string, string][] : []),
    ...(input.group?.confirmedCount!==undefined?[['分类与边界均确认',String(input.group.confirmedCount)]] as [string,string][]:[]),
    ...(input.group?.attachmentCount?[['中性点成套附件',String(input.group.attachmentCount)],['附件口径','作为主变组成，不增加独立设备台数；具体宿主按来源证据确认']] as [string,string][]:[]),
    ...(unassignedDeclaration ? [['工程归属', '来源已声明此工程单元，尚无可靠的整体归属']] as [string, string][] : []),
    ...(entity ? [['类别', categoryLabel(entity.category)], ['类别识别', entity.classificationState === 'unknown' ? '待识别' : '已识别'],
      ['子类',entity.subtypeLabel??'无独立子类'],['分类证据状态',entity.classificationStatus==='confirmed'?'已确认':entity.classificationStatus==='candidate'?'候选':'未确认'],
      ['整体边界状态',entity.boundaryStatus==='confirmed'?'已确认':'待确认'],
      ...(entity.classificationConflicts?[['分类冲突来源数',String(entity.classificationConflicts)]]:[]),
      ...(entity.unknownReason?[['待确认说明',classificationReasonLabel(entity.unknownReason)]]:[]),
      ['整体依据', ({ object_identity: '对象本身的工程含义', independent_function_identity: '具有独立功能的对象',
        independent_installation_object: '独立安装的对象', 'engineering_code+designation+assembly_signature': '工程编码、编号名称和成套组成相互支持',
        'explicit_main_designation+single_phase_bodies': '明确主变编号及多个单相本体', outward_object_boundary_unconfirmed: '外露对象，整体边界尚待确认',
        object_identity_parent_boundary_unknown: '对象可识别，上级整体边界未知' } as Record<string, string>)[entity.boundaryEvidence] ?? '按来源对象和组成证据识别'],
      ['组成状态', entity.compositionState ? '按交付声明归组，实物组成完整性尚未核对' : '按现有交付表达']] as [string, string][] : []),
    ...(pending ? [['待确认原因', ({ component_host_conflict:'原始来源宿主与属性宿主声明冲突',component_host_ambiguous:'宿主声明存在多个候选或部分尚未解析',component_host_not_found:'尚未找到声明的宿主',neutral_set_main_unresolved: '尚不能确定中性点装置对应的主变', component_whole_unresolved: '内部组成尚无明确整体宿主',
      unnumbered_set_identity_requires_confirmation: '缺少明确编号，不能确认属于同一套装置', peer_fragment_engineering_identity_insufficient: '分散组成缺少足够的整体身份依据',
      object_attributes_conflict:'当前对象的有效类别属性相互矛盾',assembly_identity_conflict:'成套工程身份或装配证据发生冲突',transformer_bank_identity_conflict:'主变编号、相别或本体数证据存在冲突' } as Record<string, string>)[pending.reason] ?? '整体身份或归属依据不足']] as [string, string][] : []),
    ['来源记录', String(sources.length)], ['来源状态', input.partial ? '部分来源尚未完成' : '当前来源已就绪'],
    ...(input.projectionInferred ? [['投影归属', '空间推断，工程归属待确认']] as [string,string][] : []),
  ];
  const params: [string, string][] = single
    ? single.properties.map(p => [[...(p.keys ?? []), ...(p.key ? [p.key] : [])].join(' / '), p.value])
    : entity?.phaseBodyCount ? [['单相本体数', String(entity.phaseBodyCount)], ['说明', '本体数不等于主变组数；相别完整性另行核对']] : [['详细参数', '按来源记录查看；内部组成的参数不自动汇总成整体参数']];
  renderInspectorTabs(`<div class="props-header">${escHtml(input.title)}</div>`, {
    overview: sectionHtml('工程对象', rows) + `<p class="props-note" data-engineering-geometry-note>${escHtml(unassignedDeclaration ? '此工程单元尚无已确认的整体范围，可在来源中查看声明。' : input.geometryNote)}</p>` + '<div class="props-actions"><button class="prop-ref-link" id="engineering-fit">定位</button><button class="prop-ref-link" id="engineering-isolate">仅显示此范围</button><button class="prop-ref-link" id="engineering-restore">恢复显示</button></div>' + (input.onOwner ? '<button class="prop-ref-link" id="engineering-owner">查看所属整体</button>' : '') +
      (input.onRefine ? '<div class="props-actions"><button class="prop-ref-link" id="engineering-refine">查看精细模型</button><button class="prop-ref-link" id="engineering-release-fine">返回浏览表示</button></div><p class="props-note" id="engineering-refine-status"></p>' : ''),
    params: sectionHtml(single ? '来源属性' : '整体参数', params) + (input.onDetails ? '<button class="prop-ref-link" id="engineering-details">读取详细来源属性</button><div id="engineering-details-result"></div>' : ''),
    relations: sectionHtml('整体关系', input.relationships.length ? input.relationships.map(r => ['关联整体', `${input.relatedNames.get(r.from) ?? '待归整体集合'} → ${input.relatedNames.get(r.to) ?? '待归整体集合'}`]) : [['关系', '当前没有已建立的独立整体关系']]),
    source: sectionHtml('来源概要', single ? [['类型', single.source_type], ['文件', single.source], ['来源身份', single.id]] : [['成员', `${sources.length} 个来源记录`]]) +
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
      detailHost.insertAdjacentHTML('beforeend',Object.entries(page.values).map(([name, value]) => sectionHtml(name, value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value).map(([key, item]) => [key, typeof item === 'object' ? JSON.stringify(item) : String(item)]) : [['原始值', JSON.stringify(value) ?? '']], true)).join(''));
      cursor=page.next;
      details.textContent=cursor?'尚未完整显示，继续加载（每页最多 200 条属性/赋值记录）':page.incomplete?'当前已物化记录已显示；来源覆盖仍有未完成项':'详细来源属性已全部显示';
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
