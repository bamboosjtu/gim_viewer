import {projectPresentation} from './projectPresentationPort.js';
import {componentDefinition} from '../engineering/catalogLabels.js';
import {setRenderVisibility} from '../viewer/demandRendering.js';
import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { loadPresentation } from './presentationPort.js';
import type { AppState, EngineeringSelectionScope, SelectionRequest } from '../app/state.js';
import type * as THREE from 'three';
import { getEngineeringRepresentations } from './engineeringRepresentationService.js';
import { devRepresentationHint } from '../viewer/devRepresentationIdentity.js';
import type { SourceRecord } from '../gim/engineering/sourceEvidence.js';
import { engineeringSourceRecord } from './engineeringViewService.js';
import { representationEvidenceState } from '../engineering/representations.js';

function propertyText(value:unknown):string {
  if(value==null)return '—';
  if(Array.isArray(value))return value.map(propertyText).join('；');
  if(typeof value==='object'){
    const item=value as Record<string,unknown>;
    if('value' in item)return propertyText(item.value);
    return Object.entries(item).filter(([key])=>!['expressID','type','GlobalId'].includes(key)).map(([key,v])=>`${key}：${propertyText(v)}`).join('；');
  }
  return String(value);
}
function propertyRows(value:unknown):[string,string][]{
  if(Array.isArray(value))return value.flatMap(item=>propertyRows(item));
  if(value&&typeof value==='object'){
    const item=value as Record<string,unknown>;
    if(item.HasProperties)return propertyRows(item.HasProperties);
    if(item.Name&&'NominalValue' in item)return [[propertyText(item.Name),propertyText(item.NominalValue)]];
    if(item.name&&'value' in item)return [[propertyText(item.name),propertyText(item.value)]];
    return Object.entries(item).filter(([key])=>!['expressID','type','GlobalId','OwnerHistory'].includes(key)).map(([key,v])=>[key,propertyText(v)]);
  }
  return value==null?[]:[['值',propertyText(value)]];
}

interface Context {
  generation: number;
  meshBaseline: Map<THREE.Mesh, boolean>;
  rootBaseline: Map<THREE.Object3D, boolean>;
  refreshing: boolean;
}
const contexts = new WeakMap<AppState, Context>();
const visible = (object: THREE.Object3D) => { for (let p: THREE.Object3D | null = object; p; p = p.parent) if (!p.visible) return false; return true; };
const roots = (state: AppState) => [...new Set([...state.loadedXmlModGroups.values(), ...state.loadedStlGroups.values()])];

export async function clearEngineeringHighlight(state: AppState, request: SelectionRequest): Promise<void> {
  if (!state.initialized || !state.isCurrentSelection(request)) return;
  const [{ getViewerRuntimeWithUI }, { commitSelectionHighlight }] = await Promise.all([import('./viewerUIBinding.js'), import('../viewer/highlight.js')]);
  const guard = state.selectionGuard(request); if (!guard.isCurrent()) return;
  const { ctx } = await getViewerRuntimeWithUI(state, () => {}); if (guard.isCurrent()) await commitSelectionHighlight(ctx, state, guard);
}

function context(state: AppState): Context {
  let value = contexts.get(state);
  if (value?.generation === state.projectGeneration && state.engineeringGeometryFilter) return value;
  state.engineeringSelectionCleanup?.();
  value = { generation: state.projectGeneration, meshBaseline: new Map(), rootBaseline: new Map(), refreshing: false };
  contexts.set(state, value);
  const owned = value;
  state.engineeringSelectionCleanup = () => {
    for (const [mesh, baseline] of owned.meshBaseline) setRenderVisibility(mesh,baseline);
    for (const [root, baseline] of owned.rootBaseline) setRenderVisibility(root,baseline);
    owned.meshBaseline.clear(); owned.rootBaseline.clear();
    if (contexts.get(state) === owned) { contexts.delete(state); state.engineeringGeometryFilter = null; state.engineeringRepresentationChanged = null; state.engineeringSelectionCleanup = null; }
  };
  state.engineeringGeometryFilter = root => applyGeometryFilter(state, root);
  state.engineeringRepresentationChanged = rootOccurrence => {
    const owned = contexts.get(state)!;
    if (state.engineeringSelection && state.engineeringSelection.snapshot !== state.engineering.snapshot && state.selectionRequest) {
      void Promise.resolve(reconcileEngineeringSelection(state, state.selectionRequest)).catch(reportBackgroundError); return;
    }
    if (rootOccurrence && !state.engineeringSelection?.devRoots.has(rootOccurrence)) return;
    applyGeometryFilter(state);
    if (owned.refreshing || !state.engineeringSelection || !state.selectionRequest || !state.initialized) return;
    owned.refreshing = true;
    queueMicrotask(() => {
      owned.refreshing = false;
      const request = state.selectionRequest;
      if (request && state.engineeringSelection?.requestId === request.id) void Promise.resolve(updateEngineeringHighlight(state, request, false)).catch(reportBackgroundError);
    });
  };
  return value;
}

