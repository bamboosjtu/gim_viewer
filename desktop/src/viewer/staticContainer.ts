import type { Object3D } from 'three';

/** Scene/layer containers have fixed local transforms. Keep world updates enabled:
 * children, reparenting and explicit coordinate-anchor updates must still work.
 * A later local TRS edit on this container requires updateMatrix() explicitly. */
export function freezeContainerLocalMatrix(container: Object3D): void {
  if (container.matrixAutoUpdate) container.updateMatrix();
  container.matrixAutoUpdate = false;
}
