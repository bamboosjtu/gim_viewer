import type * as THREE from 'three';
import type { AppState } from '../../app/state.js';
import { invalidGeometryBounds } from '../../viewer/geometryBounds.js';
import { addModHighlightGroup, removeModHighlightGroup } from '../../viewer/highlight.js';
import type { DeviceLod } from '../../viewer/devLodPolicy.js';
import type { Occurrence, TemplateRow } from './devLodTypes.js';

export const belongsTo = (object: THREE.Object3D, root?: THREE.Object3D) => {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent)
    if (parent === root) return true;
  return false;
};

/** Prepare the replacement before changing scene ownership or selection. */
export function prepareDevPlacement(
  row: Occurrence,
  template: TemplateRow,
  lod: DeviceLod,
  anchor: THREE.Matrix4 | null,
): { group: THREE.Group; worldBounds: THREE.Box3 } {
  const group = template.template.createPlacement({
    rootOccurrence: row.entry.rootOccurrence,
    instanceKey: row.entry.instanceKey,
    placementMatrix: row.entry.placementMatrix,
    projectSourceToViewerMatrix: anchor,
  });
  const worldBounds = template.bounds.clone().applyMatrix4(group.matrix);
  const invalidPlacement = invalidGeometryBounds(worldBounds);
  if (invalidPlacement) {
    group.clear();
    throw Error(`DEV placement rejected: ${row.entry.rootOccurrence}: ${invalidPlacement}`);
  }
  group.userData.deviceLod = lod;
  group.name = row.entry.instanceKey;
  return { group, worldBounds };
}

interface HighlightScope {
  devPath: unknown;
  assemblyPath: unknown;
  referencePath: unknown;
}

export function detachDevPlacementHighlights(
  state: AppState,
  row: Occurrence,
): Array<HighlightScope | null> {
  const highlighted =
    state.selection.highlightedModState?.groups.filter((object) => belongsTo(object, row.group)) ??
    [];
  const highlightScopes = highlighted.map((object) =>
    object === row.group
      ? null
      : {
          devPath: object.userData.devPath as unknown,
          assemblyPath: object.userData.assemblyPath as unknown,
          referencePath: object.userData.referencePath as unknown,
        },
  );
  for (const object of highlighted) removeModHighlightGroup(state, object);
  return highlightScopes;
}

export function restoreDevPlacementHighlights(
  state: AppState,
  group: THREE.Group,
  highlightScopes: Array<HighlightScope | null>,
): void {
  if (highlightScopes.length && !state.selection.representationSelection) {
    const replacements: THREE.Object3D[] = [];
    group.traverse((object) => {
      if (replacements.some((parent) => belongsTo(object, parent))) return;
      if (
        highlightScopes.some((scope) =>
          scope
            ? Object.entries(scope).every(([field, value]) => object.userData[field] === value)
            : object === group,
        )
      )
        replacements.push(object);
    });
    replacements.forEach((object) => addModHighlightGroup(state, object));
  }
}