export function applyGeometryFilter(state: AppState, onlyRoot?: THREE.Object3D): void {
  const owned = contexts.get(state); if (!owned) return;
  const selection = state.engineeringSelection;
  const representation = getEngineeringRepresentations(state);
  if (!state.onlySelected) {
    for (const [mesh, baseline] of owned.meshBaseline) setRenderVisibility(mesh,baseline);
    for (const [root, baseline] of owned.rootBaseline) setRenderVisibility(root,baseline);
    owned.meshBaseline.clear(); owned.rootBaseline.clear(); return;
  }
  const current = selection?.snapshot === state.engineering.snapshot && !!representation;
  for (const root of onlyRoot ? [onlyRoot] : roots(state)) {
    const occurrence = root.userData.rootOccurrence;
    if (!state.deviceLodRuntime) {
      if (!owned.rootBaseline.has(root)) owned.rootBaseline.set(root, root.visible);
      setRenderVisibility(root,owned.rootBaseline.get(root)! && !!(current && selection?.devRoots.has(occurrence)),!onlyRoot);
    }
    root.traverse(object => {
      const mesh = object as THREE.Mesh; if (!mesh.isMesh) return;
      if (!owned.meshBaseline.has(mesh)) owned.meshBaseline.set(mesh, mesh.visible);
      setRenderVisibility(mesh,owned.meshBaseline.get(mesh)! && !!(current && selection && representation?.index.includesDev(occurrence, devRepresentationHint(mesh, root), selection.sourceIds)),!onlyRoot);
    });
  }
}

function makeScope(state: AppState, request: SelectionRequest, ownerIds: Set<string>, sourceIds: Set<string>): EngineeringSelectionScope | null {
  const representations = getEngineeringRepresentations(state);
  if (!representations || !state.engineering.snapshot) return null;
  const byGuid = representations.ifcGuidCounts;
  const ifc: EngineeringSelectionScope['ifc'] = [];
  for (const id of sourceIds) {
    const binding = representations.index.bySource.get(id);
    if (binding?.kind === 'ifc' && !binding.nonphysical) ifc.push({ modelId: binding.modelId, expressId: binding.expressId,
      globalId: byGuid.get(JSON.stringify([binding.modelId, binding.globalId])) === 1 ? binding.globalId : '' });
  }
  return { requestId: request.id, snapshot: state.engineering.snapshot, ownerIds, sourceIds,
    devRoots: representations.index.rootsForSources(sourceIds), ifc };
}

