import { it, expect, vi } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import type { OrthoPerspectiveCamera } from '@thatopen/components';
import { capturePatrolCamera, freezeOrbit, restoreOrbit } from '../patrolContextSnapshot.js';
it('restores the captured orbit and refuses a superseded projection restore', async () => {
  const persp = new PerspectiveCamera(),
    ortho = new OrthographicCamera();
  const c = {
    getPosition: (v: Vector3) => v.set(1, 2, 3),
    getTarget: (v: Vector3) => v.set(4, 5, 6),
    mouseButtons: { left: 1 },
    setLookAt: vi.fn(),
    stop: vi.fn(),
    update: vi.fn(),
    updateCameraUp: vi.fn(),
    zoomTo: vi.fn(),
    enabled: true,
  };
  const set = vi.fn(async () => {}),
    camera = {
      controls: c,
      three: persp,
      threePersp: persp,
      threeOrtho: ortho,
      projection: { current: 'Perspective', set },
    } as unknown as OrthoPerspectiveCamera;
  const snap = capturePatrolCamera(camera);
  freezeOrbit(camera, snap);
  expect(c.enabled).toBe(false);
  let live = true;
  set.mockImplementationOnce(async () => {
    live = false;
  });
  await restoreOrbit(camera, snap, () => live);
  expect(c.enabled).toBe(false);
  expect(c.zoomTo).not.toHaveBeenCalled();
  persp.fov = 10;
  c.mouseButtons.left = 4;
  await restoreOrbit(camera, snap, () => true);
  expect(persp.fov).toBe(snap.persp.fov);
  expect(c.mouseButtons.left).toBe(1);
  expect(c.enabled).toBe(true);
});
