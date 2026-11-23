import { projectPresentation } from '../../services/presentation/projectPresentationPort.js';
import { projectOpenPresentation } from '../../services/presentation/projectOpenPresentationPort.js';
import {
  scheduleHideLoading,
  showLoading,
  hideLoading,
} from '../../services/project/gimOpenCore.js';
import type { AppState } from '../state.js';
import { isTauri } from '@desktop/runtime.js';
import { openIfcFilePaths } from '@desktop/fileDialog.js';
import { logger } from '../../utils/logger.js';

/** File choice belongs to UI; loading and source/session ownership belong here. */
export async function openIfcWithDialog(
  state: AppState,
  showMessage: (text: string) => void,
): Promise<void> {
  const native = isTauri(),
    presentation = projectOpenPresentation();
  const session = state.captureProjectSession();
  if (!state.isCurrentSession(session)) return;
  const paths = native ? await openIfcFilePaths() : null,
    files = native ? null : await presentation.chooseIfc();
  if (!state.isCurrentSession(session) || (native ? !paths?.length : !files?.length)) return;
  const scope = state.sessionScope(session);
  const ownsControls = state.projectSession.claimAttachmentControls();
  presentation.setBusy('ifc', true);
  const releaseControls = scope.own(() => {
    if (!ownsControls()) return;
    if (!native) presentation.resetInput('ifc');
    presentation.setBusy('ifc', false);
  });
  try {
    showLoading('正在加载 3D 引擎...');
    const [
      { getViewerRuntimeWithUI },
      { ensureEngineReady, loadStandaloneIfc },
      { fitCameraToScene },
    ] = await Promise.all([
      import('../../services/presentation/viewerUIBinding.js'),
      import('../../viewer/ifcLoader.js'),
      import('../../viewer/camera.js'),
    ]);
    const runtime = await getViewerRuntimeWithUI(state, showMessage);
    if (!state.isCurrentSession(session)) return;
    const reader = native ? await import('../../infrastructure/native/fileReader.js') : undefined;
    await ensureEngineReady(runtime.ctx, state, runtime.modelCallbacks);
    if (!state.isCurrentSession(session)) return;
    const sources = native
      ? (paths ?? []).map((path) => {
          const name = (path.split(/[\\/]/).pop() || 'model.ifc').replace(/\.ifc$/i, '');
          return {
            name,
            label: path,
            progressLabel: name,
            key: path,
            read: async () =>
              new Uint8Array(
                await reader!.readFileBytes(path, () => state.isCurrentSession(session)),
              ),
          };
        })
      : (files ?? []).map((file) => ({
          name: file.name.replace(/\.ifc$/i, ''),
          label: file.name,
          progressLabel: file.name,
          key: file.webkitRelativePath || file.name,
          read: async () => new Uint8Array(await file.arrayBuffer()),
        }));
    for (const source of sources) {
      if (!state.isCurrentSession(session)) return;
      showLoading(`正在加载 ${source.label}...`);
      await loadStandaloneIfc(
        runtime.ctx,
        source.name,
        source.read,
        state,
        (p) => showLoading(`${source.progressLabel}: ${Math.round(p * 100)}%`),
        source.key,
        session,
      );
    }
    if (!state.isCurrentSession(session)) return;
    projectPresentation().hideEmptyState();
    fitCameraToScene(runtime.ctx, state.viewState);
  } catch (error) {
    if (!state.isCurrentSession(session)) return;
    logger.error(error);
    showLoading(`IFC 加载失败: ${error instanceof Error ? error.message : String(error)}`);
    scheduleHideLoading(() => state.isCurrentSession(session), 3000);
  } finally {
    releaseControls();
    if (scope.isCurrent() && ownsControls()) hideLoading();
  }
}