export async function updateEngineeringHighlight(state: AppState, request: SelectionRequest, fit = true, whole = false, automatic = false): Promise<void> {
  const baseGuard = state.selectionGuard(request), scope = state.engineeringSelection;
  const guard = { ...baseGuard, isCurrent: () => baseGuard.isCurrent() && state.engineeringSelection === scope && state.engineering.snapshot === scope?.snapshot };
  const representations = getEngineeringRepresentations(state);
  if (!guard.isCurrent() || !scope || scope.requestId !== request.id || scope.snapshot !== state.engineering.snapshot || !representations || !state.initialized) return;
  const [{ getViewerRuntimeWithUI }, graphics, highlight, { frameBox }] = await Promise.all([
    import('./viewerUIBinding.js'), import('three'), import('../viewer/highlight.js'), import('../viewer/camera.js')]);
  if (!guard.isCurrent()) return;
  const { ctx } = await getViewerRuntimeWithUI(state, () => {});
  if (!guard.isCurrent()) return;
  applyGeometryFilter(state);
  const selected: THREE.Object3D[] = [];
  let ambiguousMeshes = 0;
  for (const root of roots(state)) {
    const occurrence = root.userData.rootOccurrence;
    if (!scope.devRoots.has(occurrence)) continue;
    root.traverse(object => {
      const mesh = object as THREE.Mesh; if (!mesh.isMesh || !visible(mesh)) return;
      const hint = devRepresentationHint(mesh, root);
      if (representations.index.includesDev(occurrence, hint, scope.sourceIds)) selected.push(mesh);
      else if (representations.index.resolveDev(occurrence, hint).status === 'ambiguous') ambiguousMeshes++;
    });
  }
  const items: Record<string, number[]> = {}, bounds: THREE.Box3[] = [];
  const byModel = new Map<string, Set<string>>();
  const regionalObjects = new Map([...state.ifcRegionalRuntimes].map(([model, runtime]) => [model, new Map(runtime.index.objects.map(object => [object.expressId, object]))]));
  for (const ref of scope.ifc) {
    if (ref.globalId) { const guids = byModel.get(ref.modelId) ?? new Set(); guids.add(ref.globalId); byModel.set(ref.modelId, guids); }
    const runtime = state.ifcRegionalRuntimes.get(ref.modelId);
    const object = regionalObjects.get(ref.modelId)?.get(ref.expressId);
    const box = object && runtime?.worldBounds(object); if (box) bounds.push(box);
  }
  for (const [model, guids] of byModel) {
    const runtimeId = state.getRuntimeModelId(model), loaded = ctx.fragments.list.get(runtimeId);
    if (!loaded) continue;
    const ids = (await loaded.getLocalIdsByGuids([...guids])).filter((id): id is number => id !== null);
    if (!guard.isCurrent()) return;
    if (ids.length) { items[runtimeId] = ids; if (!state.ifcRegionalRuntimes.has(model)) bounds.push(await loaded.getMergedBox(ids)); }
  }
  let rangeOutlined=false;
  await highlight.commitSelectionHighlight(ctx, state, guard, async () => {
    for (const ref of scope.ifc) {
      const group = state.ifcRegionalRuntimes.get(ref.modelId)?.highlightGroup(ref.expressId, true);
      if (group) selected.push(group);
    }
    highlight.highlightModGroups(state, selected);
    if (Object.keys(items).length) { const { outlineFragmentItems } = await import('../viewer/selectionOutline.js'); await outlineFragmentItems(ctx,state,items,guard); if (guard.isSessionCurrent()) state.highlightedItems = items; }
    if(guard.isCurrent() && request.target?.kind==='engineering-group'){
      const range=new graphics.Box3();bounds.forEach(box=>range.union(box));
      for(const object of selected)if(visible(object))range.expandByObject(object);
      if(!range.isEmpty()){const {outlineSelectionRange}=await import('../viewer/selectionOutline.js');if(guard.isCurrent()){outlineSelectionRange(ctx,state,range);rangeOutlined=true;}}
    }
  });
  if (!guard.isCurrent()) return;
  const available = selected.length + Object.values(items).reduce((sum, ids) => sum + ids.length, 0);
  const missingBindings = [...scope.sourceIds].filter(id => !representations.index.bySource.has(id)).length;
  state.selectionGeometry = { status: ambiguousMeshes || missingBindings || rangeOutlined&&!available ? 'partial' : available ? 'available' : 'not-loaded',
    detail: ambiguousMeshes ? '部分粗表示包含多个整体，范围尚未分离。' : missingBindings ? '部分来源尚未映射到可选表示。' : available ? '按工程整体的来源成员选择可用表示。' : '当前来源尚无可用表示；来源与整体仍可查看。' };
  if(rangeOutlined&&!available)state.selectionGeometry.detail='已标出所选来源的空间范围，构件表示尚在恢复。';
  projectPresentation().geometryFeedback(state.selectionGeometry.detail);
  state.selectionGeometry.evidence=representationEvidenceState(scope.devRoots.size||scope.ifc.length?'physical':'unknown',state.selectionGeometry.status==='available'?'available':state.selectionGeometry.status==='partial'?'partial':'not_requested',representations.index.resolveSources([...scope.sourceIds]));
  if (fit && (!automatic || state.canAutoLocate(request))) {
    const box = new graphics.Box3();
    for (const object of selected) if (visible(object)) box.expandByObject(object);
    bounds.forEach(value => box.union(value));
    if (!whole && request.target?.kind !== 'engineering-group' && !box.isEmpty()) {
      const widths = box.getSize(new graphics.Vector3()).toArray(), sorted = [...widths].sort((a, b) => b - a);
      if (sorted[0] > 30 && sorted[0] > 10 * Math.max(sorted[1], .01)) {
        const axis = widths.indexOf(sorted[0]), centre = box.getCenter(new graphics.Vector3()).getComponent(axis);
        box.min.setComponent(axis, Math.max(box.min.getComponent(axis), centre - 6)); box.max.setComponent(axis, Math.min(box.max.getComponent(axis), centre + 6));
        projectPresentation().geometryFeedback(state.selectionGeometry.detail+' 长构件当前显示中心局部，可定位整件。',true);
      }
    }
    if (!box.isEmpty() && guard.isCurrent()) await frameBox(ctx, box, guard);
  }
}

