import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { runProgressiveDevGlbPipeline } from '../progressiveGeometryService.js';
import { AppState } from '../../app/state.js';
import type { ProgressiveGeometryDependencies } from '../progressiveGeometryService.js';
import type { GeometryCacheManifestEntry } from '@desktop/database.js';
import type { CbmNode } from '../../gim/types.js';
import { isTauri } from '@desktop/runtime.js';

// jsdom 下 isTauri() 恒为 false；通过 mock 控制 Tauri/浏览器两种模式
vi.mock('@desktop/runtime.js', () => ({
  isTauri: vi.fn(() => false),
}));

/**
 * 构造最小 CBM 树：
 * root
 *  ├─ devA 实例 1（devPath=a.dev, 平移 z=+1000）
 *  ├─ devA 实例 2（同 devPath，平移 z=+2000）—— 验证同 DEV 只序列化一次
 *  └─ devB（devPath=b.dev）—— 验证序列化返回 null 时跳过
 */
function makeSeed(path: string, devPath: string, z: number): CbmNode {
  return {
    path,
    name: path,
    entityName: 'F4System',
    children: [],
    famPath: '',
    devPath,
    ifcFile: '',
    ifcGuid: '',
    classifyName: '',
    transformMatrix: `1,0,0,0,0,1,0,0,0,0,1,0,0,0,${z},1`,
    systemNames: [],
    devSymbolName: '',
    devType: '',
    devExpanded: false,
  };
}

function makeTree(): CbmNode {
  const a1 = makeSeed('CBM/a1.cbm', 'a.dev', 1000);
  const a2 = makeSeed('CBM/a2.cbm', 'a.dev', 2000);
  const b = makeSeed('CBM/b.cbm', 'b.dev', 3000);
  return {
    path: 'CBM/project.cbm',
    name: 'root',
    entityName: 'F1System',
    children: [a1, a2, b],
    famPath: '',
    devPath: '',
    ifcFile: '',
    ifcGuid: '',
    classifyName: '',
    transformMatrix: '',
    systemNames: [],
    devSymbolName: '',
    devType: '',
    devExpanded: false,
  };
}

function makeGroup(): THREE.Group {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
  return group;
}

interface DepsRecorder {
  serializeCalls: string[];
  writeCalls: string[];
  versionWrites: number;
  loadCalls: string[];
  manifestEntries?: GeometryCacheManifestEntry[][];
}

