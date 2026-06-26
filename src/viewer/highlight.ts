import * as OBC from '@thatopen/components';
import * as OBCF from '@thatopen/fragments';
import * as THREE from 'three';
import type { ViewerContext } from './viewerEngine.js';
import type { AppState } from '../app/state.js';
import { collectIfcRefs } from '../gim/cbmParser.js';
import { getNodeDisplayName } from '../gim/gimIndexer.js';
import { frameBox } from './camera.js';
import { DEBUG_IFC_LOAD } from '../config/debug.js';
import { debugLog } from '../utils/logger.js';

/** 高亮样式 */
export const HIGHLIGHT_STYLE: OBCF.MaterialDefinition = {
  color: new THREE.Color(0x00ccff),
  renderedFaces: OBCF.RenderedFaces.TWO,
  opacity: 0.6,
  transparent: true,
};

/** 重置当前高亮 */
export async function resetHighlight(ctx: ViewerContext, state: AppState): Promise<void> {
  if (state.highlightedItems) {
    await ctx.fragments.resetHighlight(state.highlightedItems as any);
    state.highlightedItems = null;
  }
}

/** 从 CbmNode 高亮对应的 IFC 构件 */
export async function highlightIfcFromNode(
  ctx: ViewerContext,
  state: AppState,
  node: import('../gim/types.js').CbmNode,
  showMessage: (text: string) => void,
): Promise<void> {
  const refs = collectIfcRefs(node);

  if (refs.size > 0) {
    await resetHighlight(ctx, state);
    const items: OBC.ModelIdMap = {};
    let totalHighlighted = 0;
    const highlightBoxes: THREE.Box3[] = [];

    for (const [modelId, guids] of refs) {
      const model = ctx.fragments.list.get(modelId);
      if (!model) {
        debugLog(DEBUG_IFC_LOAD, `模型 ${modelId} 未加载，跳过 ${guids.size} 个 GUID`);
        continue;
      }
      try {
        const localIds = await model.getLocalIdsByGuids(Array.from(guids));
        const validIds = localIds.filter((id): id is number => id !== null);
        if (validIds.length > 0) {
          items[modelId] = new Set(validIds);
          totalHighlighted += validIds.length;
          try {
            const box = await model.getMergedBox(validIds);
            if (box && !box.isEmpty()) highlightBoxes.push(box);
          } catch { /* 包围盒获取失败 */ }
        } else {
          debugLog(DEBUG_IFC_LOAD, `模型 ${modelId} 中未找到匹配的 GUID (尝试了 ${guids.size} 个)`);
        }
      } catch (err) {
        console.warn(`GUID 转换失败 (${modelId}):`, err);
      }
    }

    if (Object.keys(items).length > 0) {
      await ctx.fragments.highlight(HIGHLIGHT_STYLE, items as any);
      state.highlightedItems = items as any;
      debugLog(DEBUG_IFC_LOAD, `已高亮 ${totalHighlighted} 个 IFC 构件`);
      if (highlightBoxes.length > 0) {
        const unionBox = highlightBoxes.reduce((acc, b) => acc.union(b), highlightBoxes[0].clone());
        await frameBox(ctx, unionBox);
      }
      return;
    }
  }

  // 回退：无 IFCGUID
  const cbmFileName = node.path.split('/').pop() || '';
  const ifcModelId = node.ifcFile ? node.ifcFile.replace(/\.ifc$/i, '') : state.deviceToIfcFile.get(cbmFileName);
  if (ifcModelId) {
    const loaded = ctx.fragments.list.has(ifcModelId);
    if (loaded) {
      showMessage(`设备 "${getNodeDisplayName(node, state.ifcGuidToName)}" 属于 ${ifcModelId}.ifc，但无 IFCGUID 映射到具体构件`);
    } else {
      showMessage(`设备 "${getNodeDisplayName(node, state.ifcGuidToName)}" 属于 ${ifcModelId}.ifc，该 IFC 文件未加载`);
    }
  } else {
    showMessage(`设备 "${getNodeDisplayName(node, state.ifcGuidToName)}" 无 IFC 关联`);
  }
}