/** Selects an engineering whole or an explicit source occurrence. Rendering is
 * resolved from membership and source addresses, independently of view nodes.
 */
export async function selectEngineeringTarget(state: AppState, target: { kind: 'engineering' | 'engineering-source' | 'engineering-group'; key: string },
  existing?: SelectionRequest, options: { fit?: boolean; load?: boolean } = {}): Promise<boolean> {
  const snapshot = state.engineering.snapshot, sources = state.engineering.sources;
  const representations = getEngineeringRepresentations(state);
  if (!snapshot || !sources || !representations) return false;
  const entity = snapshot.entities.find(entity => entity.id === target.key), pending = snapshot.pending.find(p => p.id === target.key);
  const single = engineeringSourceRecord(state, target.key);
  const groupNodes=state.engineering.navigation?.inventory?.nodes.has(target.key)?state.engineering.navigation.inventory.nodes:state.engineering.navigation?.composition.nodes;
  const groupNode = target.kind === 'engineering-group' ? groupNodes?.get(target.key) : undefined;
  if (target.kind === 'engineering' ? !entity && !pending : target.kind === 'engineering-source' ? !single : !groupNode || !['group', 'project', 'template'].includes(groupNode.kind)) return false;
  const unbound = !!groupNode && 'unbound' in groupNode && groupNode.unbound === true;
  const declaredUnbound = !!groupNode && 'declaredContextIds' in groupNode
    && !!groupNode.declaredContextIds?.length && groupNode.entityCount === 0;
  if (groupNode?.kind === 'group' && (unbound || declaredUnbound)) {
    // Keep the empty declaration inspectable; it has no geometry scope, so the
    // normal empty-group path must not create isolation or a fake highlight.
    state.selectionMessage = '该分组来自来源声明，尚未绑定工程整体，暂不可选择空间范围。';
  }
  const request = existing ?? state.beginSelection(target), baseGuard = state.selectionGuard(request);
  const guard = { ...baseGuard, isCurrent: () => baseGuard.isCurrent() && state.engineering.snapshot === snapshot };
  if (!guard.isCurrent()) return true;
  request.target = target;
  const ownerIds = new Set(target.kind === 'engineering' ? [target.key] : []);
  if (groupNode) {
    const nodes = groupNodes!, stack = [groupNode];
    while (stack.length) { const node = stack.pop()!; if (node.targetId) ownerIds.add(node.targetId); for (const key of node.children) stack.push(nodes.get(key)!); }
  }
  const sourceIds = single && target.kind === 'engineering-source' ? new Set([single.id]) : representations.index.sourcesForOwners(ownerIds);
  const scope = makeScope(state, request, ownerIds, sourceIds); if (!scope) return false;
  state.engineeringSelection = scope;
  state.representationSelection = {
    requestId: request.id, devRoots: scope.devRoots, ifc: scope.ifc,
    isCurrent: () => state.isCurrentSelection(request) && state.engineeringSelection === scope && state.engineering.snapshot === snapshot,
  };
  context(state);
  // A declaration without members has no isolation range. Leave a previous
  // isolation before inspecting it, so the whole scene does not disappear.
  if (groupNode && !sourceIds.size && state.onlySelected) state.setOnlySelected(false);
  const tree = await loadPresentation('engineeringTreeView');
  if (!guard.isCurrent()) return true;
  if (target.kind === 'engineering-source') tree.revealEngineeringSource(state, target.key);
  else tree.syncEngineeringTreeSelection(state);
  state.deviceLodRuntime?.setOnlySelected?.(state.onlySelected); applyGeometryFilter(state);
  const selectedSources: SourceRecord[] = [...sourceIds].flatMap(id => { const source = engineeringSourceRecord(state, id); return source ? [source] : []; });
  const declaredContexts = groupNode && 'declaredContextIds' in groupNode ? groupNode.declaredContextIds : undefined;
  const { renderEngineeringInspector } = await loadPresentation('engineeringInspector');
  if (!guard.isCurrent()) return true;
  renderEngineeringInspector({ title: groupNode?.title || entity?.name || single?.name || (pending?'待归属对象':'未命名对象'), entity, pending, sources: selectedSources,
    parts:entity?[...new Set(snapshot.memberships.filter(m=>m.ownerId===entity.id&&['part','neutral_set'].includes(m.interpretation.meaning)).map(m=>componentDefinition(m.interpretation)?.label??m.interpretation.standardClass?.label??(selectedSources.find(s=>s.id===m.sourceId)?.name||'未命名部件')))]:undefined,
    group: groupNode ? { entityCount: groupNode.entityCount, pendingCount: ownerIds.size - groupNode.entityCount,
      declarations: [...new Set((declaredContexts ?? []).flatMap((id:string) => {
        const document = representations.contextDocuments.get(id); return document ? [document] : [];
      }))].map(document => ({ title: groupNode.title, document })) } : undefined,
    partial: !sources.complete, geometryNote: '可定位或单独显示当前对象。',
    relationships: snapshot.relationships.filter(r => ownerIds.has(r.from) || ownerIds.has(r.to)),
    relatedNames: new Map(snapshot.entities.map(entity => [entity.id, entity.name])),
    onFit: () => { if (guard.isCurrent()) void Promise.resolve(updateEngineeringHighlight(state, request, true, true)).catch(reportBackgroundError); },
    onIsolate: () => { if (guard.isCurrent()) state.setOnlySelected(true); },
    onRestore: () => { if (guard.isCurrent()) state.setOnlySelected(false); },
    onSource: sourceId => { if (guard.isCurrent()) void Promise.resolve(selectEngineeringTarget(state, { kind: 'engineering-source', key: sourceId })).catch(reportBackgroundError); },
    onOwner: single && representations.index.ownerBySource.get(single.id) ? () => {
      if (!guard.isCurrent()) return;
      state.viewState.mode = state.viewState.mode==='inventory'?'inventory':'composition'; tree.renderEngineeringTree(state);
      void Promise.resolve(selectEngineeringTarget(state, { kind: 'engineering', key: representations.index.ownerBySource.get(single.id)! })).catch(reportBackgroundError);
    } : undefined,
    onDocument: path => {
      if (!guard.isCurrent()) return;
      void import('./engineeringSourceInspector.js').then(async ({inspectEngineeringDocument}) => {
        if (guard.isCurrent()) await inspectEngineeringDocument(state,path);
      }).catch(reportBackgroundError);
    },
    onRefine: scope.devRoots.size || scope.ifc.length ? progress => refineEngineeringRange(state, request, scope, progress) : undefined,
    onReleaseFine: () => {
      if (!guard.isCurrent() || state.engineeringSelection !== scope) return;
      for (const root of scope.devRoots) state.deviceLodRuntime?.releaseFine?.(root);
      for (const ref of scope.ifc) state.ifcRegionalRuntimes.get(ref.modelId)?.releaseFine(ref.expressId);
    },
    onDetails: single?.ifcOccurrence ? async () => {
      if (!guard.isCurrent()) throw new DOMException('选择已变化', 'AbortError');
      const ref = single.ifcOccurrence!, runtime = state.ifcRegionalRuntimes.get(ref.modelId);
      if (!runtime) throw Error('该来源的模型尚未准备好，请在加载后重试');
      const properties = await runtime.properties(ref.expressId);
      if (!guard.isCurrent()) throw new DOMException('选择已变化', 'AbortError');
      return {sections:[{title:'基本属性',rows:propertyRows(properties.attributes)},{title:'属性集',rows:propertyRows(properties.propertySets)},{title:'类型属性',rows:propertyRows(properties.typeProperties)},{title:'材料',rows:propertyRows(properties.materials)}]};
    } : single?.track==='dev' ? async(cursor)=>{
      if(!guard.isCurrent())throw new DOMException('选择已变化','AbortError');
      const {ensureEngineeringEvidence,queryEngineeringEvidence}=await import('./engineeringService.js');
      if(!guard.isCurrent())throw new DOMException('选择已变化','AbortError');
      const entryIds=[...new Set(single.properties.map(p=>p.path).filter((p):p is string=>!!p&&/\.fam$/i.test(p)))];
      const range={entryIds,kinds:['attributes','assignments'] as const};
      const revision=cursor?.revision??(await ensureEngineeringEvidence(state,range)).revision;
      if(!guard.isCurrent())throw new DOMException('选择已变化','AbortError');
      const page=await queryEngineeringEvidence(state,{range,revision,offset:cursor?.offset,limit:200});
      if(!guard.isCurrent())throw new DOMException('选择已变化','AbortError');
      const labels=new Map(page.attributes.map(attribute=>[attribute.id,attribute.rawKey]));
      const sourceName=(id:string)=>engineeringSourceRecord(state,id)?.name||'未命名对象';
      const assignments=page.assignments.map(assignment=>[
        labels.get(assignment.attributeId)??'来源属性',
        assignment.status==='confirmed'?`已关联：${assignment.sourceId?sourceName(assignment.sourceId):'来源实例'}`
          :assignment.status==='ambiguous'?`适用对象待确认：${assignment.candidateSourceIds.map(sourceName).join('、')}`:'尚未确定适用对象',
      ] as [string,string]);
      return {incomplete:page.coverage.some(row=>row.materialization!=='materialized'||row.status!=='complete'),next:page.nextOffset===undefined?undefined:{revision:page.revision,offset:page.nextOffset},sections:[{title:'详细属性',rows:page.attributes.map(attribute=>[attribute.rawKey,attribute.rawValue] as [string,string])},{title:'属性适用对象',rows:assignments}]};
    } : undefined,
  });
  if (!state.initialized) return true;
  await updateEngineeringHighlight(state, request, false);
  if (options.load !== false) {
    // A whole/building can own hundreds of DEV occurrences. Loading them
    // serially made the first coarse highlight wait for every root; keep a
    // small bounded pool so the browser can paint the already-available range.
    const roots = [...scope.devRoots];
    for (let offset = 0; offset < roots.length; offset += 4) {
      if (!guard.isCurrent()) break;
      await Promise.all(roots.slice(offset, offset + 4).map(async root => {
        try { await state.deviceLodRuntime?.ensureBase?.(root); }
        catch (error) { if (guard.isCurrent()) state.selectionMessage = `部分来源表示未能准备：${String(error)}`; }
      }));
    }
  }
  if (guard.isCurrent()) await updateEngineeringHighlight(state, request, options.fit ?? state.canAutoLocate(request), false, options.fit === undefined);
  return true;
}