function makeDeps(opts: { serializeNullFor?: string[] } = {}, rec?: DepsRecorder): ProgressiveGeometryDependencies {
  const recorder = rec ?? { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
  return {
    serializeDevToGlb: vi.fn(async (devPath: string) => {
      recorder.serializeCalls.push(devPath);
      if (opts.serializeNullFor?.some((p) => devPath.includes(p))) return null;
      return new Uint8Array([1, 2, 3]);
    }),
    loadDevGlb: vi.fn(async (devPath: string) => {
      recorder.loadCalls.push(devPath);
      return makeGroup();
    }),
    writeGlbFile: vi.fn(async (_projectId: number, entryPath: string) => {
      recorder.writeCalls.push(entryPath);
    }),
    writeGeometryCacheVersion: vi.fn(async () => {
      recorder.versionWrites++;
    }),
    writeGeometryCacheManifest: vi.fn(async (_projectId: number, _sourceSha256: string, entries: GeometryCacheManifestEntry[]) => {
      recorder.manifestEntries?.push(entries);
    }),
    applyPlacementTransformToSceneUnits: vi.fn(() => {}),
    yieldToMain: vi.fn(async () => {}),
  };
}

function makeState(opts: { projectId?: number } = {}): AppState {
  const state = new AppState();
  state.currentFiles = new Map();
  state.currentCbmTree = makeTree();
  state.currentProjectId = opts.projectId ?? null;
  state.currentSourceSha256 = 'sha-test';
  state.geometryLoadToken = 1; // 与测试传入的 token 对齐（真实流程由调用方 ++ 后传入）
  return state;
}

describe('runProgressiveDevGlbPipeline', () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(false);
  });

  afterEach(() => {
    vi.mocked(isTauri).mockReturnValue(false);
  });

  it('同 DEV 多实例只序列化一次，逐实例渲染并注册 instanceKey', async () => {
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    const progress = vi.fn();
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), progress, { token: 1 }, makeDeps({}, rec));

    // a.dev 被 a1/a2 两个实例共享 → 只序列化一次
    expect(rec.serializeCalls).toEqual(['DEV/a.dev', 'DEV/b.dev']);
    // 渲染：a1 + a2 + b = 3 实例
    expect(result.renderedInstances).toBe(3);
    expect(result.compiledDevs).toBe(2);
    expect(result.interrupted).toBe(false);
    expect(rec.loadCalls).toHaveLength(3);
    // instanceKey 注册（键格式 dev:{devPath}#{seed.path}）
    expect(state.loadedXmlModGroups.has('dev:DEV/a.dev#CBM/a1.cbm')).toBe(true);
    expect(state.loadedXmlModGroups.has('dev:DEV/a.dev#CBM/a2.cbm')).toBe(true);
    // 进度回调：compiling 若干次 + done 一次
    const phases = progress.mock.calls.map((c) => c[0].phase);
    expect(phases[phases.length - 1]).toBe('done');
    const last = progress.mock.calls[progress.mock.calls.length - 1][0];
    expect(last.compiledDevs).toBe(2);
    expect(last.renderedInstances).toBe(3);
  });

  it('序列化返回 null（无几何）的 DEV 跳过渲染但计入编译数', async () => {
    const state = makeState({ projectId: 7 });
    const result = await runProgressiveDevGlbPipeline(
      state,
      new THREE.Scene(),
      vi.fn(),
      { token: 1 },
      makeDeps({ serializeNullFor: ['b.dev'] }),
    );
    expect(result.compiledDevs).toBe(2);
    expect(result.renderedInstances).toBe(2); // 仅 a1/a2
    expect(state.loadedXmlModGroups.has('DEV/b.dev#CBM/b.cbm')).toBe(false);
  });

  it('无 projectId（浏览器模式）跳过落盘与版本文件，仍渐进渲染', async () => {
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState(); // projectId = null
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, makeDeps({}, rec));

    expect(result.renderedInstances).toBe(3);
    expect(rec.writeCalls).toEqual([]); // 不落盘
    expect(rec.versionWrites).toBe(0); // 不写版本文件
  });

  it('token 不匹配时立即中断且不写版本文件', async () => {
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    state.geometryLoadToken = 5; // 与传入 token=1 不匹配
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, makeDeps({}, rec));

    expect(result.interrupted).toBe(true);
    expect(result.compiledDevs).toBe(0);
    expect(rec.versionWrites).toBe(0);
  });

  it('管线中途切换项目（token 失效）停止且不写版本标记', async () => {
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    // 自定义 yieldToMain：第一次 yield 后递增 token 模拟项目切换
    const deps = makeDeps({}, rec);
    let yields = 0;
    deps.yieldToMain = vi.fn(async () => {
      yields++;
      if (yields === 1) state.geometryLoadToken++;
    });
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, deps);

    expect(result.interrupted).toBe(true);
    expect(result.compiledDevs).toBe(1); // 第一个 DEV 编译完成后被中断
    expect(rec.versionWrites).toBe(0); // 中断不写版本 → 下次打开自动重编译
  });

  it('序列化抛错的 DEV 跳过且不阻断后续 DEV，但阻止版本标记提交（P1 评审）', async () => {
    vi.mocked(isTauri).mockReturnValue(true); // Tauri 模式验证版本文件写入
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    const deps = makeDeps({}, rec);
    deps.serializeDevToGlb = vi.fn(async (devPath: string) => {
      if (devPath.includes('a.dev')) throw new Error('export failed');
      rec.serializeCalls.push(devPath);
      return new Uint8Array([1]);
    });
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, deps);

    expect(result.compiledDevs).toBe(2);
    expect(result.renderedInstances).toBe(1); // 仅 b
    // P1 评审：存在无确定性结果的 DEV → 不写版本标记，
    // 避免「完成」掩盖缺失 GLB 导致二次打开静默丢几何
    expect(rec.versionWrites).toBe(0);
    expect(result.failedDevs).toEqual(['DEV/a.dev']);
  });

  it('落盘失败的 DEV 阻止版本标记提交但渲染照常（P1 评审）', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    const deps = makeDeps({}, rec);
    deps.writeGlbFile = vi.fn(async (_projectId: number, entryPath: string) => {
      if (entryPath.includes('a.dev')) throw new Error('disk full');
    });
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, deps);

    expect(result.renderedInstances).toBe(3); // 渲染不受影响
    expect(rec.versionWrites).toBe(0); // 缓存完整性受损 → 不提交完成标记
    expect(result.failedDevs).toEqual(['DEV/a.dev']);
  });

  it('全部 DEV 均为空几何（tombstone）时仍提交版本标记（P1 评审）', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [], manifestEntries: [] };
    const state = makeState({ projectId: 7 });
    const result = await runProgressiveDevGlbPipeline(
      state,
      new THREE.Scene(),
      vi.fn(),
      { token: 1 },
      makeDeps({ serializeNullFor: ['a.dev', 'b.dev'] }, rec),
    );

    // tombstone 是确定性结果：无几何也是有效缓存状态
    expect(rec.versionWrites).toBe(1);
    expect(result.failedDevs).toEqual([]);
    expect(rec.manifestEntries).toHaveLength(1);
    expect(rec.manifestEntries?.[0]).toEqual([
      { entry_path: 'DEV/a.dev', status: 'empty', size: 0 },
      { entry_path: 'DEV/b.dev', status: 'empty', size: 0 },
    ]);
  });

  it('管线开始时捕获 projectId 快照（P1 竞态：中途变更 state 不影响落盘目标）', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    const writtenProjectIds: number[] = [];
    const deps = makeDeps({}, rec);
    deps.writeGlbFile = vi.fn(async (projectId: number) => {
      writtenProjectIds.push(projectId);
      // 模拟异步间隙中用户切到新项目（state.currentProjectId 被改写）
      state.currentProjectId = 99;
    });
    await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, deps);

    // 所有落盘都使用管线启动时捕获的旧 projectId=7，而非被污染的 99
    expect(writtenProjectIds.every((id) => id === 7)).toBe(true);
  });

  it('Tauri 模式下逐 DEV 落盘并写版本标记', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [], manifestEntries: [] };
    const state = makeState({ projectId: 9 });
    await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, makeDeps({}, rec));

    // a.dev 序列化一次、落盘一次（多实例共享）
    expect(rec.writeCalls).toEqual(['DEV/a.dev', 'DEV/b.dev']);
    expect(rec.versionWrites).toBe(1);
    expect(rec.manifestEntries?.[0]).toEqual([
      { entry_path: 'DEV/a.dev', status: 'glb', size: 3 },
      { entry_path: 'DEV/b.dev', status: 'glb', size: 3 },
    ]);
  });

  it('DEV 路径大小写变体只生成一个 manifest 条目并共享序列化结果', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [], manifestEntries: [] };
    const state = makeState({ projectId: 11 });
    const tree = makeTree();
    tree.children[0].devPath = 'dev/A.DEV';
    tree.children[1].devPath = 'DEV/a.dev';
    state.currentCbmTree = tree;
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, makeDeps({}, rec));

    expect(result.failedDevs).toEqual([]);
    expect(rec.serializeCalls).toEqual(['dev/A.DEV', 'DEV/b.dev']);
    expect(rec.manifestEntries?.[0].filter((entry) => entry.entry_path.toLowerCase() === 'dev/a.dev')).toHaveLength(1);
    expect(rec.versionWrites).toBe(1);
  });
});
