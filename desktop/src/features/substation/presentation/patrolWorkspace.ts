import type { OrthoPerspectiveCamera } from '@thatopen/components';
import type { AppState } from '../../../app/state.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import type { ViewerRuntimeWithUI } from '../../../services/presentation/viewerUIBinding.js';
import { selectEngineeringTarget } from '../../../services/engineering/engineeringSelection.js';
import { clearCurrentSelection } from '../../../services/selection/selectionCommands.js';
import { capturePatrolCamera } from '../../../viewer/patrol/patrolContextSnapshot.js';
import { setRenderVisibility } from '../../../viewer/demandRendering.js';

export function capturePatrolWorkspace(
  state: AppState,
  scope: SessionScope,
  ctx: ViewerRuntimeWithUI['ctx'],
  patrol: NonNullable<ViewerRuntimeWithUI['patrol']>,
  show: (s: string) => void,
) {
  const tools = state.viewerCommands;
  const cam = ctx.world.camera as OrthoPerspectiveCamera;
  const grid = ctx.referenceGrid;
  const gridVisible = grid?.visible;
  const s = {
    camera: capturePatrolCamera(cam),
    tool: structuredClone(tools.snapshot),
    visibility: patrol.visibility.getVisibility(),
    target: state.selection.selectionRequest?.target
      ? { ...state.selection.selectionRequest.target }
      : null,
    origin: state.selection.selectionRequest?.origin,
    only: state.selection.onlySelected,
    selectionId: state.selection.selectionRequest?.id,
    inspectionChanged: false,
  };

  const needsSelectionRestore = () =>
    s.inspectionChanged || s.selectionId !== state.selection.selectionRequest?.id;
  async function restoreSelection() {
    if (!scope.isCurrent() || !needsSelectionRestore()) return;
    const target = s.target;
    if (!target) {
      const clearing = clearCurrentSelection(state);
      const request = state.selection.selectionRequest;
      await clearing;
      if (scope.isCurrent() && state.selection.selectionRequest === request) {
        s.selectionId = request?.id;
        s.inspectionChanged = false;
      }
      return;
    }
    const request = state.selection.beginSelection(target, s.origin);
    if (
      target.kind === 'engineering' ||
      target.kind === 'engineering-source' ||
      target.kind === 'engineering-group'
    ) {
      await selectEngineeringTarget(state, { kind: target.kind, key: target.key }, request, {
        fit: false,
        load: false,
      });
    } else if (target.kind === 'ifc-object' || target.kind === 'ifc-element') {
      await patrol.restoreIfc(target.key, request);
    } else if (target.kind === 'sld') {
      const { presentSldSelection } = await import('./substationPresentation.js');
      if (state.selection.isCurrentSelection(request))
        await presentSldSelection(state, target.key, show, scope.session, request);
    } else if (target.kind === 'cbm') {
      const { selectViewportDev } =
        await import('../../../services/selection/devViewportSelection.js');
      if (state.selection.isCurrentSelection(request))
        await selectViewportDev(ctx, state, target.key, '', request, show);
    }
    if (scope.isCurrent() && state.selection.isCurrentSelection(request)) {
      s.selectionId = request.id;
      s.inspectionChanged = false;
    }
  }
  return Object.assign(s, {
    restoreSelection,
    needsSelectionRestore,
    hideGrid() {
      if (grid) setRenderVisibility(grid, false);
    },
    restoreGrid() {
      if (grid && gridVisible !== undefined) setRenderVisibility(grid, gridVisible);
    },
    restoreVisibility() {
      state.selection.patrolIsolation = undefined;
      return patrol.visibility.setVisibility(
        {
          ...s.visibility,
          isolatedSelection: s.only ? (state.selection.selectionRequest?.id ?? null) : null,
        },
        scope.isCurrent,
      );
    },
    restoreTools() {
      const distances = new Map(
        [...s.tool.distances, ...tools.snapshot.distances].map((d) => [d.id, d]),
      );
      tools.snapshot = { ...s.tool, distances: [...distances.values()] };
      tools.notify();
    },
  });
}