async function refineEngineeringRange(state: AppState, request: SelectionRequest, scope: EngineeringSelectionScope, progress: (message: string) => void): Promise<void> {
  const current = () => state.isCurrentSelection(request) && state.engineeringSelection === scope && state.engineering.snapshot === scope.snapshot;
  let count = 0; const total = scope.devRoots.size + scope.ifc.length;
  const indexed = new Map([...state.ifcRegionalRuntimes].map(([id, runtime]) => [id, new Map(runtime.index.objects.map(object => [object.expressId, object]))]));
  for (const root of scope.devRoots) {
    if (!current()) return;
    if (!state.deviceLodRuntime?.refine) throw Error('设备表示尚未准备好，请在加载后重试');
    progress(`正在准备精细模型 ${count + 1}/${total}`); await state.deviceLodRuntime.refine(root); count++;
  }
  for (const ref of scope.ifc) {
    if (!current()) return;
    const runtime = state.ifcRegionalRuntimes.get(ref.modelId), object = indexed.get(ref.modelId)?.get(ref.expressId);
    if (!runtime || !object) throw Error('部分 IFC 表示尚未准备好，请在加载后重试');
    progress(`正在准备精细模型 ${count + 1}/${total}`); await runtime.refine(object); count++;
  }
  if (current()) { await updateEngineeringHighlight(state, request, false); if (current()) progress(`精细模型已准备 ${count}/${total}`); }
}

