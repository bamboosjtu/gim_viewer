import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DevLodRuntime } from '../devLodRuntime.js';
import { DEV_GEOMETRY_VERSION } from '../devSpatialCatalog.js';

function fixture() {
  const status = vi.fn();
  const state = { isCurrentSession: () => true, loadedXmlModGroups: new Map(), geometryDiagnostics: new Map() } as any;
  const runtime = new DevLodRuntime(state, {} as any, { sourceSha256: 'sha', generation: 1 } as any, status);
  Object.assign(runtime.diagnostics, { anchorReady: true, catalogReady: true });
  return { runtime, internal: runtime as any, status };
}
function occurrence(id: number, failed = false) {
  const devPath = `DEV/${id}.dev`, key = `${DEV_GEOMETRY_VERSION}|sha|${devPath.toLowerCase()}|lod0`;
  return { entry: { devPath, templateStatus: failed ? 'failed' : 'ready' }, inView: true,
    desired: 0, displayed: 0, key: failed ? undefined : key,
    failedKey: failed ? key : undefined, group: failed ? undefined : new THREE.Group() };
}
it('3326 processed includes 34 failures without reporting success or counting an existing coarse group twice', () => {
  const { runtime, internal, status } = fixture();
  internal.rows = new Map(Array.from({ length: 3326 }, (_, i) => [String(i), occurrence(i, i >= 3292)]));
  internal.ready();
  expect(runtime.diagnostics.currentViewSettled).toBe(true);
  expect(runtime.diagnostics.baseRepresentationsSettled).toBe(true);
  expect(runtime.diagnostics.currentViewReady).toBe(false);
  expect(runtime.diagnostics.baseRepresentationsReady).toBe(false);
  expect(runtime.diagnostics.allStationReady).toBe(false);
  expect(status.mock.lastCall![0]).toContain('设备已处理 3326/3326 · 已显示 3292 · 失败 34');
  expect(status.mock.lastCall![0]).not.toContain('准备中');
  const row = internal.rows.get('3292'); row.group = new THREE.Group();
  internal.ready();
  expect(status.mock.lastCall![0]).toContain('设备已处理 3326/3326 · 已显示 3293 · 失败 34');
});
it('late failures cannot poison a newer LOD request; explicit selection retries a transient failure', async () => {
  const { runtime, internal } = fixture();
  const row = occurrence(1, true); row.desired = 2;
  internal.rows.set('root', row);
  internal.failed(row, Error('old LOD0 failure'), row.failedKey);
  expect(row.failedKey).toContain('lod0');
  internal.render = vi.fn(async () => {
    expect(row.failedKey).toBeUndefined();
    row.group = new THREE.Group(); row.entry.templateStatus = 'ready';
    row.key = `${DEV_GEOMETRY_VERSION}|sha|dev/1.dev|lod2`;
    internal.ready();
  });
  internal.anchor = new THREE.Matrix4();
  expect(await runtime.select('root')).toEqual([row.group]);
  expect(runtime.diagnostics.currentViewReady).toBe(true);
  expect(runtime.diagnostics.failedOccurrences).toBe(0);
});
