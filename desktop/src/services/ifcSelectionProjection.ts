import { logger } from '../utils/logger.js';
import type { AppState, SelectionRequest } from '../app/state.js';
import type { CbmNode } from '../gim/types.js';
import type { ViewerContext } from '../viewer/viewerEngine.js';
import { collectIfcRefs } from '../gim/cbmParser.js';
import { resolveIfcModelId } from '../gim/modelIdentity.js';
import { getNodeDisplayName } from '../shared/displayName.js';

/** Source ownership is resolved before handing readonly rendering addresses to Viewer. */
export async function projectNodeIfcSelection(
  ctx: ViewerContext,
  state: AppState,
  node: CbmNode,
  request: SelectionRequest,
): Promise<{
  items: Readonly<Record<string, readonly number[]>>;
  emptyMessage: string;
}> {
  const items: Record<string, number[]> = {},
    guard = state.selectionGuard(request);
  for (const [modelId, guids] of collectIfcRefs(node, state.currentIfcEntries)) {
    if (!guard.isCurrent()) return { items: {}, emptyMessage: '' };
    const runtimeId = state.getRuntimeModelId(modelId),
      model = ctx.fragments.list.get(runtimeId);
    if (!model) continue;
    try {
      const ids = await model.getLocalIdsByGuids([...guids]);
      if (!guard.isCurrent()) return { items: {}, emptyMessage: '' };
      const valid = ids.filter((id): id is number => id !== null);
      if (valid.length) items[runtimeId] = valid;
    } catch (error) {
      logger.warn('[IFC selection projection] GUID 转换失败:', modelId, error);
    }
  }
  const modelId = node.ifcFile
    ? resolveIfcModelId(node.ifcFile, state.currentIfcEntries)
    : state.deviceToIfcFile.get(node.path.split(/[\\/]/).pop() ?? '');
  const label = getNodeDisplayName(node, state.ifcGuidToName, state.currentIfcEntries);
  if (!modelId) return { items, emptyMessage: `设备 "${label}" 无 IFC 关联` };
  const modelName =
    state.currentIfcEntries.find((entry) => entry.modelId === modelId)?.name || 'IFC 模型';
  const detail = ctx.fragments.list.has(state.getRuntimeModelId(modelId))
    ? '但无 IFCGUID 映射到具体构件'
    : '该 IFC 文件未加载';
  return { items, emptyMessage: `设备 "${label}" 属于 ${modelName}，${detail}` };
}
