/** Owns the MOD and STL scene layer roots. */
import * as THREE from 'three';
import { freezeContainerLocalMatrix } from '../viewer/staticContainer.js';
import type { AppState } from '../app/state.js';

/**
 * 确保 MOD/STL 图层根节点存在（挂在 scene 下，与 IFC 平级）。
 * 首次调用时创建，后续调用返回已有实例。
 */
export function ensureGeometryLayers(state: AppState, scene: THREE.Scene): { modRoot: THREE.Group; stlRoot: THREE.Group } {
  if (!state.modRootGroup) {
    state.modRootGroup = new THREE.Group();
    freezeContainerLocalMatrix(state.modRootGroup);
    state.modRootGroup.name = '__GIM_MOD_LAYER__';
    state.modRootGroup.visible = true;
    scene.add(state.modRootGroup);
  }
  if (!state.stlRootGroup) {
    state.stlRootGroup = new THREE.Group();
    freezeContainerLocalMatrix(state.stlRootGroup);
    state.stlRootGroup.name = '__GIM_STL_LAYER__';
    state.stlRootGroup.visible = true;
    scene.add(state.stlRootGroup);
  }
  return { modRoot: state.modRootGroup, stlRoot: state.stlRootGroup };
}
