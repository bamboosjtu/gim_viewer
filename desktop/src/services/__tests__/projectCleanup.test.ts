/**
 * projectCleanupService 竞态修复单测（P1 评审）。
 *
 * 验证：清理开始时同步递增 geometryLoadToken，
 * 使在途几何任务（渐进 GLB / MOD 自动加载）立即失效。
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { cleanupBeforeOpenNewProject } from '../projectCleanupService.js';
import { perfMemorySnapshot, perfRuntimeResourceSnapshot } from '../../utils/perfTimings.js';

// mock 掉重依赖的动态导入目标，避免 jsdom 下加载 three/maplibre 链路
vi.mock('../ui/lineProjectView.js', () => ({ destroyLineMapView: vi.fn() }));
vi.mock('../viewer/viewerRuntime.js', () => ({
  isViewerRuntimeCreated: vi.fn(() => false),
  getViewerRuntime: vi.fn(),
}));
vi.mock('../ui/sldView.js', () => ({ clearSldView: vi.fn() }));
vi.mock('../ui/tabs.js', () => ({ showAllTabs: vi.fn() }));

describe('cleanupBeforeOpenNewProject（P1 竞态修复）', () => {
  it('清理开始即递增 geometryLoadToken（在任何异步操作前）', async () => {
    const state = new AppState();
    state.geometryLoadToken = 41;

    const promise = cleanupBeforeOpenNewProject(state);
    // 关键断言：token 递增发生在函数同步前缀中——调用后立即可观测，
    // 无需等待内部任何 await 完成。在途任务持有旧 token=41 即失效。
    expect(state.geometryLoadToken).toBe(42);

    await promise;
    expect(state.geometryLoadToken).toBe(42);
  });

  it('连续两次清理 token 连续递增', async () => {
    const state = new AppState();
    state.geometryLoadToken = 0;
    await cleanupBeforeOpenNewProject(state);
    await cleanupBeforeOpenNewProject(state);
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

      await cleanupBeforeOpenNewProject(state);
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

      await cleanupBeforeOpenNewProject(state);
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
