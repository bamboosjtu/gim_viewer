import { buildCbmNodeIndex } from '../../../gim/cbmParser.js';
import { startGeometryOnlyView } from '../../../services/dev-geometry/geometryOnlyRuntime.js';
import { showLoading, type GimRuntimeOpenContext } from '../../../services/project/gimOpenCore.js';
import { perfCurrentSession, perfMarkProductMoment } from '../../../utils/perfTimings.js';
import {
  equipmentPresentationFor,
  type EquipmentPresentationPort,
} from '../presentation/equipmentPresentationPort.js';
import { createEquipmentSelection } from '../presentation/equipmentSelection.js';
import { loadEquipmentSource } from '../runtime/equipmentSource.js';

export async function openEquipmentProject(
  context: GimRuntimeOpenContext,
  presentation?: EquipmentPresentationPort,
): Promise<void> {
  const { state, session, showMessage } = context;
  const scope = state.sessionScope(session);
  if (!scope.isCurrent()) return;
  const perfSession = perfCurrentSession();
  let releaseNavigation: (() => void) | undefined;
  try {
    const source = await scope.read(() => context.getExtracted());
    if (!scope.isCurrent() || source.status === 'cancelled') return;
    showLoading('正在解析设备模型...');
    const { files, tree } = await scope.read(() => loadEquipmentSource(source.files, scope));
    if (
      !scope.withSession(() => {
        state.currentProjectType = 'equipment';
        state.currentFiles = files;
        state.substationEntryPaths = [...files.keys()];
        state.substationEntrySizes = new Map([...files].map(([path, file]) => [path, file.size]));
        state.currentCbmTree = tree;
        state.cbmNodeIndex = buildCbmNodeIndex(tree);
        state.ifcLoading.pending = false;
        const port = presentation ?? equipmentPresentationFor(state);
        releaseNavigation = scope.own(
          port.navigation({
            name: context.projectName || tree.name,
            tree,
            onSelect: createEquipmentSelection(state, scope, showMessage),
            signal: scope.signal,
          }),
        );
        if (scope.isCurrent()) {
          perfMarkProductMoment(
            'coreSemanticReady',
            {
              kind: 'equipment',
              cbmNodes: state.cbmNodeIndex.size,
            },
            perfSession,
          );
          perfMarkProductMoment(
            'navigationUiReady',
            { kind: 'equipment', scope: 'navigation-dom' },
            perfSession,
          );
        }
      })
    )
      return;
    await startGeometryOnlyView(context);
  } catch (error) {
    releaseNavigation?.();
    if (scope.isCurrent()) throw error;
  }
}
