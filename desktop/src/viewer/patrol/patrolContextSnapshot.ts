import { reportBackgroundError } from '../../utils/backgroundErrors.js';
import { Vector3 } from 'three';
import type { OrthoPerspectiveCamera } from '@thatopen/components';

export function capturePatrolCamera(camera: OrthoPerspectiveCamera) {
  const c = camera.controls,
    active = camera.three;
  return {
    projection: camera.projection.current,
    enabled: c.enabled,
    buttons: { ...c.mouseButtons },
    position: c.getPosition(new Vector3(), false),
    target: c.getTarget(new Vector3(), false),
    quaternion: active.quaternion.clone(),
    up: active.up.clone(),
    persp: {
      near: camera.threePersp.near,
      far: camera.threePersp.far,
      fov: camera.threePersp.fov,
      zoom: camera.threePersp.zoom,
    },
    ortho: {
      near: camera.threeOrtho.near,
      far: camera.threeOrtho.far,
      zoom: camera.threeOrtho.zoom,
    },
  };
}
export type PatrolContextSnapshot = ReturnType<typeof capturePatrolCamera>;
export function freezeOrbit(camera: OrthoPerspectiveCamera, s: PatrolContextSnapshot) {
  void Promise.resolve(
    camera.controls.setLookAt(...s.position.toArray(), ...s.target.toArray(), false),
  ).catch(reportBackgroundError);
  camera.controls.stop();
  camera.controls.update(0);
  camera.controls.enabled = false;
}
export async function restoreOrbit(
  camera: OrthoPerspectiveCamera,
  s: PatrolContextSnapshot,
  current: () => boolean,
) {
  if (!current()) return;
  await camera.projection.set(s.projection);
  if (!current()) return;
  Object.assign(camera.threePersp, s.persp);
  Object.assign(camera.threeOrtho, s.ortho);
  camera.threePersp.updateProjectionMatrix();
  camera.threeOrtho.updateProjectionMatrix();
  const c = camera.controls;
  camera.three.up.copy(s.up);
  c.updateCameraUp();
  await c.setLookAt(...s.position.toArray(), ...s.target.toArray(), false);
  if (!current()) return;
  await c.zoomTo(camera.three.zoom, false);
  if (!current()) return;
  c.update(0);
  camera.three.quaternion.copy(s.quaternion);
  camera.three.updateMatrixWorld();
  Object.assign(c.mouseButtons, s.buttons);
  c.enabled = s.enabled;
}
