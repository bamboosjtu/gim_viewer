import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { AppState } from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';
import {
  tryDevGlbFastPath,
  type AutoLoadProgress,
  type DevGlbFastPathProfile,
} from '../modAutoLoadService.js';

function seed(path: string, devPath: string): CbmNode {
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
    transformMatrix: '',
    systemNames: [],
    devSymbolName: '',
    devType: '',
    devExpanded: false,
  };
}

function renderableGroup(name: string): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  group.add(new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
  ));
  return group;
}

/** 最小合法 GLB header；测试 loader 不需要真实 JSON/二进制 chunk。 */
function validGlb(size = 12): Uint8Array {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x676c5446, false); // glTF
  view.setUint32(4, 2, true);
  view.setUint32(8, size, true);
  return bytes;
}

function makeState(projectId = 1): AppState {
  return {
    currentProjectId: projectId,
    currentSourceSha256: 'sha-test',
    projectGeneration: 1,
    geometryLoadToken: 1,
    modRootGroup: null,
    stlRootGroup: null,
    loadedXmlModGroups: new Map<string, THREE.Group>(),
    projectSourceToViewerMatrix: null,
  } as unknown as AppState;
}

function manifest(entries: Array<{ entry_path: string; status: 'glb' | 'empty'; size: number }>) {
  return { source_sha256: 'sha-test', entries };
}

function depsFor(
  entries: Array<{ entry_path: string; status: 'glb' | 'empty'; size: number }>,
  bytes: Record<string, Uint8Array | null>,
  options: {
    load?: (path: string, data: Uint8Array) => Promise<THREE.Group | null>;
    batchCalls?: string[][];
  } = {},
) {
  const batchCalls = options.batchCalls ?? [];
  return {
    readGeometryCacheManifest: vi.fn(async () => manifest(entries)),
    batchReadGlbFiles: vi.fn(async (_projectId: number, paths: string[]) => {
      batchCalls.push([...paths]);
      const result = new Map<string, Uint8Array | null>();
      for (const path of paths) result.set(path, bytes[path] ?? null);
      return result;
    }),
    loadDevGlb: vi.fn(options.load ?? (async (path: string) => renderableGroup(path))),
    applyPlacementTransformToSceneUnits: vi.fn(),
  };
}

