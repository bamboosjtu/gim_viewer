import type { AppState, EngineeringSelectionScope, SelectionRequest } from '../app/state.js';
import type * as THREE from 'three';
import { getEngineeringRepresentations } from './engineeringRepresentationService.js';
import { devRepresentationHint } from '../viewer/devRepresentationIdentity.js';
import type { SourceRecord } from '../gim/engineering/sourceEvidence.js';
import { engineeringSourceRecord } from './engineeringViewService.js';

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
    for (const [mesh, baseline] of owned.meshBaseline) mesh.visible = baseline;
    for (const [root, baseline] of owned.rootBaseline) root.visible = baseline;
    owned.meshBaseline.clear(); owned.rootBaseline.clear();
    if (contexts.get(state) === owned) { contexts.delete(state); state.engineeringGeometryFilter = null; state.engineeringRepresentationChanged = null; state.engineeringSelectionCleanup = null; }
  };
  state.engineeringGeometryFilter = root => applyGeometryFilter(state, root);
  state.engineeringRepresentationChanged = rootOccurrence => {
    const owned = contexts.get(state)!;
    if (state.engineeringSelection && state.engineeringSelection.snapshot !== state.engineeringSnapshot && state.selectionRequest) {
      void reconcileEngineeringSelection(state, state.selectionRequest); return;
    }
    if (rootOccurrence && !state.engineeringSelection?.devRoots.has(rootOccurrence)) return;
    applyGeometryFilter(state);
    if (owned.refreshing || !state.engineeringSelection || !state.selectionRequest || !state.initialized) return;
    owned.refreshing = true;
    queueMicrotask(() => {
      owned.refreshing = false;
      const request = state.selectionRequest;
      if (request && state.engineeringSelection?.requestId === request.id) void updateEngineeringHighlight(state, request, false);
    });
  };
  return value;
}

export function applyGeometryFilter(state: AppState, onlyRoot?: THREE.Object3D): void {
  const owned = contexts.get(state); if (!owned) return;
  const selection = state.engineeringSelection;
  const representation = getEngineeringRepresentations(state);
  if (!state.onlySelected) {
    for (const [mesh, baseline] of owned.meshBaseline) mesh.visible = baseline;
    for (const [root, baseline] of owned.rootBaseline) root.visible = baseline;
    owned.meshBaseline.clear(); owned.rootBaseline.clear(); return;
  }
  const current = selection?.snapshot === state.engineeringSnapshot && !!representation;
  for (const root of onlyRoot ? [onlyRoot] : roots(state)) {
    const occurrence = root.userData.rootOccurrence;
    if (!state.deviceLodRuntime) {
      if (!owned.rootBaseline.has(root)) owned.rootBaseline.set(root, root.visible);
      root.visible = owned.rootBaseline.get(root)! && !!(current && selection?.devRoots.has(occurrence));
    }
    root.traverse(object => {
      const mesh = object as THREE.Mesh; if (!mesh.isMesh) return;
      if (!owned.meshBaseline.has(mesh)) owned.meshBaseline.set(mesh, mesh.visible);
      mesh.visible = owned.meshBaseline.get(mesh)! && !!(current && selection && representation?.index.includesDev(occurrence, devRepresentationHint(mesh, root), selection.sourceIds));
    });
  }
}

function makeScope(state: AppState, request: SelectionRequest, ownerIds: Set<string>, sourceIds: Set<string>): EngineeringSelectionScope | null {
  const representations = getEngineeringRepresentations(state);
  if (!representations || !state.engineeringSnapshot) return null;
  const byGuid = representations.ifcGuidCounts;
  const ifc: EngineeringSelectionScope['ifc'] = [];
  for (const id of sourceIds) {
    const binding = representations.index.bySource.get(id);
    if (binding?.kind === 'ifc' && !binding.nonphysical) ifc.push({ modelId: binding.modelId, expressId: binding.expressId,
      globalId: byGuid.get(JSON.stringify([binding.modelId, binding.globalId])) === 1 ? binding.globalId : '' });
  }
  return { requestId: request.id, snapshot: state.engineeringSnapshot, ownerIds, sourceIds,
    devRoots: representations.index.rootsForSources(sourceIds), ifc };
}

