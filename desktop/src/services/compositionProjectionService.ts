import measuredWorkerAsset from './compositionProjectionWorker.ts?worker&url';
import { createMeasuredWorker, measurementWorkerUrl } from '../measurement/hostWorker.js';
import { loadPresentation } from './presentationPort.js';
import type { AppState } from '../app/state.js';
import type { CompositionBounds } from './projections/compositionSpatial.js';
import { fromIfcYUpBounds } from './projections/compositionSpatial.js';
import type { EngineeringNavigationData } from '../gim/engineering/navigation.js';
import type { ProjectionInput, ProjectionOutput } from './compositionProjectionWorker.js';
import { categoryLabel } from '../engineering/catalogLabels.js';
import {perfMarkProductMoment} from '../utils/perfTimings.js';

/** Reconcile view targets without changing the entity snapshot or loading L2. */
export async function reconcileProjectionSelection(state: AppState): Promise<void> {
  const request = state.selectionRequest, target = request?.target;
  if (!request || !target || !state.isCurrentSelection(request)) return;
  if (target.kind === 'engineering-group'
    && !state.engineeringNavigation?.composition.nodes.has(target.key)
    && !state.engineeringNavigation?.inventory?.nodes.has(target.key)) {
    state.setOnlySelected(false);
    const cleared = state.beginSelection(null);
    state.selectionMessage = '空间细化后原分组已更新，请重新选择。';
    const { clearEngineeringHighlight } = await import('./engineeringSelection.js');
    await clearEngineeringHighlight(state, cleared);
    if (!state.isCurrentSelection(cleared)) return;
    const { renderInspectorTabs, sectionHtml } = await loadPresentation('propsDrawer');
    if (state.isCurrentSelection(cleared)) renderInspectorTabs('<div class="props-header">工程分组已更新</div>', {
      overview: sectionHtml('选择范围', [['状态', state.selectionMessage]]), params: '', relations: '', source: '',
    });
  } else if (target.kind === 'engineering' || target.kind === 'engineering-source' || target.kind === 'engineering-group') {
    const { selectEngineeringTarget } = await import('./engineeringSelection.js');
    if (state.isCurrentSelection(request)) await selectEngineeringTarget(state, { kind: target.kind, key: target.key }, request, { fit: false, load: false });
  }
}

/** Bounds refine only the composition projection. The semantic cache and all
 * entity/source/representation identities remain independent of runtime geometry. */