describe('DEV GLB fast path v3', () => {
  it('多个 CBM instance 共用同一 DEV 时只读一次，但各 placement 独立 parse/load', async () => {
    const state = makeState();
    const nodes = [
      seed('CBM/a1.cbm', 'dev/shared.dev'),
      seed('CBM/a2.cbm', 'DEV/SHARED.DEV'),
      seed('CBM/b.cbm', 'dev/other.dev'),
    ];
    const batchCalls: string[][] = [];
    const deps = depsFor(
      [
        { entry_path: 'DEV/shared.dev', status: 'glb', size: 12 },
        { entry_path: 'DEV/other.dev', status: 'glb', size: 12 },
      ],
      { 'DEV/shared.dev': validGlb(), 'DEV/other.dev': validGlb() },
      { batchCalls },
    );

    const result = await tryDevGlbFastPath(
      state,
      new THREE.Scene(),
      nodes,
      vi.fn(),
      1,
      deps,
      { projectId: 1, generation: 1, sourceSha256: 'sha-test' },
    );

    expect(result.loaded).toBe(true);
    expect(result.modCount).toBe(3);
    expect(result.profile).toMatchObject<Partial<DevGlbFastPathProfile>>({
      cbmInstanceCount: 3,
      uniqueDevCount: 2,
      glbDevCount: 2,
      emptyDevCount: 0,
      glbParseCount: 3,
      glbReadBytes: 24,
      rawModFallbackCount: 0,
    });
    expect(deps.batchReadGlbFiles).toHaveBeenCalledTimes(1);
    expect(deps.loadDevGlb).toHaveBeenCalledTimes(3);
    expect(state.loadedXmlModGroups.size).toBe(3);
    expect(batchCalls[0]).toEqual(['DEV/shared.dev', 'DEV/other.dev']);
  });

  it('GLB + empty 混合时 fast path 成功，empty 不读取也不触发 raw MOD fallback', async () => {
    const state = makeState();
    const nodes = [seed('CBM/a.cbm', 'DEV/a.dev'), seed('CBM/b.cbm', 'DEV/b.dev')];
    const batchCalls: string[][] = [];
    const deps = depsFor(
      [
        { entry_path: 'DEV/a.dev', status: 'glb', size: 12 },
        { entry_path: 'DEV/b.dev', status: 'empty', size: 0 },
      ],
      { 'DEV/a.dev': validGlb() },
      { batchCalls },
    );
    const progress: AutoLoadProgress[] = [];

    const result = await tryDevGlbFastPath(state, new THREE.Scene(), nodes, (p) => progress.push(p), 1, deps, {
      projectId: 1,
      generation: 1,
      sourceSha256: 'sha-test',
    });

    expect(result.loaded).toBe(true);
    expect(result.modCount).toBe(1);
    expect(result.profile.emptyDevCount).toBe(1);
    expect(result.profile.glbParseCount).toBe(1);
    expect(result.profile.rawModFallbackCount).toBe(0);
    expect(batchCalls).toEqual([['DEV/a.dev']]);
    expect(progress[progress.length - 1]).toMatchObject({ phase: 'done', processedMods: 2 });
  });

  it('manifest 使用反斜杠/大小写变体时仍命中同一 GLB', async () => {
    const state = makeState();
    const batchCalls: string[][] = [];
    const deps = depsFor(
      [{ entry_path: 'dev\\A.DEV', status: 'glb', size: 12 }],
      { 'dev\\A.DEV': validGlb() },
      { batchCalls },
    );

    const result = await tryDevGlbFastPath(
      state,
      new THREE.Scene(),
      [seed('CBM/a.cbm', 'DEV/a.dev')],
      vi.fn(),
      1,
      deps,
      { projectId: 1, generation: 1, sourceSha256: 'sha-test' },
    );

    expect(result.loaded).toBe(true);
    expect(result.modCount).toBe(1);
    expect(result.profile.glbReadBytes).toBe(12);
    expect(result.profile.rawModFallbackCount).toBe(0);
    expect(batchCalls).toEqual([['dev\\A.DEV']]);
  });

  it.each([
    ['manifest 缺失', [{ entry_path: 'DEV/a.dev', status: 'glb' as const, size: 12 }], {} as Record<string, Uint8Array | null>, 'manifest-missing:DEV/b.dev'],
    ['GLB 截断', [
      { entry_path: 'DEV/a.dev', status: 'glb' as const, size: 12 },
      { entry_path: 'DEV/b.dev', status: 'empty' as const, size: 0 },
    ], { 'DEV/a.dev': new Uint8Array([1, 2, 3]) }, 'glb-invalid:DEV/a.dev'],
  ])('%s 时整体回退且不提交部分 group', async (_label, entries, bytes, reason) => {
    const state = makeState();
    const nodes = [seed('CBM/a.cbm', 'DEV/a.dev'), seed('CBM/b.cbm', 'DEV/b.dev')];
    const deps = depsFor(entries, bytes);
    const result = await tryDevGlbFastPath(state, new THREE.Scene(), nodes, vi.fn(), 1, deps, {
      projectId: 1,
      generation: 1,
      sourceSha256: 'sha-test',
    });

    expect(result.loaded).toBe(false);
    expect(result.profile.rawModFallbackCount).toBe(1);
    expect(result.profile.fallbackReason).toContain(reason);
    expect(state.loadedXmlModGroups.size).toBe(0);
    expect(state.modRootGroup?.children ?? []).toHaveLength(0);
  });

  it('GLB parse 错误会清理已经加载的 placement 并整体回退', async () => {
    const state = makeState();
    const nodes = [seed('CBM/a.cbm', 'DEV/a.dev'), seed('CBM/b.cbm', 'DEV/b.dev')];
    const deps = depsFor(
      [
        { entry_path: 'DEV/a.dev', status: 'glb', size: 12 },
        { entry_path: 'DEV/b.dev', status: 'glb', size: 12 },
      ],
      { 'DEV/a.dev': validGlb(), 'DEV/b.dev': validGlb() },
      { load: async (path) => path.endsWith('b.dev') ? null : renderableGroup(path) },
    );

    const result = await tryDevGlbFastPath(state, new THREE.Scene(), nodes, vi.fn(), 1, deps, {
      projectId: 1,
      generation: 1,
      sourceSha256: 'sha-test',
    });

    expect(result.loaded).toBe(false);
    expect(result.profile.fallbackReason).toBe('glb-parse-failed:DEV/b.dev');
    expect(state.loadedXmlModGroups.size).toBe(0);
    expect(state.modRootGroup?.children).toHaveLength(0);
  });

  it('GLB 解码为空场景时视为 parse 失败并整体回退', async () => {
    const state = makeState();
    const deps = depsFor(
      [
        { entry_path: 'DEV/a.dev', status: 'glb', size: 12 },
        { entry_path: 'DEV/b.dev', status: 'glb', size: 12 },
      ],
      { 'DEV/a.dev': validGlb(), 'DEV/b.dev': validGlb() },
      {
        load: async (path) => path.endsWith('b.dev') ? new THREE.Group() : renderableGroup(path),
      },
    );

    const result = await tryDevGlbFastPath(
      state,
      new THREE.Scene(),
      [seed('CBM/a.cbm', 'DEV/a.dev'), seed('CBM/b.cbm', 'DEV/b.dev')],
      vi.fn(),
      1,
      deps,
      { projectId: 1, generation: 1, sourceSha256: 'sha-test' },
    );

    expect(result.loaded).toBe(false);
    expect(result.profile.fallbackReason).toBe('glb-parse-failed:DEV/b.dev');
    expect(state.loadedXmlModGroups.size).toBe(0);
    expect(state.modRootGroup?.children).toHaveLength(0);
  });

  it('单个 placement bbox 异常只跳过该实例，不触发 raw MOD 整体回退', async () => {
    const state = makeState();
    const deps = depsFor(
      [{ entry_path: 'DEV/a.dev', status: 'glb', size: 12 }],
      { 'DEV/a.dev': validGlb() },
      {
        load: async () => {
          const group = renderableGroup('far-away');
          // 与原始 MOD 路径相同的安全阈值：中心距超过 5 km。
          group.position.set(6000, 0, 0);
          return group;
        },
      },
    );

    const result = await tryDevGlbFastPath(
      state,
      new THREE.Scene(),
      [seed('CBM/a.cbm', 'DEV/a.dev')],
      vi.fn(),
      1,
      deps,
      { projectId: 1, generation: 1, sourceSha256: 'sha-test' },
    );

    expect(result.loaded).toBe(true);
    expect(result.modCount).toBe(0);
    expect(result.profile.rawModFallbackCount).toBe(0);
    expect(result.profile.fallbackReason).toBeUndefined();
    expect(state.loadedXmlModGroups.size).toBe(0);
    expect(state.modRootGroup?.children).toHaveLength(0);
  });

  it('A→B 切换期间 batch 迟到时禁止旧工程提交', async () => {
    const state = makeState(1);
    let release!: (value: Map<string, Uint8Array | null>) => void;
    const batch = new Promise<Map<string, Uint8Array | null>>((resolve) => { release = resolve; });
    const deps = {
      readGeometryCacheManifest: vi.fn(async () => manifest([{ entry_path: 'DEV/a.dev', status: 'glb', size: 12 }])),
      batchReadGlbFiles: vi.fn(async () => batch),
      loadDevGlb: vi.fn(async (path: string) => renderableGroup(path)),
      applyPlacementTransformToSceneUnits: vi.fn(),
    };
    const pending = tryDevGlbFastPath(
      state,
      new THREE.Scene(),
      [seed('CBM/a.cbm', 'DEV/a.dev')],
      vi.fn(),
      1,
      deps,
      { projectId: 1, generation: 1, sourceSha256: 'sha-test' },
    );

    state.currentProjectId = 2;
    state.projectGeneration = 2;
    release(new Map([['DEV/a.dev', validGlb()]]));
    const result = await pending;

    expect(result.loaded).toBe(false);
    expect(result.profile.fallbackReason).toBe('session-invalid');
    expect(deps.loadDevGlb).not.toHaveBeenCalled();
    expect(state.loadedXmlModGroups.size).toBe(0);
  });
});
