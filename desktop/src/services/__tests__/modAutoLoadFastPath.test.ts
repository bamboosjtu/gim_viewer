import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { AppState } from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';
import {
  tryDevGlbFastPath,
  loadScopedRawFallbackGeometry,
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

function seedWithTranslation(path: string, devPath: string, xMm: number): CbmNode {
  return {
    ...seed(path, devPath),
    transformMatrix: `1,0,0,0,0,1,0,0,0,0,1,0,${xMm},0,0,1`,
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
    expect(result.profile.glbDevCount).toBe(1);
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

  it('manifest 缺失时只隔离缺失 DEV，已命中的 GLB 保留', async () => {
    const state = makeState();
    const nodes = [seed('CBM/a.cbm', 'DEV/a.dev'), seed('CBM/b.cbm', 'DEV/b.dev')];
    const batchCalls: string[][] = [];
    const deps = depsFor(
      [{ entry_path: 'DEV/a.dev', status: 'glb', size: 12 }],
      { 'DEV/a.dev': validGlb() },
      { batchCalls },
    );
    const result = await tryDevGlbFastPath(state, new THREE.Scene(), nodes, vi.fn(), 1, deps, {
      projectId: 1,
      generation: 1,
      sourceSha256: 'sha-test',
    });

    expect(result.loaded).toBe(true);
    expect(result.modCount).toBe(1);
    expect(result.profile.rawModFallbackCount).toBe(1);
    expect(result.profile.fullProjectRawFallbackCount).toBe(0);
    expect(result.profile.failedDevCount).toBe(1);
    expect(result.profile.failedDevPaths).toEqual(['DEV/b.dev']);
    expect(result.profile.failureType).toEqual({ 'DEV/b.dev': 'missing' });
    expect(result.profile.partialRawFallbackInstanceCount).toBe(1);
    expect(result.profile.successfulGlbDevCount).toBe(1);
    expect(result.profile.successfulGlbInstanceCount).toBe(1);
    expect(batchCalls).toEqual([['DEV/a.dev']]);
    expect(state.loadedXmlModGroups.size).toBe(1);
  });

  it('GLB 截断时只隔离该 DEV，不清理其它 DEV，也不把 empty 当 miss', async () => {
    const state = makeState();
    const nodes = [seed('CBM/a.cbm', 'DEV/a.dev'), seed('CBM/b.cbm', 'DEV/b.dev')];
    const batchCalls: string[][] = [];
    const deps = depsFor(
      [
        { entry_path: 'DEV/a.dev', status: 'glb', size: 12 },
        { entry_path: 'DEV/b.dev', status: 'empty', size: 0 },
      ],
      { 'DEV/a.dev': new Uint8Array([1, 2, 3]) },
      { batchCalls },
    );
    const result = await tryDevGlbFastPath(state, new THREE.Scene(), nodes, vi.fn(), 1, deps, {
      projectId: 1,
      generation: 1,
      sourceSha256: 'sha-test',
    });

    expect(result.loaded).toBe(true);
    expect(result.modCount).toBe(0);
    expect(result.profile.fullProjectRawFallbackCount).toBe(0);
    expect(result.profile.failedDevPaths).toEqual(['DEV/a.dev']);
    expect(result.profile.failureType).toEqual({ 'DEV/a.dev': 'invalid' });
    expect(result.profile.emptyDevCount).toBe(1);
    expect(batchCalls).toEqual([['DEV/a.dev']]);
    expect(state.loadedXmlModGroups.size).toBe(0);
  });

  it('GLB parse 错误只回退失败 DEV，并保留已经加载的其它 placement', async () => {
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

    expect(result.loaded).toBe(true);
    expect(result.modCount).toBe(1);
    expect(result.profile.rawModFallbackCount).toBe(1);
    expect(result.profile.fullProjectRawFallbackCount).toBe(0);
    expect(result.profile.failedDevPaths).toEqual(['DEV/b.dev']);
    expect(result.profile.failureType).toEqual({ 'DEV/b.dev': 'parse-exception' });
    expect(result.profile.successfulGlbDevCount).toBe(1);
    expect(result.profile.successfulGlbInstanceCount).toBe(1);
    expect(state.loadedXmlModGroups.size).toBe(1);
    expect(state.modRootGroup?.children).toHaveLength(1);
  });

  it('GLB 解码为空场景时只隔离该 DEV', async () => {
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

    expect(result.loaded).toBe(true);
    expect(result.modCount).toBe(1);
    expect(result.profile.fullProjectRawFallbackCount).toBe(0);
    expect(result.profile.failedDevPaths).toEqual(['DEV/b.dev']);
    expect(result.profile.failureType).toEqual({ 'DEV/b.dev': 'empty-scene' });
    expect(state.loadedXmlModGroups.size).toBe(1);
  });

  it('同一失败 DEV 的多个 CBM placement 只尝试一次 GLB parse', async () => {
    const state = makeState();
    const load = vi.fn(async () => null);
    const deps = depsFor(
      [{ entry_path: 'DEV/b.dev', status: 'glb', size: 12 }],
      { 'DEV/b.dev': validGlb() },
      { load },
    );

    const result = await tryDevGlbFastPath(
      state,
      new THREE.Scene(),
      [
        seed('CBM/b1.cbm', 'DEV/b.dev'),
        seed('CBM/b2.cbm', 'DEV/b.dev'),
        seed('CBM/b3.cbm', 'DEV/b.dev'),
      ],
      vi.fn(),
      1,
      deps,
      { projectId: 1, generation: 1, sourceSha256: 'sha-test' },
    );

    expect(result.loaded).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.profile.failedDevCount).toBe(1);
    expect(result.profile.partialRawFallbackInstanceCount).toBe(3);
    expect(result.profile.failureType).toEqual({ 'DEV/b.dev': 'parse-exception' });
  });

  it('100 个 DEV 中单个 parse failure 不清理其它 99 个 GLB', async () => {
    const state = makeState();
    const entries = Array.from({ length: 100 }, (_, index) => ({
      entry_path: `DEV/d${index}.dev`,
      status: 'glb' as const,
      size: 12,
    }));
    const bytes = Object.fromEntries(entries.map((entry) => [entry.entry_path, validGlb()]));
    const load = vi.fn(async (path: string) => path === 'DEV/d37.dev' ? null : renderableGroup(path));
    const result = await tryDevGlbFastPath(
      state,
      new THREE.Scene(),
      entries.map((entry) => seed(`CBM/${entry.entry_path}`, entry.entry_path)),
      vi.fn(),
      1,
      depsFor(entries, bytes, { load }),
      { projectId: 1, generation: 1, sourceSha256: 'sha-test' },
    );

    expect(result.loaded).toBe(true);
    expect(result.profile.failedDevPaths).toEqual(['DEV/d37.dev']);
    expect(result.profile.fullProjectRawFallbackCount).toBe(0);
    expect(result.profile.successfulGlbDevCount).toBe(99);
    expect(result.profile.successfulGlbInstanceCount).toBe(99);
    // 99 successful DEV placements plus the single failed DEV attempt.
    expect(load).toHaveBeenCalledTimes(100);
    expect(state.loadedXmlModGroups.size).toBe(99);
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

  it('source-files scoped fallback 对同一失败 DEV 只解析一次并保留每个 placement 矩阵', async () => {
    const state = makeState(1);
    state.loadedStlGroups = new Map<string, THREE.Group>();
    const devFile = new File([
      'SOLIDMODELS.NUM=1\n',
      'SOLIDMODEL0=main.phm\n',
      'TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1\n',
    ], 'Parent.DEV');
    const phmFile = new File([
      'SOLIDMODELS.NUM=1\n',
      'SOLIDMODEL0=main.mod\n',
      'TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1\n',
    ], 'Main.PHM');
    const modFile = new File([`<?xml version="1.0"?><Device><Entities>
      <Entity ID="1" Type="simple" Visible="True">
        <Cuboid L="100" W="100" H="100" />
        <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
        <Color R="128" G="128" B="128" A="100" />
      </Entity>
    </Entities></Device>`], 'Main.MOD');
    const devRead = vi.spyOn(devFile, 'arrayBuffer');
    const phmRead = vi.spyOn(phmFile, 'arrayBuffer');
    const files = new Map<string, File>([
      ['dEv/Parent.DEV', devFile],
      ['pHm/Main.PHM', phmFile],
      ['mOd/Main.MOD', modFile],
    ]);
    const session = {
      generation: 1,
      projectId: 1,
      sourceSha256: 'sha-test',
      geometryToken: 1,
    };
    const nodes = [
      seedWithTranslation('CBM/p1.cbm', 'DEV/parent.dev', 0),
      seedWithTranslation('CBM/p2.cbm', 'dev/PARENT.DEV', 1000),
    ];

    const profile = emptyProfileForTest();
    const result = await loadScopedRawFallbackGeometry(
      state,
      new THREE.Scene(),
      vi.fn(),
      ['DEV/PARENT.DEV'],
      true,
      false,
      1,
      1,
      1,
      'sha-test',
      session,
      profile,
      files,
      nodes,
    );

    expect(result.modCount).toBe(2);
    expect(result.rows).toBe(2);
    // Discovery text is shared by all placements; MOD itself remains an
    // independent Three instance and is therefore loaded twice intentionally.
    expect(devRead).toHaveBeenCalledTimes(1);
    expect(phmRead).toHaveBeenCalledTimes(1);
    expect(state.loadedXmlModGroups.size).toBe(2);
    const groups = [...state.loadedXmlModGroups.values()];
    const centers = groups.map((group) => new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3()).x).sort((a, b) => a - b);
    expect(centers[1] - centers[0]).toBeCloseTo(1, 5);
    expect(profile.partialRawFallbackRows).toBe(2);
  });

  it('source-files scoped fallback 会恢复失败父 DEV 的 nested child，但不重复成功 child GLB', async () => {
    const state = makeState(1);
    state.loadedStlGroups = new Map<string, THREE.Group>();
    const parent = new File([
      'SUBDEVICES.NUM=1\n',
      'SUBDEVICE0=child.dev\n',
      'TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1\n',
    ], 'Parent.DEV');
    const child = new File([
      'SOLIDMODELS.NUM=1\n',
      'SOLIDMODEL0=child.phm\n',
      'TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1\n',
    ], 'Child.DEV');
    const phm = new File([
      'SOLIDMODELS.NUM=1\n',
      'SOLIDMODEL0=child.mod\n',
      'TRANSFORMMATRIX0=1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1\n',
    ], 'Child.PHM');
    const mod = new File([`<?xml version="1.0"?><Device><Entities>
      <Entity ID="1" Type="simple"><Cuboid L="100" W="100" H="100" />
      <TransformMatrix Value="1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1" />
      <Color R="128" G="128" B="128" A="100" /></Entity>
    </Entities></Device>`], 'Child.MOD');
    const parentRead = vi.spyOn(parent, 'arrayBuffer');
    const childRead = vi.spyOn(child, 'arrayBuffer');
    const phmRead = vi.spyOn(phm, 'arrayBuffer');
    const files = new Map<string, File>([
      // DEV/ 目录使用 PascalCase，文件名大小写与引用故意不同；这是
      // 真实样本的 mixed-case 形态，getFileByPath 应按路径大小写不敏感命中。
      ['Dev/Parent.DEV', parent],
      ['Dev/Child.DEV', child],
      ['PHM/Child.PHM', phm],
      ['MOD/Child.MOD', mod],
    ]);
    const childGlb = renderableGroup('child-glb');
    state.modRootGroup = new THREE.Group();
    state.modRootGroup.add(childGlb);
    state.loadedXmlModGroups.set('dev:DEV/child.dev#CBM/child.cbm', childGlb);
    const session = {
      generation: 1,
      projectId: 1,
      sourceSha256: 'sha-test',
      geometryToken: 1,
    };
    const profile = emptyProfileForTest();
    const result = await loadScopedRawFallbackGeometry(
      state,
      new THREE.Scene(),
      vi.fn(),
      ['DEV/parent.dev'],
      true,
      false,
      1,
      1,
      1,
      'sha-test',
      session,
      profile,
      files,
      [
        seed('CBM/parent.cbm', 'DEV/parent.dev'),
        seed('CBM/child.cbm', 'DEV/child.dev'),
      ],
    );

    // child DEV 有独立成功 GLB 的 seed，因此父 DEV 的 scoped fallback
    // 应完成发现但过滤掉 child，避免重复渲染成功的 GLB。
    expect(result.modCount).toBe(0);
    expect(result.rows).toBe(0);
    expect(state.loadedXmlModGroups.size).toBe(1);
    expect(profile.partialRawFallbackRows).toBe(0);
    expect(parentRead).toHaveBeenCalledTimes(1);
    expect(childRead).toHaveBeenCalledTimes(1);
    expect(phmRead).toHaveBeenCalledTimes(1);
  });
});

/** Keep the scoped fallback tests focused on its diagnostic mutation contract. */
function emptyProfileForTest(): DevGlbFastPathProfile {
  return {
    cbmInstanceCount: 0,
    uniqueDevCount: 0,
    glbDevCount: 0,
    emptyDevCount: 0,
    glbBatchReadMs: 0,
    glbReadBytes: 0,
    glbParseCount: 0,
    glbParseMs: 0,
    rawModFallbackCount: 0,
    partialRawFallbackCount: 1,
    partialRawFallbackInstanceCount: 2,
    successfulGlbDevCount: 0,
    successfulGlbInstanceCount: 0,
    fullProjectRawFallbackCount: 0,
    failureType: { 'DEV/PARENT.DEV': 'parse-exception' },
    failedDevCount: 1,
    failedDevPaths: ['DEV/PARENT.DEV'],
    partialRawFallbackMs: 0,
    partialRawFallbackReadMs: 0,
    partialRawFallbackParseMs: 0,
    partialRawFallbackRows: 0,
  };
}
