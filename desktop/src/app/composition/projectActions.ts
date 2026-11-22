import { perfCurrentSession } from '../../utils/perfTimings.js';
import type { ProjectOpenRouting } from '../session/openProject.js';
import type { AppState } from '../state.js';

function scheduleBaselineBeforeOpen(state: AppState, generation: number): void {
  const perfSession = perfCurrentSession();
  void import('../../services/projectResourceTelemetry.js')
    .then(({ sampleSubstationRuntimeResources }) =>
      sampleSubstationRuntimeResources(
        state,
        'baselineBeforeOpen',
        perfSession,
        undefined,
        { requestGeneration: generation },
        { isCurrent: () => state.projectGeneration === generation },
      ),
    )
    .catch(() => undefined);
}

const loadCleanup = async () => (await import('./projectLifecycle.js')).cleanupProject;

async function prepareOpen(state: AppState) {
  const { isCurrent } = state.projectSession.claimIntent();
  const [open, runtimes] = await Promise.all([
    import('../session/openProject.js'),
    import('./projectRuntimes.js'),
  ]);
  if (isCurrent())
    return {
      open,
      routing: {
        ownsIntent: isCurrent,
        dispatch: runtimes.dispatchProjectRuntime,
        loadCleanup,
        beforeOpen: scheduleBaselineBeforeOpen,
        recentProjectsChanged: () =>
          window.dispatchEvent(new CustomEvent('gim:recent-projects-changed')),
        loadEarlySubstation: () =>
          import('../../features/substation/runtime/substationExtractionJob.js'),
      } satisfies ProjectOpenRouting,
    };
}

export async function openGimWithDialog(
  state: AppState,
  showMessage: (text: string) => void,
): Promise<void> {
  const prepared = await prepareOpen(state);
  if (prepared) await prepared.open.openGimWithDialog(state, showMessage, prepared.routing);
}

export async function openGimProjectFromId(
  state: AppState,
  showMessage: (text: string) => void,
  projectId: number,
): Promise<void> {
  const prepared = await prepareOpen(state);
  if (prepared)
    await prepared.open.openGimProjectFromId(state, showMessage, projectId, prepared.routing);
}

export async function openGimForBenchmark(state: AppState, path: string): Promise<void> {
  const prepared = await prepareOpen(state);
  if (prepared) await prepared.open.openGimForBenchmark(state, path, prepared.routing);
}

export async function closeProject(state: AppState): Promise<boolean> {
  const { isLatest } = state.projectSession.claimIntent();
  const cleanupProject = await loadCleanup();
  return isLatest() && (await cleanupProject(state));
}
