/**
 * projectCleanupService 竞态修复单测（P1 评审）。
 *
 * 验证：清理开始时同步递增 geometryLoadToken，
 * 使在途几何任务（渐进 GLB / MOD 自动加载）立即失效。
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../state.js';
import { cleanupProject } from '../projectLifecycle.js';
import { perfMemorySnapshot, perfRuntimeResourceSnapshot } from '../../../utils/perfTimings.js';
import { setStatusRight } from '../../../ui/shell/statusBar.js';
import { setProjectIdentity } from '../../../ui/shell/projectBar.js';
import { getViewerRuntime, isViewerRuntimeCreated } from '../../../viewer/viewerRuntime.js';

// mock 掉重依赖的动态导入目标，避免 jsdom 下加载 three/maplibre 链路
vi.mock('../../../viewer/viewerRuntime.js', () => ({
  isViewerRuntimeCreated: vi.fn(() => false),
  getViewerRuntime: vi.fn(),
}));
vi.mock('../../../ui/sldView.js', () => ({ clearSldView: vi.fn() }));
vi.mock('../../../ui/tabs.js', () => ({ showAllTabs: vi.fn() }));

describe('cleanupProject（P1 竞态修复）', () => {
  it('waits for an admitted Viewer disposal before switching and emits only the latest close result', async () => {
    const state = new AppState();
    const old = state.activateProject(1, 'old');
    const scene = new THREE.Scene();
    const list = new Map([['old', {}]]);
    let finishDispose!: () => void;
    const held = new Promise<void>((resolve) => { finishDispose = resolve; });
    const disposeModel = vi.fn(async (id: string) => {
      await held;
      list.delete(id);
    });
    const ctx = { world: { scene: { three: scene } }, fragments: { initialized: true, list, core: { disposeModel } } };
    vi.mocked(isViewerRuntimeCreated).mockReturnValue(true);
    vi.mocked(getViewerRuntime).mockResolvedValue({ ctx } as unknown as Awaited<ReturnType<typeof getViewerRuntime>>);
    const closed = vi.fn();
    window.addEventListener('gim:project-closed', closed);
    try {
      const closing = cleanupProject(state);
      expect(state.isCurrentSession(old)).toBe(false);
      expect(state.sessionScope(state.captureProjectSession()).signal.aborted).toBe(true);
      await expect.poll(() => disposeModel.mock.calls.length, { timeout: 4_000 }).toBe(1);
      const replacement = cleanupProject(state, state.projectGeneration);
      await Promise.resolve();
      expect(disposeModel).toHaveBeenCalledTimes(1);
      finishDispose();
      await expect(closing).resolves.toBe(false);
      await expect(replacement).resolves.toBe(true);
      expect(closed).not.toHaveBeenCalled();
      expect(disposeModel).toHaveBeenCalledTimes(1);
      expect(state.isCurrentSession(state.captureProjectSession())).toBe(false);
      const next = state.activateProject(2, 'new');
      expect(state.isCurrentSession(next)).toBe(true);
    } finally {
      finishDispose();
      window.removeEventListener('gim:project-closed', closed);
      vi.mocked(isViewerRuntimeCreated).mockReturnValue(false);
      vi.mocked(getViewerRuntime).mockReset();
    }
  });

  it('未初始化 IFC 的设备视图仍完整释放 DEV 场景并记录资源归零', async () => {
    const state = new AppState(), scene = new THREE.Scene(), root = new THREE.Group();
    const geometry = new THREE.BoxGeometry(), dispose = vi.spyOn(geometry, 'dispose');
    root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    scene.add(root);
    state.currentProjectType = 'equipment';
    state.initialized = true;
    state.modRootGroup = root;
    const ctx = {
      world: { scene: { three: scene } },
      fragments: {
        initialized: false,
        get list() { throw new Error('FragmentsManager not initialized'); },
        get core() { throw new Error('FragmentsManager not initialized'); },
      },
    };
    vi.mocked(isViewerRuntimeCreated).mockReturnValueOnce(true);
    vi.mocked(getViewerRuntime).mockResolvedValueOnce({ ctx } as any);
    expect(await cleanupProject(state)).toBe(true);
    expect(root.parent).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(state.modRootGroup).toBeNull();
    expect(perfRuntimeResourceSnapshot().find((item) => item.label === 'beforeCleanup')?.fragmentModelCount).toBe(0);
  });

  it('清理线路后重置工程导航与状态栏，避免残留线路统计', async () => {
    document.body.innerHTML = `
      <div id="project-title"></div>
      <div id="project-type-badge"></div>
      <div id="navigator-title"></div>
      <div id="status-right"></div>
    `;
    setProjectIdentity('线路工程', 'transmission_line');
    setStatusRight('129 杆塔 · 2232 导线段 · 44 跨越物');

    await cleanupProject(new AppState());

    expect(document.getElementById('project-title')?.textContent).toBe('未打开工程');
    expect(document.getElementById('project-type-badge')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('navigator-title')?.textContent).toBe('模型导航');
    expect(document.getElementById('status-right')?.textContent).toBe('');
  });

  it('清理开始即递增 geometryLoadToken（在任何异步操作前）', async () => {
    const state = new AppState();
    const before = state.geometryLoadToken;

    const promise = cleanupProject(state);
    // 关键断言：token 递增发生在函数同步前缀中——调用后立即可观测，
    // 无需等待内部任何 await 完成。在途任务持有旧 token=41 即失效。
    expect(state.geometryLoadToken).toBe(before + 1);

    await promise;
    expect(state.geometryLoadToken).toBe(before + 1);
  });

  it('连续两次清理 token 连续递增', async () => {
    const state = new AppState();
    await cleanupProject(state);
    await cleanupProject(state);
    expect(state.geometryLoadToken).toBe(2);
  });

  it('变电清理记录前后 ownership checkpoint，稳定窗口确认逻辑资源归零', async () => {
    vi.useFakeTimers();
    try {
      const state = new AppState();
      state.currentProjectType = 'substation';
      state.currentIfcEntries = [{ name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'a' }];
      state.loadedXmlModGroups.set('dev:a', new THREE.Group());
      state.loadedStlGroups.set('stl:a', new THREE.Group());
      state.geometryDiagnosticsByDevPath.set('dev/a', {
        devPath: 'DEV/a.dev',
        status: 'empty',
        source: 'warm',
        unsupportedPrimitiveTypeCounts: {},
      });

      await cleanupProject(state);
      expect(perfRuntimeResourceSnapshot().map((item) => item.label)).toEqual([
        'beforeCleanup', 'afterCleanup',
      ]);
      expect(perfRuntimeResourceSnapshot().find((item) => item.label === 'beforeCleanup'))
        .toMatchObject({ loadedXmlModGroupCount: 1, loadedStlGroupCount: 1 });
      expect(perfRuntimeResourceSnapshot().find((item) => item.label === 'afterCleanup'))
        .toMatchObject({ loadedXmlModGroupCount: 0, loadedStlGroupCount: 0, templateCount: 0 });
      expect(state.geometryDiagnosticsByDevPath.size).toBe(0);

      vi.advanceTimersByTime(250);
      await Promise.resolve();
      expect(perfRuntimeResourceSnapshot().map((item) => item.label)).toEqual([
        'beforeCleanup', 'afterCleanup', 'settledAfterCleanup',
      ]);
      expect(perfMemorySnapshot().map((item) => item.label)).toEqual([
        'beforeCleanup', 'afterCleanup', 'settledAfterCleanup',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('工程切换后不提交旧工程的 delayed settled checkpoint', async () => {
    vi.useFakeTimers();
    try {
      const state = new AppState();
      state.currentProjectType = 'substation';
      state.currentIfcEntries = [{ name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'a' }];

      await cleanupProject(state);
      expect(perfRuntimeResourceSnapshot().map((item) => item.label)).toEqual([
        'beforeCleanup', 'afterCleanup',
      ]);

      // 这模拟 cleanup 已为 A 安排稳定窗口，但 B 已经成为当前工程。
      // generation guard 应使 A 的 delayed callback 直接退出。
      state.activateProject(2, 'sha-b');
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      expect(perfRuntimeResourceSnapshot().map((item) => item.label)).toEqual([
        'beforeCleanup', 'afterCleanup',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
