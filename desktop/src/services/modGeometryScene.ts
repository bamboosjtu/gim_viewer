/** Owns the MOD and STL scene layer roots. */
import * as THREE from 'three';
import { freezeContainerLocalMatrix } from '../viewer/staticContainer.js';
import type { AppState } from '../app/state.js';

export function ensureGeometryLayer(
  state: AppState,
  scene: THREE.Scene,
  kind: 'mod' | 'stl',
): THREE.Group {
  const key = kind === 'mod' ? 'modRootGroup' : 'stlRootGroup';
  const existing = state[key];
  if (existing) return existing;
  const group = new THREE.Group();
  freezeContainerLocalMatrix(group);
  group.name = kind === 'mod' ? '__GIM_MOD_LAYER__' : '__GIM_STL_LAYER__';
  group.visible = true;
  scene.add(group);
  return (state[key] = group);
}

export function ensureGeometryLayers(
  state: AppState,
  scene: THREE.Scene,
): { modRoot: THREE.Group; stlRoot: THREE.Group } {
  return {
    modRoot: ensureGeometryLayer(state, scene, 'mod'),
    stlRoot: ensureGeometryLayer(state, scene, 'stl'),
  };
}
