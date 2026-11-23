import * as THREE from 'three';
import type { AppState } from '../../app/state.js';
import type { ViewerContext } from '../../viewer/viewerEngine.js';
import { bindViewerTools } from '../../viewer/viewerToolRuntime.js';
import { sceneMeshBounds, fitCameraToScene } from '../../viewer/camera.js';
import { readIfcCoordinateAnchor } from '../../viewer/ifcCoordinateAnchor.js';
import { ViewerToolFilters } from '../selection/viewerToolFilters.js';
export function bindViewerToolCommands(
  state: AppState,
  ctx: ViewerContext,
  container: HTMLElement,
) {
  const filters = new ViewerToolFilters(state, ctx);
  state.toolModelChanged = (added) => {
    const owner = state.captureProjectSession();
    // A newly attached far/near representation inherits the active mask before its first draw.
    if (filters.active && added) {
      const model = ctx.fragments.list.get(state.ifc.getRuntimeModelId(added));
      if (model) {
        const visibility = state.selection.selectionVisibility?.registerModel(added, model);
        visibility?.setBrowseMask(new Set(), new Set()).catch((e) => {
          if (state.isCurrentSession(owner)) {
            state.viewerCommands.snapshot.message = String(e);
            state.viewerCommands.notify();
          }
        });
      }
      state.ifc.regionalRuntimes.get(added)?.setBrowseMask(new Set(), new Set());
    }
    if (filters.active)
      void filters.apply().catch((e) => {
        if (!state.isCurrentSession(owner)) return;
        state.viewerCommands.snapshot.message = String(e);
        state.viewerCommands.notify();
      });
    if (state.viewerCommands.snapshot.tool === 'display')
      state.viewerCommands.dispatch({ kind: 'refreshOptions' });
    else state.viewerCommands.notify();
  };
  const anchor = () => state.projectSourceToViewerMatrix;
  const runtime = bindViewerTools(ctx, container, state.viewerCommands, {
    anchor,
    home: () => {
      if (state.viewState.stationOverview) state.viewState.stationOverview();
      else fitCameraToScene(ctx, state.viewState, { force: true });
    },
    back: async () => state.viewState.viewHistory?.back(),
    resolveAnchor: async () => {
      if (anchor()) return anchor();
      const model = ctx.fragments.list.get(ctx.fragments.baseCoordinationModel);
      return model
        ? (await readIfcCoordinateAnchor(model)).multiply(
            new THREE.Matrix4().makeRotationX(-Math.PI / 2),
          )
        : null;
    },
    bounds: async () => {
      const box = new THREE.Box3(),
        s = state.selection;
      for (const group of s.highlightedModState?.groups ?? []) box.expandByObject(group);
      for (const [id, ids] of Object.entries(s.highlightedItems ?? {})) {
        const model = ctx.fragments.list.get(id);
        if (model) box.union(await model.getMergedBox([...ids]));
      }
      for (const ref of s.engineeringSelection?.ifc ?? []) {
        const rt = state.ifc.regionalRuntimes.get(ref.modelId),
          obj = rt?.index.objects.find((o) => o.expressId === ref.expressId);
        const bounds = obj && rt?.worldBounds(obj);
        if (bounds) box.union(bounds);
      }
      return box.isEmpty() ? sceneMeshBounds(ctx, false) : box;
    },
    filter: (c) => filters.command(c),
    reset: () => filters.reset(),
  });
  return {
    ...runtime,
    dispose() {
      state.toolModelChanged = undefined;
      runtime.dispose();
    },
  };
}
