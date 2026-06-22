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

/** MOD/STL 高亮颜色（与 IFC 高亮保持一致） */
const HIGHLIGHT_MOD_COLOR = new THREE.Color(0x00ccff);

/**
 * 重置 MOD/STL 高亮：恢复所有 mesh 的原始材质并 dispose clone。
 *
 * MOD 材质是共享的（_sharedMaterialCache），高亮时 clone 了材质，
 * reset 时必须恢复原始材质引用并 dispose clone，避免内存泄漏和
 * 影响其他使用同一共享材质的 mesh。
 */
export function resetModHighlight(state: AppState): void {
  if (!state.highlightedModState) return;
  const { originalMaterials } = state.highlightedModState;
  for (const [mesh, originalMat] of originalMaterials) {
    const current = mesh.material;
    if (current !== originalMat) {
      // dispose cloned highlight materials
      if (Array.isArray(current)) {
        current.forEach((m) => m.dispose());
      } else {
        (current as THREE.Material).dispose();
      }
    }
    mesh.material = originalMat;
  }
  state.highlightedModState = null;
}

/**
 * 高亮一组 MOD/STL Group：克隆每个 mesh 的材质并设置 emissive 发光。
 *
 * 设计要点：
 * - MOD 材质是共享的（MeshStandardMaterial from _sharedMaterialCache），
 *   必须 clone 后修改，不能直接改原材质
 * - STL 使用 MeshPhongMaterial，同样 clone 后修改
 * - 两种材质都有 emissive 属性，使用 emissive 发光作为高亮效果
 * - 保存原始材质引用到 state.highlightedModState，供 resetModHighlight 恢复
 */
export function highlightModGroups(
  state: AppState,
  groups: THREE.Group[],
): void {
  // 先重置已有高亮（恢复上一次高亮的 mesh 材质）
  resetModHighlight(state);

  if (groups.length === 0) return;

  const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

  for (const group of groups) {
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;

      // 保存原始材质引用
      originalMaterials.set(mesh, mesh.material);

      // 克隆材质并应用高亮
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const highlighted = mats.map((mat) => {
        const cloned = mat.clone();
        // MeshStandardMaterial / MeshPhongMaterial 都有 emissive
        if ('emissive' in cloned) {
          (cloned as THREE.MeshStandardMaterial).emissive = HIGHLIGHT_MOD_COLOR.clone();
          (cloned as THREE.MeshStandardMaterial).emissiveIntensity = 0.8;
        }
        cloned.transparent = true;
        cloned.opacity = 0.85;
        cloned.needsUpdate = true;
        return cloned;
      });
      mesh.material = highlighted.length === 1 ? highlighted[0] : highlighted;
    });
  }

  state.highlightedModState = { groups, originalMaterials };
}

/** 重置当前高亮（IFC + MOD） */
export async function resetHighlight(ctx: ViewerContext, state: AppState): Promise<void> {
  if (state.highlightedItems) {
    await ctx.fragments.resetHighlight(state.highlightedItems as any);
    state.highlightedItems = null;
  }
  resetModHighlight(state);
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
