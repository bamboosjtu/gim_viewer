import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { pickVisibleDevRoot } from '../devViewportPick.js';

function placement(rootOccurrence: string, instanceKey: string, x: number, visible = true) {
  const group = new THREE.Group();
  group.userData.rootOccurrence = rootOccurrence;
  group.userData.instanceKey = instanceKey;
  group.position.x = x;
  group.visible = visible;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  group.add(mesh);
  group.updateMatrixWorld(true);
  return group;
}
const ray = () => new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));

describe('pickVisibleDevRoot', () => {
  it('returns the nearest visible DEV placement with its occurrence identity', () => {
    const near = placement('root/near', 'dev:near', 0);
    const far = placement('root/far', 'dev:far', 0);
    far.position.z = -5; far.updateMatrixWorld(true);
    const hit = pickVisibleDevRoot(ray(), [
      { rootOccurrence: 'root/near', instanceKey: 'dev:near', group: near },
      { rootOccurrence: 'root/far', instanceKey: 'dev:far', group: far },
    ]);
    expect(hit).toMatchObject({ rootOccurrence: 'root/near', instanceKey: 'dev:near' });
    expect(hit!.distance).toBeGreaterThan(0);
  });

  it('skips hidden groups and rows without identity', () => {
    const hidden = placement('root/hidden', 'dev:hidden', 0, false);
    const missing = placement('', '', 0);
    const visible = placement('root/visible', 'dev:visible', 4);
    visible.position.set(4, 0, 0); visible.updateMatrixWorld(true);
    const sideRay = new THREE.Raycaster(new THREE.Vector3(4, 0, 10), new THREE.Vector3(0, 0, -1));
    expect(pickVisibleDevRoot(ray(), [
      { rootOccurrence: 'root/hidden', instanceKey: 'dev:hidden', group: hidden },
      { rootOccurrence: '', instanceKey: '', group: missing },
    ])).toBeNull();
    expect(pickVisibleDevRoot(sideRay, [
      { rootOccurrence: 'root/hidden', instanceKey: 'dev:hidden', group: hidden },
      { rootOccurrence: 'root/visible', instanceKey: 'dev:visible', group: visible },
    ])).toMatchObject({ rootOccurrence: 'root/visible', instanceKey: 'dev:visible' });
  });
});
