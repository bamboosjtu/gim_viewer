import { logger } from '../../utils/logger.js';
import measuredWorkerAsset from '../../infrastructure/workers/compositionProjectionWorker.ts?worker&url';
import { createMeasuredWorker, measurementWorkerUrl } from '../../measurement/hostWorker.js';
import { selectionPresentation } from '../presentation/selectionPresentationPort.js';
import type { AppState } from '../../app/state.js';
import type { CompositionBounds } from './compositionSpatial.js';
import { fromIfcYUpBounds } from './compositionSpatial.js';
import type { EngineeringNavigationData } from '../../gim/engineering/navigation.js';
import type {
  ProjectionInput,
  ProjectionOutput,
} from '../../infrastructure/workers/compositionProjectionWorker.js';
import { categoryLabel } from '../../engineering/catalogLabels.js';
import { perfMarkProductMoment } from '../../utils/perfTimings.js';

/** Reconcile view targets without changing the entity snapshot or loading L2. */
export async function reconcileProjectionSelection(state: AppState): Promise<void> {
  const request = state.selection.selectionRequest,
    target = request?.target;
  if (!request || !target || !state.selection.isCurrentSelection(request)) return;
  if (
    target.kind === 'engineering-group' &&
    !state.engineering.navigation?.composition.nodes.has(target.key) &&
    !state.engineering.navigation?.inventory?.nodes.has(target.key)
  ) {
    state.selection.setOnlySelected(false);
    const cleared = state.selection.beginSelection(null);
    state.selection.selectionMessage = '空间细化后原分组已更新，请重新选择。';
    const { clearEngineeringHighlight } = await import('./engineeringSelection.js');
    await clearEngineeringHighlight(state, cleared);
    if (!state.selection.isCurrentSelection(cleared)) return;
    await selectionPresentation().projectionChanged(state.selection.selectionMessage, () =>
      state.selection.isCurrentSelection(cleared),
    );
  } else if (
    target.kind === 'engineering' ||
    target.kind === 'engineering-source' ||
    target.kind === 'engineering-group'
  ) {
    const { selectEngineeringTarget } = await import('./engineeringSelection.js');
    if (state.selection.isCurrentSelection(request))
      await selectEngineeringTarget(state, { kind: target.kind, key: target.key }, request, {
        fit: false,
        load: false,
      });
  }
}

/** Bounds refine only the composition projection. The semantic cache and all
 * entity/source/representation identities remain independent of runtime geometry. */
