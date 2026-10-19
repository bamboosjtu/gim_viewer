import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DevLodRuntime } from '../devLodRuntime.js';
import { DEV_GEOMETRY_VERSION } from '../devSpatialCatalog.js';
import { perfProductMomentSnapshot, perfReset } from '../../utils/perfTimings.js';

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
  expect(status.mock.lastCall![0]).toContain('几何实例已处理 3326/3326 · 已显示 3292');
  expect(status.mock.lastCall![0]).toContain('冷编译 L0 0/L1 0/L2 0 · 缓存命中 L0 0/L1 0/L2 0 · 失败 34');
  expect(status.mock.lastCall![0]).not.toContain('准备中');
  const row = internal.rows.get('3292'); row.group = new THREE.Group();
  internal.ready();
  expect(status.mock.lastCall![0]).toContain('几何实例已处理 3326/3326 · 已显示 3293');
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

it('commit queue yields between batches, prioritizes selection and cancels expired work', async () => {
  vi.useFakeTimers();
  try {
    const { internal } = fixture(); const calls: number[] = [];
    internal.cameraMovingUntil = performance.now() + 200;
    const background = internal.submit(2, () => calls.push(2));
    const selected = internal.submit(0, () => calls.push(0));
    await vi.advanceTimersByTimeAsync(16); await selected;
    expect(calls).toEqual([0]);
    internal.cameraMovingUntil = 0;
    await vi.advanceTimersByTimeAsync(16); await background;
    expect(calls).toEqual([0, 2]);
    internal.cameraMovingUntil = performance.now() + 200;
    const expired = internal.submit(2, () => calls.push(9));
    const rejected = expect(expired).rejects.toMatchObject({ name: 'AbortError' });
    internal.state.deviceUnknownBounds = new Map(); internal.ctx.world = { camera: {} };
    internal.release(); await rejected;
    await vi.advanceTimersByTimeAsync(300); expect(calls).toEqual([0, 2]);
  } finally { vi.useRealTimers(); }
});

it('current view readiness does not wait for the whole catalog', () => {
  const { runtime, internal } = fixture();
  internal.rows.set('root', occurrence(1));
  runtime.diagnostics.catalogReady = false;
  internal.ready();
  // 视图本身的 ready 仍不等目录；但状态栏不能在整个目录未就绪时宣称“已完成”。
  expect(runtime.diagnostics.currentViewReady).toBe(true);
  expect(runtime.diagnostics.currentViewSettled).toBe(false);
  expect(runtime.diagnostics.baseRepresentationsSettled).toBe(false);
  expect(internal.status.mock.lastCall![0]).toContain('设备范围索引准备中');
  runtime.diagnostics.catalogReady = true;
  internal.ready();
  expect(runtime.diagnostics.currentViewSettled).toBe(true);
  expect(internal.status.mock.lastCall![0]).toContain('当前视图已完成');
});it('records default DEV current-view and base-representation product moments', () => {
  perfReset(); const { internal } = fixture(); internal.rows.set('root', occurrence(1)); internal.ready();
  const moments = perfProductMomentSnapshot();
  expect(moments.devCurrentViewReady).not.toBeNull();
  expect(moments.devBaseRepresentationsSettled).not.toBeNull();
  expect(moments.devGeometryReady?.meta?.path).toBe('device-lod');
  expect(moments.devAllStationReady).toBeNull();
});

it('camera motion invalidates readiness until the new view has been evaluated', () => {
  vi.useFakeTimers();
  try {
    const { internal, runtime } = fixture(); internal.rows.set('root', occurrence(1));
    internal.ready(); expect(runtime.diagnostics.currentViewReady).toBe(true);
    internal.cameraSchedule(); internal.ready();
    expect(runtime.diagnostics.currentViewReady).toBe(false);
    expect(runtime.diagnostics.currentViewSettled).toBe(false);
    clearTimeout(internal.cameraTimer);
  } finally { vi.useRealTimers(); }
});

it('reports exact finished counts without pre-incrementing an unfinished station', () => {
  const { internal, status }=fixture(); const ready=occurrence(1), waiting=occurrence(2); waiting.group=undefined as any; waiting.key=undefined as any;
  internal.rows=new Map([['one',ready],['two',waiting]]);internal.ready();
  expect(status.mock.lastCall![0]).toContain('几何实例已处理 1/2');
});
