import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ViewerViewHistory } from '../viewHistory.js';

function fixture() {
  const controls = new THREE.EventDispatcher() as any;
  let position = new THREE.Vector3(1, 2, 3), target = new THREE.Vector3(0, 0, 0);
  controls.getPosition = () => position.clone();
  controls.getTarget = () => target.clone();
  controls.setLookAt = vi.fn(async (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
    position = new THREE.Vector3(px, py, pz); target = new THREE.Vector3(tx, ty, tz);
  });
  const ctx = { world: { camera: { controls } } } as any;
  return { ctx, controls, setPosition: (value: THREE.Vector3) => { position = value; controls.dispatchEvent({ type: 'update' }); } };
}

afterEach(() => { vi.useRealTimers(); });

it('records at most twenty settled camera states and returns to the previous state', async () => {
  vi.useFakeTimers();
  const { ctx, setPosition } = fixture();
  const history = new ViewerViewHistory(ctx);
  setPosition(new THREE.Vector3(10, 0, 0));
  await vi.advanceTimersByTimeAsync(220);
  expect(await history.back()).toBe(true);
  expect(ctx.world.camera.controls.setLookAt).toHaveBeenCalledWith(1, 2, 3, 0, 0, 0, true);
  history.clear();
  expect(await history.back()).toBe(false);
  history.dispose();
});

it('keeps the browser visibility filter in the same bounded history', async () => {
  vi.useFakeTimers();
  const { ctx, setPosition } = fixture();
  let visibility = 'all';
  const history = new ViewerViewHistory(ctx, 20, {
    getVisibility: () => visibility,
    setVisibility: (value) => { visibility = value; },
  });
  visibility = 'only-selected';
  history.recordVisibility();
  setPosition(new THREE.Vector3(10, 0, 0));
  await vi.advanceTimersByTimeAsync(220);
  expect(await history.back()).toBe(true);
  expect(await history.back()).toBe(true);
  expect(visibility).toBe('all');
  history.dispose();
});
