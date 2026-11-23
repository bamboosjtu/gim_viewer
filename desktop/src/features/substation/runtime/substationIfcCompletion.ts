import type { AppState, ProjectLoadSession } from '../../../app/state.js';
import type { IfcEntry } from '../../../gim/types.js';
import type { ViewerContext } from '../../../viewer/viewerEngine.js';
import { reportBackgroundError } from '../../../utils/backgroundErrors.js';
import { logger } from '../../../utils/logger.js';
import { perfBegin, perfMarkProductMoment, type PerfSession } from '../../../utils/perfTimings.js';
import {
  renderSubstationCoreUi,
  showLoadingBeforeInteractive,
} from '../presentation/substationPresentation.js';
import type { SubstationBackgroundCoordinator } from './substationBackgroundRuntime.js';
import type { SubstationIfcLoadProgress } from './substationIfcLoadProgress.js';
import type { SubstationIfcUsableModel } from './substationIfcModelLoad.js';
import { sampleSubstationMemory } from './substationRuntimeTelemetry.js';

interface IfcCompletionOptions {
  state: AppState;
  ctx: ViewerContext;
  entries: IfcEntry[];
  session: ProjectLoadSession;
  perfSession: PerfSession;
  background: SubstationBackgroundCoordinator;
  progress: SubstationIfcLoadProgress;
  measureGeometryTracks: boolean;
  isCurrent(this: void): boolean;
  isInteractive(this: void): boolean;
  syncCoordinateAnchor(this: void, label: string): Promise<void>;
  enqueueDevGeometry(this: void): void;
  startDeferredAfterPaint(this: void): void;
  initializeInteractiveAfterFirstIfc(
    this: void,
    entry: IfcEntry,
    source: SubstationIfcUsableModel['source'],
    object: SubstationIfcUsableModel['object'],
  ): Promise<void>;
}

/** Completes the IFC tail and publishes navigation under the same session. */
export function createSubstationIfcCompletion({
  state,
  ctx,
  entries,
  session,
  perfSession,
  background,
  progress,
  measureGeometryTracks,
  isCurrent,
  isInteractive,
  syncCoordinateAnchor,
  enqueueDevGeometry,
  startDeferredAfterPaint,
  initializeInteractiveAfterFirstIfc,
}: IfcCompletionOptions) {
  async function settle(skippedCount: number): Promise<boolean> {
    progress.finishQueue();

    // A first usable IFC normally establishes the coordinate anchor.  Retry
    // once after the sequential tail only when that first attempt had no
    // usable Fragments base; this retry is a diagnostic fallback, not an
    // interactive barrier.
    if (!state.projectSourceToViewerMatrix) {
      await syncCoordinateAnchor('变电 coordinate alignment（all IFC fallback）');
      if (!isCurrent()) return false;
    }

    progress.settle();
    background.completeRemainingIfc();
    state.ifcLoading.pending = false;
    enqueueDevGeometry();
    background.markAllIfcReady();
    // All IFCs may be empty/hidden. Complete source work independently of
    // presentation; this does not emit an interactive/visible-frame moment.
    startDeferredAfterPaint();
    if (entries.length > 0 && measureGeometryTracks)
      perfMarkProductMoment(
        'ifcBaseSettled',
        {
          total: entries.length,
          loaded: state.ifc.loadedModels.size,
          failed: progress.failedCount(),
          skipped: skippedCount,
        },
        perfSession,
      );
    perfMarkProductMoment(
      'allIfcReady',
      {
        total: entries.length,
        loaded: state.ifc.loadedModels.size,
        failed: progress.failedCount(),
        firstInteractive: isInteractive(),
      },
      perfSession,
    );
    void Promise.resolve(
      sampleSubstationMemory(
        state,
        'allIfcReady',
        perfSession,
        {
          total: entries.length,
          loaded: state.ifc.loadedModels.size,
          failed: progress.failedCount(),
        },
        ctx,
      ),
    ).catch(reportBackgroundError);

    return true;
  }

  async function finishNavigation(): Promise<boolean> {
    // buildIfcNameIndex 失败不应阻断 UI 渲染
    const { buildIfcNameIndex } = await import('../../../services/engineering/ifcNameIndex.js');
    if (!isCurrent()) return false;
    state.engineering.ifcGeometryFinished = true;
    state.engineeringGeometryEvidenceChanged?.();
    const endNameIndex = perfBegin('变电 IFC name index', undefined, perfSession);
    await buildIfcNameIndex(ctx, state, { session }).catch((err) => {
      logger.warn('[GIM] buildIfcNameIndex failed', err);
    });
    if (!isCurrent()) return false;
    endNameIndex(undefined, { models: state.ifc.loadedModels.size });

    if (!isInteractive() && state.ifc.loadedModels.size > 0) {
      // Defensive fallback for a loader that populated state without the
      // usual first-model event.  Normal IFC paths initialize above.
      for (const entry of entries) {
        const id = state.ifc.loadedModels.get(entry.modelId)?.runtimeModelId;
        const object =
          id && state.ifc.isCurrentRuntimeModel(id)
            ? ctx.fragments.list.get(id)?.object
            : undefined;
        if (!object) continue;
        await initializeInteractiveAfterFirstIfc(entry, 'unknown', object);
        break;
      }
      if (!isCurrent()) return false;
    }
    await renderSubstationCoreUi(
      state,
      (text) => showLoadingBeforeInteractive(state, text),
      session,
      perfSession,
      '变电 navigation/UI（all IFC）',
    );
    if (!isCurrent()) return false;
    // Keep the heavy post-IFC lane behind the final name-index/UI pass.  The
    // allIfcReady product moment is already recorded above, but releasing the
    // coordinator here avoids DEV geometry or a spatial rebuild competing with
    // the last mandatory UI bookkeeping.
    background.markAllIfcReady();
    return true;
  }

  return { settle, finishNavigation };
}
