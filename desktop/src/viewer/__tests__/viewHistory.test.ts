import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import CameraControls from 'camera-controls';
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

it('returns to the last settled view when back is pressed before the debounce expires', async () => {
  vi.useFakeTimers();
  const { ctx, setPosition } = fixture();
  const history = new ViewerViewHistory(ctx);
  setPosition(new THREE.Vector3(10, 0, 0));
  expect(history.canGoBack).toBe(true);
  expect(await history.back()).toBe(true);
  expect(ctx.world.camera.controls.setLookAt).toHaveBeenLastCalledWith(1, 2, 3, 0, 0, 0, true);
  await vi.advanceTimersByTimeAsync(500);
  expect(history.canGoBack).toBe(false);
  history.dispose();
});

it('keeps the history entry and visibility when a camera restore fails, allowing retry', async () => {
  vi.useFakeTimers();
  const { ctx, controls, setPosition } = fixture();
  let visibility = 'all';
  const history = new ViewerViewHistory(ctx, 20, {
    getVisibility: () => visibility, setVisibility: value => { visibility = value; },
  });
  visibility = 'only-selected'; history.recordVisibility();
  controls.setLookAt.mockRejectedValueOnce(new Error('camera unavailable'));
  await expect(history.back()).rejects.toThrow('camera unavailable');
  expect(visibility).toBe('only-selected');
  expect(history.canGoBack).toBe(true);
  expect(await history.back()).toBe(true);
  expect(visibility).toBe('all');
  setPosition(new THREE.Vector3(20, 0, 0));
  history.dispose();
});

it('ignores a second back while restoring, and clear cancels a pending old-project restore', async () => {
  vi.useFakeTimers();
  const { ctx, controls, setPosition } = fixture();
  let finish!: () => void;
  const history = new ViewerViewHistory(ctx);
  setPosition(new THREE.Vector3(10, 0, 0)); await vi.advanceTimersByTimeAsync(220);
  controls.setLookAt.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const restoring = history.back();
  expect(history.canGoBack).toBe(false);
  expect(await history.back()).toBe(false);
  history.clear();
  expect(await restoring).toBe(false); // Does not depend on the old camera promise resolving.
  expect(controls.setLookAt).toHaveBeenLastCalledWith(10, 0, 0, 0, 0, 0, false);
  setPosition(new THREE.Vector3(100, 0, 0)); await vi.advanceTimersByTimeAsync(220);
  finish(); await Promise.resolve();
  expect(history.canGoBack).toBe(false);
  setPosition(new THREE.Vector3(200, 0, 0)); await vi.advanceTimersByTimeAsync(220);
  expect(await history.back()).toBe(true);
  expect(controls.setLookAt).toHaveBeenLastCalledWith(100, 0, 0, 0, 0, 0, true);
  history.dispose();
});

it('does not apply an old visibility filter when another navigation action supersedes back', async () => {
  vi.useFakeTimers();
  const { ctx, controls, setPosition } = fixture();
  let visibility = 'all', finish!: () => void;
  const history = new ViewerViewHistory(ctx, 20, {
    getVisibility: () => visibility, setVisibility: value => { visibility = value; },
  });
  visibility = 'only-selected'; history.recordVisibility();
  controls.setLookAt.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const restoring = history.back();
  setPosition(new THREE.Vector3(50, 0, 0)); finish();
  expect(await restoring).toBe(false);
  expect(visibility).toBe('only-selected');
  await vi.advanceTimersByTimeAsync(220);
  expect(await history.back()).toBe(true);
  expect(controls.setLookAt).toHaveBeenLastCalledWith(1, 2, 3, 0, 0, 0, true);
  expect(visibility).toBe('only-selected');
  history.dispose();
});

it('lets a manual camera gesture interrupt back without consuming history', async () => {
  vi.useFakeTimers();
  const { ctx, controls, setPosition } = fixture();
  const history = new ViewerViewHistory(ctx);
  setPosition(new THREE.Vector3(10, 0, 0)); await vi.advanceTimersByTimeAsync(220);
  controls.setLookAt.mockImplementationOnce(() => new Promise<void>(() => {}));
  const restoring = history.back();
  controls.dispatchEvent({ type: 'controlstart' });
  expect(await restoring).toBe(false);
  expect(history.canGoBack).toBe(true);
  history.dispose();
});

it('preserves a newer visibility action while an older camera restore completes', async () => {
  vi.useFakeTimers();
  const { ctx, controls, setPosition } = fixture();
  let visibility = 'only-selected', finish!: () => void;
  const history = new ViewerViewHistory(ctx, 20, {
    getVisibility: () => visibility, setVisibility: value => { visibility = value; history.recordVisibility(); },
  });
  setPosition(new THREE.Vector3(10, 0, 0)); await vi.advanceTimersByTimeAsync(220);
  const original = controls.setLookAt.getMockImplementation()!;
  controls.setLookAt.mockImplementationOnce(async (...args: number[]) => {
    await new Promise<void>(resolve => { finish = resolve; });
    return original(...args);
  });
  const restoring = history.back();
  visibility = 'all'; history.recordVisibility(); finish();
  expect(await restoring).toBe(false);
  expect(visibility).toBe('all');
  history.dispose();
});

it('bounds snapshots to twenty and ignores numerical round-off and disposed updates', async () => {
  vi.useFakeTimers();
  const { ctx, setPosition } = fixture();
  const history = new ViewerViewHistory(ctx);
  for (let i = 0; i < 25; i++) {
    setPosition(new THREE.Vector3(i * 10, 0, 0)); await vi.advanceTimersByTimeAsync(220);
  }
  let steps = 0; while (await history.back()) steps++;
  expect(steps).toBe(19);
  setPosition(new THREE.Vector3(50 + 1e-8, 0, 0)); await vi.advanceTimersByTimeAsync(220);
  expect(history.canGoBack).toBe(false);
  history.dispose();
  setPosition(new THREE.Vector3(999, 0, 0)); await vi.advanceTimersByTimeAsync(500);
  expect(history.canGoBack).toBe(false);
});

it('does not seed the next project with a cancelled animation update', async () => {
  vi.useFakeTimers();
  CameraControls.install({ THREE });
  const controls = new CameraControls(new THREE.PerspectiveCamera(), document.createElement('div'));
  await controls.setLookAt(10, 10, 10, 0, 0, 0, false); controls.update(1 / 60);
  const history = new ViewerViewHistory({ world: { camera: { controls } } } as any);
  await controls.setLookAt(20, 20, 20, 10, 0, 0, false); controls.update(1 / 60);
  await vi.advanceTimersByTimeAsync(220);
  const pending = history.back(); controls.update(1 / 60);
  history.clear(); expect(await pending).toBe(false);
  for (let i = 0; i < 120; i++) controls.update(1 / 60);
  await vi.advanceTimersByTimeAsync(300);
  await controls.setLookAt(100, 100, 100, 50, 0, 0, false); controls.update(1 / 60);
  await vi.advanceTimersByTimeAsync(300);
  expect(history.canGoBack).toBe(false);
  history.dispose(); controls.dispose();
});