export async function updateEngineeringHighlight(state: AppState, request: SelectionRequest, fit = true, whole = false, automatic = false): Promise<void> {
  const baseGuard = state.selectionGuard(request), scope = state.engineeringSelection;
  const guard = { ...baseGuard, isCurrent: () => baseGuard.isCurrent() && state.engineeringSelection === scope && state.engineeringSnapshot === scope?.snapshot };
  const representations = getEngineeringRepresentations(state);
  if (!guard.isCurrent() || !scope || scope.requestId !== request.id || scope.snapshot !== state.engineeringSnapshot || !representations || !state.initialized) return;
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
  await highlight.commitSelectionHighlight(ctx, state, guard, async () => {
    for (const ref of scope.ifc) {
      const group = state.ifcRegionalRuntimes.get(ref.modelId)?.highlightGroup(ref.expressId, true);
      if (group) selected.push(group);
    }
    highlight.highlightModGroups(state, selected);
    if (Object.keys(items).length) { const { outlineFragmentItems } = await import('../viewer/selectionOutline.js'); await outlineFragmentItems(ctx,state,items,guard); if (guard.isSessionCurrent()) state.highlightedItems = items; }
  });
  if (!guard.isCurrent()) return;
  const available = selected.length + Object.values(items).reduce((sum, ids) => sum + ids.length, 0);
  const missingBindings = [...scope.sourceIds].filter(id => !representations.index.bySource.has(id)).length;
  state.selectionGeometry = { status: ambiguousMeshes || missingBindings ? 'partial' : available ? 'available' : 'not-loaded',
    detail: ambiguousMeshes ? '部分粗表示包含多个整体，范围尚未分离。' : missingBindings ? '部分来源尚未映射到可选表示。' : available ? '按工程整体的来源成员选择可用表示。' : '当前来源尚无可用表示；来源与整体仍可查看。' };
  const note = document.querySelector<HTMLElement>('[data-engineering-geometry-note]'); if (note) note.textContent = state.selectionGeometry.detail;
  if (fit && (!automatic || state.canAutoLocate(request))) {
    const box = new graphics.Box3();
    for (const object of selected) if (visible(object)) box.expandByObject(object);
    bounds.forEach(value => box.union(value));
    if (!whole && request.target?.kind !== 'engineering-group' && !box.isEmpty()) {
      const widths = box.getSize(new graphics.Vector3()).toArray(), sorted = [...widths].sort((a, b) => b - a);
      if (sorted[0] > 30 && sorted[0] > 10 * Math.max(sorted[1], .01)) {
        const axis = widths.indexOf(sorted[0]), centre = box.getCenter(new graphics.Vector3()).getComponent(axis);
        box.min.setComponent(axis, Math.max(box.min.getComponent(axis), centre - 6)); box.max.setComponent(axis, Math.min(box.max.getComponent(axis), centre + 6));
        const button = document.getElementById('engineering-fit'); if (button) button.textContent = '定位整件';
        if (note) note.textContent += ' 长构件当前显示中心局部，可定位整件。';
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
  const snapshot = state.engineeringSnapshot, sources = state.engineeringSources;
  const representations = getEngineeringRepresentations(state);
  if (!snapshot || !sources || !representations) return false;
  const entity = snapshot.entities.find(entity => entity.id === target.key), pending = snapshot.pending.find(p => p.id === target.key);
  const single = engineeringSourceRecord(state, target.key);
  const groupNodes=state.engineeringNavigation?.inventory?.nodes.has(target.key)?state.engineeringNavigation.inventory.nodes:state.engineeringNavigation?.composition.nodes;
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
  const guard = { ...baseGuard, isCurrent: () => baseGuard.isCurrent() && state.engineeringSnapshot === snapshot };
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
    isCurrent: () => state.isCurrentSelection(request) && state.engineeringSelection === scope && state.engineeringSnapshot === snapshot,
  };
  context(state);
  // A declaration without members has no isolation range. Leave a previous
  // isolation before inspecting it, so the whole scene does not disappear.
  if (groupNode && !sourceIds.size && state.onlySelected) state.setOnlySelected(false);
  const tree = await import('../ui/engineeringTreeView.js');
  if (!guard.isCurrent()) return true;
  if (target.kind === 'engineering-source') tree.revealEngineeringSource(state, target.key);
  else tree.syncEngineeringTreeSelection(state);
  state.deviceLodRuntime?.setOnlySelected?.(state.onlySelected); applyGeometryFilter(state);
  const selectedSources: SourceRecord[] = [...sourceIds].flatMap(id => { const source = engineeringSourceRecord(state, id); return source ? [source] : []; });
  const declaredContexts = groupNode && 'declaredContextIds' in groupNode ? groupNode.declaredContextIds : undefined;
  const { renderEngineeringInspector } = await import('../ui/engineeringInspector.js');
  if (!guard.isCurrent()) return true;
  renderEngineeringInspector({ title: groupNode?.title ?? entity?.name ?? single?.name ?? '待归整体集合', entity, pending, sources: selectedSources,
    projectionEvidence: groupNode && 'inferred' in groupNode && groupNode.inferred ? groupNode.evidence : entity
      ? state.engineeringNavigation?.composition.rowsByEntity.get(entity.id)?.flatMap(key => {
        const row=state.engineeringNavigation?.composition.nodes.get(key); return row?.inferred ? row.evidence : [];
      }) : undefined,
    group: groupNode ? { entityCount: groupNode.entityCount, pendingCount: ownerIds.size - groupNode.entityCount,
      confirmedCount:'confirmedCount' in groupNode?groupNode.confirmedCount:undefined,
      attachmentCount:'attachmentCount' in groupNode?groupNode.attachmentCount:undefined,
      declarations: [...new Set((declaredContexts ?? []).flatMap((id:string) => {
        const document = representations.contextDocuments.get(id); return document ? [document] : [];
      }))].map(document => ({ title: groupNode.title, document })) } : undefined,
    partial: !sources.complete, geometryNote: '按来源成员解析表示；缺失或不可分离的范围保留状态。',
    relationships: snapshot.relationships.filter(r => ownerIds.has(r.from) || ownerIds.has(r.to)),
    relatedNames: new Map(snapshot.entities.map(entity => [entity.id, entity.name])),
    onFit: () => { if (guard.isCurrent()) void updateEngineeringHighlight(state, request, true, true); },
    onIsolate: () => { if (guard.isCurrent()) state.setOnlySelected(true); },
    onRestore: () => { if (guard.isCurrent()) state.setOnlySelected(false); },
    onSource: sourceId => { if (guard.isCurrent()) void selectEngineeringTarget(state, { kind: 'engineering-source', key: sourceId }); },
    onOwner: single && representations.index.ownerBySource.get(single.id) ? () => {
      if (!guard.isCurrent()) return;
      state.engineeringNavMode = state.engineeringNavMode==='inventory'?'inventory':'composition'; tree.renderEngineeringTree(state);
      void selectEngineeringTarget(state, { kind: 'engineering', key: representations.index.ownerBySource.get(single.id)! });
    } : undefined,
    onDocument: path => { if (guard.isCurrent()) void import('./engineeringSourceInspector.js').then(({ inspectEngineeringDocument }) => {
      if (guard.isCurrent()) void inspectEngineeringDocument(state, path);
    }); },
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
      return { 原始属性: properties.attributes, 属性集: properties.propertySets, 类型属性: properties.typeProperties, 材料: properties.materials };
    } : undefined,
  });
  if (!state.initialized) return true;
  await updateEngineeringHighlight(state, request, false);
  if (options.load !== false) for (const root of scope.devRoots) {
    if (!guard.isCurrent()) break;
    try { await state.deviceLodRuntime?.ensureBase?.(root); }
    catch (error) { if (guard.isCurrent()) state.selectionMessage = `部分来源表示未能准备：${String(error)}`; }
  }
  if (guard.isCurrent()) await updateEngineeringHighlight(state, request, options.fit ?? state.canAutoLocate(request), false, options.fit === undefined);
  return true;
}

async function refineEngineeringRange(state: AppState, request: SelectionRequest, scope: EngineeringSelectionScope, progress: (message: string) => void): Promise<void> {
  const current = () => state.isCurrentSelection(request) && state.engineeringSelection === scope && state.engineeringSnapshot === scope.snapshot;
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
  const previous = state.engineeringSelection, snapshot = state.engineeringSnapshot, target = request.target;
  if (!state.isCurrentSelection(request) || !previous || !snapshot || previous.snapshot === snapshot || !target) return;
  const ownerIds = new Set([...snapshot.entities, ...snapshot.pending].map(entity => entity.id));
  const validTarget = target.kind === 'engineering' ? ownerIds.has(target.key)
    : target.kind === 'engineering-source' ? snapshot.memberships.some(member => member.sourceId === target.key)
      : target.kind === 'engineering-group' && (state.engineeringNavigation?.composition.nodes.has(target.key) || state.engineeringNavigation?.inventory?.nodes.has(target.key));
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
  const baseGuard = state.selectionGuard(request), guard = { ...baseGuard, isCurrent: () => baseGuard.isCurrent() && state.engineeringSnapshot === snapshot };
  if (state.initialized) {
    const [{ getViewerRuntimeWithUI }, { commitSelectionHighlight }] = await Promise.all([import('./viewerUIBinding.js'), import('../viewer/highlight.js')]);
    if (!guard.isCurrent()) return;
    const { ctx } = await getViewerRuntimeWithUI(state, () => {}); if (!guard.isCurrent()) return;
    await commitSelectionHighlight(ctx, state, guard);
  }
  if (!guard.isCurrent()) return;
  state.setOnlySelected(state.onlySelected);
  state.selectionGeometry = { status: 'not-loaded', detail: '来源更新后，原选择的整体边界需要重新确认。' };
  const [{ renderInspectorTabs, sectionHtml, openPropsDrawerUI }, { escHtml }] = await Promise.all([import('../ui/propsDrawer.js'), import('../shared/html.js')]);
  if (!guard.isCurrent()) return;
  const choices = [...candidates], names = new Map(snapshot.entities.map(entity => [entity.id, entity.name]));
  openPropsDrawerUI(); renderInspectorTabs('<div class="props-header">选择范围待确认</div>', {
    overview: sectionHtml('范围变化', [['状态', state.selectionGeometry.detail]]) + choices.map((id, index) => `<button class="prop-ref-link" data-engineering-choice="${index}">${escHtml(names.get(id) ?? '待归整体集合')}</button>`).join(''), params: '', relations: '', source: '',
  });
  document.querySelectorAll<HTMLElement>('[data-engineering-choice]').forEach(button => button.addEventListener('click', () => {
    if (guard.isCurrent()) void selectEngineeringTarget(state, { kind: 'engineering', key: choices[Number(button.dataset.engineeringChoice)] });
  }));
}