export function installCompositionProjection(state: AppState, onReady?: (complete:boolean)=>void): () => void {
  const session = state.captureProjectSession();
  let timer: ReturnType<typeof setTimeout> | undefined, worker: Worker | undefined;
  let disposed = false, revision = 0;
  let baseView: EngineeringNavigationData | undefined, publishedView: EngineeringNavigationData | undefined;
  const current = () => !disposed && state.isCurrentSession(session);
  const reconcile = () => { void reconcileProjectionSelection(state).catch(error => { if (current()) console.warn('[工程投影选择]', error); }); };
  const update = () => {
    // A persisted navigation projection already contains the geometry/space
    // refinement for this source identity. Rewarming must not run the
    // composition worker again just because the renderer publishes the same
    // regional bounds.
    if (!current()) return;
    if(state.engineeringNavigationCacheHit && state.engineeringNavigation?.compositionComplete){reconcile();return;}
    revision++;
    worker?.terminate(); worker = undefined;
    clearTimeout(timer); timer = setTimeout(run, 500);
  };
  function run() {
    if (!current() || state.engineeringNavigationCacheHit && state.engineeringNavigation?.compositionComplete) return;
    const snapshot = state.engineeringSnapshot, view = state.engineeringNavigation, input = view?.compositionInput;
    if (!snapshot || !view || !input) return;
    const sources=state.engineeringSources;
    if(sources?.incompleteReasons.includes('ifc-manifest-incomplete')&&!state.engineeringIfcGeometryFinished)return;
    const models=sources?.models??[];
    if(!models.length){
      if(state.engineeringBuildPending)return;
      if(state.engineeringTreeStatus==='ready'&&view.compositionCoverage==='partial')return;
      state.engineeringTreeStatus='ready';
      state.engineeringNavigation={...view,compositionCoverage:'partial'};
      perfMarkProductMoment('engineeringTreeReady',{available:true,source:'partial-projection',coverage:'partial'});
      state.notifyEngineeringChanged();onReady?.(false);
      return;
    }
    const missing=models.filter(model=>!state.ifcRegionalRuntimes.has(model.modelId));
    if(missing.length&&!state.engineeringIfcGeometryFinished)return;
    const complete=missing.length===0;
    // Start from semantic paths/search strings, rather than accumulating earlier
    // spatial estimates. A new semantic publication resets this base.
    if (view !== publishedView) baseView = view;
    const base = baseView!;
    const restore = () => {
      if (!current() || snapshot !== state.engineeringSnapshot || view !== state.engineeringNavigation || view === base) return;
      state.engineeringNavigation = base; publishedView = undefined;
      for (const key of state.engineeringExpandedRows.composition) if (!base.composition.nodes.has(key)) state.engineeringExpandedRows.composition.delete(key);
      state.notifyEngineeringChanged(); reconcile();
    };
    const owners = new Map(snapshot.memberships.map(m => [m.sourceId, m.ownerId])), bounds: CompositionBounds[] = [];
    for (const [model, runtime] of state.ifcRegionalRuntimes) for (const object of runtime.index.objects) {
      const sourceId = `ifc:${JSON.stringify([model, object.expressId])}`, owner = owners.get(sourceId), sourceBounds = fromIfcYUpBounds(object.bounds);
      if (owner && sourceBounds) bounds.push({ entityId: owner, bounds: sourceBounds });
    }
    const runRevision = revision;
    let owned: Worker;
    try { owned = worker = createMeasuredWorker('engineering', identity => new Worker(measurementWorkerUrl(measuredWorkerAsset,identity), {type:'module',...(identity?{name:identity}:{})})); }
    catch (error) { console.warn('[工程组成投影]', error); restore();state.engineeringTreeStatus='ready';state.engineeringNavigation={...base,compositionCoverage:'partial'};state.notifyEngineeringChanged();onReady?.(false); return; }
    owned.onmessage = (event: MessageEvent<ProjectionOutput>) => {
      if (!current() || worker !== owned || revision !== runRevision || snapshot !== state.engineeringSnapshot || view !== state.engineeringNavigation) { owned.terminate(); return; }
      owned.terminate(); worker = undefined;
      if ('error' in event.data) { console.warn('[工程组成投影]', event.data.error); restore();state.engineeringTreeStatus='ready';state.engineeringNavigation={...base,compositionCoverage:'partial'};state.notifyEngineeringChanged();onReady?.(false); return; }
      const { composition } = event.data, contexts = new Map(event.data.contexts), entities = new Map(snapshot.entities.map(e => [e.id, e]));
      publishedView = { ...base, compositionComplete:true, compositionCoverage:complete&&!!bounds.length?'full':'partial', composition, compositionSearch: base.compositionSearch.map(row => {
        const entity = entities.get(row.key); if (!entity) return row;
        const inferred = composition.rowsByEntity.get(entity.id)?.some(key => composition.nodes.get(key)?.inferred);
        const subtitle = `${categoryLabel(entity.category)} · ${contexts.get(row.key) ?? '工程归属待确认'}${inferred ? ' · 空间推断' : ''}`;
        return { ...row, subtitle, searchText: `${row.searchText}\n${subtitle.toLowerCase()}` };
      }) };
      state.engineeringNavigation = publishedView;
      state.engineeringTreeStatus='ready';
      perfMarkProductMoment('engineeringTreeReady',{available:true,source:'composition-projection',coverage:publishedView.compositionCoverage});
      for (const key of state.engineeringExpandedRows.composition) if (!composition.nodes.has(key)) state.engineeringExpandedRows.composition.delete(key);
      state.notifyEngineeringChanged();
      onReady?.(publishedView.compositionCoverage==='full');
      reconcile();
    };
    owned.onerror = event => { if (current()) console.warn('[工程组成投影]', event.message); owned.terminate(); if (worker === owned) { worker = undefined; restore();state.engineeringTreeStatus='ready';state.engineeringNavigation={...base,compositionCoverage:'partial'};state.notifyEngineeringChanged();onReady?.(false); } };
    const message: ProjectionInput = { snapshot: { ...snapshot, entities: snapshot.entities.map(e => ({ ...e, sourceIds: [] })), memberships: [], relationships: [], aliases: [], diagnostics: [] }, facts: input.facts, declarations: input.declarations, bounds };
    try { owned.postMessage(message); }
    catch (error) { owned.terminate(); if (worker === owned) worker = undefined; console.warn('[工程组成投影]', error); restore();state.engineeringTreeStatus='ready';state.engineeringNavigation={...base,compositionCoverage:'partial'};state.notifyEngineeringChanged();onReady?.(false); }
  }
  state.engineeringGeometryEvidenceChanged = update;
  return () => { disposed = true; revision++; clearTimeout(timer); worker?.terminate(); if (state.engineeringGeometryEvidenceChanged === update) state.engineeringGeometryEvidenceChanged = null; };
}
