import { bindProjectOpenPresentation } from '../../services/presentation/projectOpenPresentationPort.js';
import { projectOpenPresentation } from '../../ui/projectOpenPresentation.js';
import { bindSelectionPresentation } from '../../services/presentation/selectionPresentationPort.js';
import { selectionPresentation } from '../../ui/selectionPresentation.js';
import { bindDiagramPresentation } from '../../services/presentation/diagramPresentationPort.js';
import { diagramPresentation } from '../../ui/diagramPresentation.js';
import { bindLinePresentation } from '../../features/powerline/presentation/linePresentationPort.js';
import { linePresentation } from '../../ui/linePresentation.js';
import { bindLineModSourceReader } from '../../features/powerline/presentation/lineModSourcePort.js';
import { bindLoadingPresentation } from '../../services/presentation/loadingPresentationPort.js';
import * as loadingView from '../../ui/loadingView.js';
import { bindViewerPresentation } from '../../services/presentation/viewerPresentationPort.js';
import { bindSourceInspectorPresentation } from '../../services/presentation/sourceInspectorPresentationPort.js';
import { bindPublicationView } from '../../services/project/cachePublishStatus.js';
import { bindEquipmentPresentation } from '../../features/equipment/presentation/equipmentPresentationPort.js';
import { createEquipmentProjectPresentation } from '../../ui/equipmentProjectView.js';
import * as shell_statusBar from '../../ui/shell/statusBar.js';
import { bind as bind_shell_statusBar } from '../../services/presentation/shell_statusBar.js';
import * as shell_projectBar from '../../ui/shell/projectBar.js';
import { bind as bind_shell_projectBar } from '../../services/presentation/shell_projectBar.js';
import * as dom from '../../ui/dom.js';
import { bind as bind_dom } from '../../services/presentation/dom.js';
import { bindProjectPresentation } from '../../services/presentation/projectPresentationPort.js';
import { projectPresentation } from '../../ui/projectPresentation.js';

export function configurePresentation(): void {
  bindProjectOpenPresentation(projectOpenPresentation);
  bindSelectionPresentation(selectionPresentation);
  bindDiagramPresentation(diagramPresentation);
  bindLinePresentation(linePresentation);
  bindLineModSourceReader(async (state, node) => {
    const scope = state.sessionScope(state.captureProjectSession());
    const { loadLineModSourcesForNode } = await scope.read(
      () => import('../../features/powerline/runtime/lineModRuntimeService.js'),
    );
    return scope.read(() => loadLineModSourcesForNode(state, node));
  });
  bindLoadingPresentation(loadingView);
  bindViewerPresentation(
    async () => (await import('../../ui/viewerPresentation.js')).viewerPresentation,
  );
  bindSourceInspectorPresentation({
    error: async (...args) =>
      (await import('../../ui/sourceInspectorPresentation.js')).sourceInspectorPresentation.error(
        ...args,
      ),
    document: async (input) =>
      (
        await import('../../ui/sourceInspectorPresentation.js')
      ).sourceInspectorPresentation.document(input),
    context: async (input) =>
      (await import('../../ui/sourceInspectorPresentation.js')).sourceInspectorPresentation.context(
        input,
      ),
  });
  bindEquipmentPresentation(createEquipmentProjectPresentation);
  if ('renderCachePublication' in shell_statusBar)
    bindPublicationView(shell_statusBar.renderCachePublication);
  bind_shell_statusBar(shell_statusBar);
  bind_shell_projectBar(shell_projectBar);
  bind_dom(dom);
  bindProjectPresentation(projectPresentation);
}