/** Rebind by logical identity/source evidence when DEV-only facts are enriched
 * with IFC or rules split/merge wholes. Never submit an old member set against
 * a new snapshot; ambiguous changes require an explicit choice.
 */
export async function reconcileEngineeringSelection(state: AppState, request: SelectionRequest): Promise<void> {
  const previous = state.engineeringSelection, snapshot = state.engineering.snapshot, target = request.target;
  if (!state.isCurrentSelection(request) || !previous || !snapshot || previous.snapshot === snapshot || !target) return;
  const ownerIds = new Set([...snapshot.entities, ...snapshot.pending].map(entity => entity.id));
  const validTarget = target.kind === 'engineering' ? ownerIds.has(target.key)
    : target.kind === 'engineering-source' ? snapshot.memberships.some(member => member.sourceId === target.key)
      : target.kind === 'engineering-group' && (state.engineering.navigation?.composition.nodes.has(target.key) || state.engineering.navigation?.inventory?.nodes.has(target.key));
  if (validTarget && (target.kind === 'engineering' || target.kind === 'engineering-source' || target.kind === 'engineering-group')) {
    await selectEngineeringTarget(state, { kind: target.kind, key: target.key }, request, { fit: false, load: false }); return;
  }
  const memberships = new Map(snapshot.memberships.map(member => [member.sourceId, member.ownerId]));
  const candidates = new Set<string>(); let complete = true;
  for (const source of previous.sourceIds) { const owner = memberships.get(source); if (owner) candidates.add(owner); else complete = false; }
  if (target.kind === 'engineering' && complete && candidates.size === 1) {
    await selectEngineeringTarget(state, { kind: 'engineering', key: [...candidates][0] }, request, { fit: false, load: false }); return;
  }
  state.engineeringSelection = null; state.representationSelection = null; applyGeometryFilter(state); state.deviceLodRuntime?.clearSelection();
  const baseGuard = state.selectionGuard(request), guard = { ...baseGuard, isCurrent: () => baseGuard.isCurrent() && state.engineering.snapshot === snapshot };
  if (state.initialized) {
    const [{ getViewerRuntimeWithUI }, { commitSelectionHighlight }] = await Promise.all([import('./viewerUIBinding.js'), import('../viewer/highlight.js')]);
    if (!guard.isCurrent()) return;
    const { ctx } = await getViewerRuntimeWithUI(state, () => {}); if (!guard.isCurrent()) return;
    await commitSelectionHighlight(ctx, state, guard);
  }
  if (!guard.isCurrent()) return;
  state.setOnlySelected(state.onlySelected);
  state.selectionGeometry = { status: 'not-loaded', detail: '来源更新后，原选择的整体边界需要重新确认。' };
  const names = new Map(snapshot.entities.map(entity => [entity.id, entity.name]));
  await projectPresentation().chooseEngineeringRange(state.selectionGeometry.detail,[...candidates].map(id=>({
    label:names.get(id)??'待归整体集合',
    choose:()=>{if(guard.isCurrent())void selectEngineeringTarget(state,{kind:'engineering',key:id}).catch(reportBackgroundError);},
  })),guard.isCurrent);
}