export function installCompositionProjection(
  state: AppState,
  onReady?: (complete: boolean) => void,
): () => void {
  const session = state.captureProjectSession();
  let timer: ReturnType<typeof setTimeout> | undefined, worker: Worker | undefined;
  let disposed = false,
    revision = 0;
  let baseView: EngineeringNavigationData | undefined,
    publishedView: EngineeringNavigationData | undefined;
  const current = () => !disposed && state.isCurrentSession(session);
  const reconcile = () => {
    void reconcileProjectionSelection(state).catch((error) => {
      if (current()) logger.warn('[工程投影选择]', error);
    });
  };
  const update = () => {
    // A persisted navigation projection already contains the geometry/space
    // refinement for this source identity. Rewarming must not run the
    // composition worker again just because the renderer publishes the same
    // regional bounds.
    if (!current()) return;
    if (state.engineering.navigationCacheHit && state.engineering.navigation?.compositionComplete) {
      reconcile();
      return;
    }
    revision++;
    worker?.terminate();
    worker = undefined;
    clearTimeout(timer);
    timer = setTimeout(run, 500);
  };
  function run() {
    if (
      !current() ||
      (state.engineering.navigationCacheHit && state.engineering.navigation?.compositionComplete)
    )
      return;
    const snapshot = state.engineering.snapshot,
      view = state.engineering.navigation,
      input = view?.compositionInput;
    if (!snapshot || !view || !input) return;
    const sources = state.engineering.sources;
    if (
      sources?.incompleteReasons.includes('ifc-manifest-incomplete') &&
      !state.engineering.ifcGeometryFinished
    )
      return;
    const models = sources?.models ?? [];
    if (!models.length) {
      if (state.engineering.buildPending) return;
      if (state.engineering.treeStatus === 'ready' && view.compositionCoverage === 'partial')
        return;
      state.engineering.treeStatus = 'ready';
      state.engineering.navigation = { ...view, compositionCoverage: 'partial' };
      perfMarkProductMoment('engineeringTreeReady', {
        available: true,
        source: 'partial-projection',
        coverage: 'partial',
      });
      state.notifyEngineeringChanged();
      onReady?.(false);
      return;
    }
    const missing = models.filter((model) => !state.ifc.regionalRuntimes.has(model.modelId));
    if (missing.length && !state.engineering.ifcGeometryFinished) return;
    const complete = missing.length === 0;
    // Start from semantic paths/search strings, rather than accumulating earlier
    // spatial estimates. A new semantic publication resets this base.
    if (view !== publishedView) baseView = view;
    const base = baseView!;
    const restore = () => {
      if (
        !current() ||
        snapshot !== state.engineering.snapshot ||
        view !== state.engineering.navigation ||
        view === base
      )
        return;
      state.engineering.navigation = base;
      publishedView = undefined;
      for (const key of state.viewState.expanded.composition)
        if (!base.composition.nodes.has(key)) state.viewState.expanded.composition.delete(key);
      state.notifyEngineeringChanged();
      reconcile();
    };
    const owners = new Map(snapshot.memberships.map((m) => [m.sourceId, m.ownerId])),
      bounds: CompositionBounds[] = [];
    for (const [model, runtime] of state.ifc.regionalRuntimes)
      for (const object of runtime.index.objects) {
        const sourceId = `ifc:${JSON.stringify([model, object.expressId])}`,
          owner = owners.get(sourceId),
          sourceBounds = fromIfcYUpBounds(object.bounds);
        if (owner && sourceBounds) bounds.push({ entityId: owner, bounds: sourceBounds });
      }
    const runRevision = revision;
    let owned: Worker;
    try {
      owned = worker = createMeasuredWorker(
        'engineering-composition',
        (identity) =>
          new Worker(measurementWorkerUrl(measuredWorkerAsset, identity), {
            type: 'module',
            ...(identity ? { name: identity } : {}),
          }),
      );
    } catch (error) {
      logger.warn('[工程组成投影]', error);
      restore();
      state.engineering.treeStatus = 'ready';
      state.engineering.navigation = { ...base, compositionCoverage: 'partial' };
      state.notifyEngineeringChanged();
      onReady?.(false);
      return;
    }
    owned.onmessage = (event: MessageEvent<ProjectionOutput>) => {
      if (
        !current() ||
        worker !== owned ||
        revision !== runRevision ||
        snapshot !== state.engineering.snapshot ||
        view !== state.engineering.navigation
      ) {
        owned.terminate();
        return;
      }
      owned.terminate();
      worker = undefined;
      if ('error' in event.data) {
        logger.warn('[工程组成投影]', event.data.error);
        restore();
        state.engineering.treeStatus = 'ready';
        state.engineering.navigation = { ...base, compositionCoverage: 'partial' };
        state.notifyEngineeringChanged();
        onReady?.(false);
        return;
      }
      const { composition } = event.data,
        contexts = new Map(event.data.contexts),
        entities = new Map(snapshot.entities.map((e) => [e.id, e]));
      publishedView = {
        ...base,
        compositionComplete: true,
        compositionCoverage: complete && !!bounds.length ? 'full' : 'partial',
        composition,
        compositionSearch: base.compositionSearch.map((row) => {
          const entity = entities.get(row.key);
          if (!entity) return row;
          const inferred = composition.rowsByEntity
            .get(entity.id)
            ?.some((key) => composition.nodes.get(key)?.inferred);
          const subtitle = `${categoryLabel(entity.category)} · ${contexts.get(row.key) ?? '工程归属待确认'}${inferred ? ' · 空间推断' : ''}`;
          return { ...row, subtitle, searchText: `${row.searchText}\n${subtitle.toLowerCase()}` };
        }),
      };
      state.engineering.navigation = publishedView;
      state.engineering.treeStatus = 'ready';
      perfMarkProductMoment('engineeringTreeReady', {
        available: true,
        source: 'composition-projection',
        coverage: publishedView.compositionCoverage,
      });
      for (const key of state.viewState.expanded.composition)
        if (!composition.nodes.has(key)) state.viewState.expanded.composition.delete(key);
      state.notifyEngineeringChanged();
      onReady?.(publishedView.compositionCoverage === 'full');
      reconcile();
    };
    owned.onerror = (event) => {
      if (current()) logger.warn('[工程组成投影]', event.message);
      owned.terminate();
      if (worker === owned) {
        worker = undefined;
        restore();
        state.engineering.treeStatus = 'ready';
        state.engineering.navigation = { ...base, compositionCoverage: 'partial' };
        state.notifyEngineeringChanged();
        onReady?.(false);
      }
    };
    const message: ProjectionInput = {
      snapshot: {
        ...snapshot,
        entities: snapshot.entities.map((e) => ({ ...e, sourceIds: [] })),
        memberships: [],
        relationships: [],
        aliases: [],
        diagnostics: [],
      },
      facts: input.facts,
      declarations: input.declarations,
      bounds,
    };
    try {
      owned.postMessage(message);
    } catch (error) {
      owned.terminate();
      if (worker === owned) worker = undefined;
      logger.warn('[工程组成投影]', error);
      restore();
      state.engineering.treeStatus = 'ready';
      state.engineering.navigation = { ...base, compositionCoverage: 'partial' };
      state.notifyEngineeringChanged();
      onReady?.(false);
    }
  }
  state.engineeringGeometryEvidenceChanged = update;
  return () => {
    disposed = true;
    revision++;
    clearTimeout(timer);
    worker?.terminate();
    if (state.engineeringGeometryEvidenceChanged === update)
      state.engineeringGeometryEvidenceChanged = null;
  };
}
