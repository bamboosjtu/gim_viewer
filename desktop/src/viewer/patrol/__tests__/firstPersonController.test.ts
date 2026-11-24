import { afterEach, expect, it, vi } from 'vitest';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { FirstPersonController } from '../firstPersonController.js';
import { ViewerNavigationCommands } from '../../../shared/viewerNavigationCommands.js';
import type { ViewerContext } from '../../viewerEngine.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
it('falls back to dragging, caps long-frame motion, and stops all walking input on pause', async () => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  canvas.requestPointerLock = vi.fn().mockRejectedValue(Error('denied'));
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const camera = new PerspectiveCamera(),
    commands = new ViewerNavigationCommands();
  const ctx = {
    world: { camera: { three: camera, threePersp: camera, controls: { enabled: true } } },
  } as unknown as ViewerContext;
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (next: FrameRequestCallback) => {
    frame = next;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frame = undefined;
  });
  const query = {
    prepare: async () => {},
    step: vi.fn((_from: Vector3, to: Vector3) => ({ feet: to, sourceId: 'test-floor' })),
  };
  const controller = new FirstPersonController(
    ctx,
    canvas,
    commands,
    query,
    new Matrix4(),
    new Vector3(),
    1,
    () => true,
    new AbortController().signal,
  );
  try {
    controller.takeCamera();
    controller.walk();
    await Promise.resolve();
    expect(commands.dragLook).toBe(true);
    expect(commands.mode).toBe('walking');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    frame!(performance.now() + 2000);
    expect(query.step).toHaveBeenCalledTimes(5);
    expect(controller.feet.length()).toBeCloseTo((1.45 * 5) / 60);
    commands.set('paused');
    controller.stop();
    expect(frame).toBeUndefined();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(frame).toBeUndefined();
    expect(camera.position.z - controller.feet.z).toBeCloseTo(1.68);
  } finally {
    controller.dispose();
  }
});
