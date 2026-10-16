import { expect, it, vi } from 'vitest';
const maps = vi.hoisted(() => [] as any[]);
vi.mock('maplibre-gl', () => ({
  Map: class {
    remove = vi.fn();
    on = vi.fn(); off = vi.fn(); once = vi.fn(); addControl = vi.fn();
    constructor() { maps.push(this); }
  },
  ScaleControl: class {},
}));
import { createMapLibreProbe } from '../lineMapBaseLayer.js';

it('cancels a map that has mounted but never emits load, removing the pending DOM', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const controller = new AbortController();
  const pending = createMapLibreProbe(container, { signal: controller.signal, basemapMode: 'empty' });
  await vi.waitFor(() => expect(container.children.length).toBe(1));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(container.children.length).toBe(0);
  expect(maps[maps.length - 1].remove).toHaveBeenCalledOnce();
  container.remove();
});
it('an expired session cannot mount a new map', async () => {
  const container = document.createElement('div'), controller = new AbortController(); controller.abort();
  const count = maps.length;
  await expect(createMapLibreProbe(container, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(maps.length).toBe(count); expect(container.children.length).toBe(0);
});
