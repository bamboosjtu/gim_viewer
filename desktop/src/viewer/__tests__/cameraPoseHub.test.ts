import { EventDispatcher, PerspectiveCamera } from 'three';
import { it, expect, vi } from 'vitest';
import { CameraPoseHub } from '../cameraPoseHub.js';
import type { ViewerContext } from '../viewerEngine.js';

it('rejects revoked writers and publishes only effective changes, including projection', () => {
  const controls = new EventDispatcher<{ update: {} }>(),
    three = new PerspectiveCamera();
  const hub = new CameraPoseHub({ three, controls } as unknown as ViewerContext['world']['camera']);
  const listener = vi.fn(),
    off = hub.subscribe(listener);
  controls.dispatchEvent({ type: 'update' });
  controls.dispatchEvent({ type: 'update' });
  expect(listener).toHaveBeenCalledTimes(1);
  const orbit = hub.current,
    walk = hub.claim('patrol', 1),
    late = vi.fn();
  expect(hub.write(orbit, late)).toBe(false);
  expect(late).not.toHaveBeenCalled();
  hub.write(walk, () => {
    three.position.x = 2;
  });
  controls.dispatchEvent({ type: 'update' });
  expect(listener).toHaveBeenCalledTimes(2);
  three.zoom = 2;
  three.updateProjectionMatrix();
  hub.publish(walk);
  expect(listener.mock.lastCall?.[0]).toMatchObject({
    revision: 3,
    projectionRevision: 2,
    position: [2, 0, 0],
  });
  off();
  hub.claim('orbit', 2);
  expect(hub.write(walk, late)).toBe(false);
});
