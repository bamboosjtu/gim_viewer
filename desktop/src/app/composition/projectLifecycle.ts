import type { AppState } from '../state.js';
import { cleanupProject as coordinateCleanup } from '../session/projectCleanup.js';
import { markMeasurementCancellation } from '../../measurement/runtime.js';
import { reportBackgroundError } from '../../utils/backgroundErrors.js';
import { perfCurrentSession } from '../../utils/perfTimings.js';
import { projectPresentation } from '../../services/projectPresentationPort.js';
import { releaseProjectViewer } from '../../services/projectViewerLifecycle.js';
import { sampleSubstationRuntimeResources } from '../../services/projectResourceTelemetry.js';
import { cancelSubstationExtraction } from '../../features/substation/runtime/substationExtractionJob.js';
import { cancelIfcConversions } from '../../viewer/ifcConversion.js';
import { resetStatusRight } from '../../services/presentation/shell_statusBar.js';
import { container } from '../../ui/dom.js';

/** Composition supplies the real Viewer, feature cancellation and presentation ports. */
export function cleanupProject(state: AppState, expectedGeneration?: number): Promise<boolean> {
  const shouldSample =
    state.currentProjectType === 'substation' ||
    state.currentIfcEntries.length > 0 ||
    state.modRootGroup != null ||
    state.stlRootGroup != null ||
    state.loadedXmlModGroups.size > 0 ||
    state.loadedStlGroups.size > 0;
  return coordinateCleanup(
    state,
    {
      markCancellation: (closing) =>
        markMeasurementCancellation(closing ? 'project-closed' : 'project-replaced'),
      cancelPending: () => {
        cancelSubstationExtraction(state);
        cancelIfcConversions();
      },
      async prepareRelease(current) {
        const { resetIfcWorkCompletion } = await import('../../viewer/geometryWorkGate.js');
        if (!current()) return;
        resetIfcWorkCompletion();
        const { cancelDevGeometryPreprocessing } =
          await import('../../services/devGeometryWorkerClient.js');
        if (current()) cancelDevGeometryPreprocessing(state);
      },
      viewer: {
        async releaseProject(current, cleanupGeneration) {
          const perfSession = perfCurrentSession();
          const result = await releaseProjectViewer(
            state,
            async () => {
              const { isViewerRuntimeCreated, getViewerRuntime } =
                await import('../../viewer/viewerRuntime.js');
              if (current() && isViewerRuntimeCreated())
                return (await getViewerRuntime(container)).ctx;
            },
            current,
            (ctx) => {
              if (shouldSample)
                void sampleSubstationRuntimeResources(
                  state,
                  'beforeCleanup',
                  perfSession,
                  ctx,
                  { cleanupGeneration },
                  { isCurrent: current },
                ).catch(reportBackgroundError);
            },
          );
          if (!result) return false;
          return () => {
            if (!shouldSample || !current()) return;
            const { counts, context } = result;
            const meta = {
              cleanupGeneration,
              disposedModels: counts.disposedCount,
              attemptedModels: counts.attemptedCount,
              xmlModGroups: counts.xmlModDisposedCount,
              stlGroups: counts.stlDisposedCount,
            };
            void sampleSubstationRuntimeResources(
              state,
              'afterCleanup',
              perfSession,
              context,
              meta,
              { isCurrent: current },
            ).catch(reportBackgroundError);
            setTimeout(() => {
              if (current())
                void sampleSubstationRuntimeResources(
                  state,
                  'settledAfterCleanup',
                  perfSession,
                  context,
                  meta,
                  { isCurrent: current },
                ).catch(reportBackgroundError);
            }, 250);
          };
        },
      },
      presentation: {
        resetIdentity: (current) => projectPresentation().resetIdentity(current),
        resetStatus: resetStatusRight,
        clearProjectViews: (current) => projectPresentation().clearProjectViews(current),
        async closed(current) {
          try {
            const { hideLoading } = await import('../../services/gimOpenCore.js');
            if (current()) hideLoading();
          } catch {
            /* best effort */
          }
          if (current()) window.dispatchEvent(new CustomEvent('gim:project-closed'));
        },
      },
    },
    expectedGeneration,
  );
}
