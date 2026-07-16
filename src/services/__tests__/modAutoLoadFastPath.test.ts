import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { AppState } from '../../app/state.js';
import type { CbmNode } from '../../gim/types.js';
import { tryDevGlbFastPath, type AutoLoadProgress } from '../modAutoLoadService.js';

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

describe('DEV GLB fast path', () => {
  it('任一 GLB 为空时清理已加载结果并回退，不再把部分命中当完成', async () => {
    const scene = new THREE.Scene();
    const state = {
      currentProjectId: 1,
      modRootGroup: null,
      stlRootGroup: null,
      loadedXmlModGroups: new Map<string, THREE.Group>(),
      projectSourceToViewerMatrix: null,
      geometryLoadToken: 0,
    } as unknown as AppState;
    const nodes = [
      seed('CBM/a.cbm', 'a.dev'),
      seed('CBM/b.cbm', 'b.dev'),
      seed('CBM/c.cbm', 'c.dev'),
    ];
    const progress: AutoLoadProgress[] = [];

    const result = await tryDevGlbFastPath(
      state,
      scene,
      nodes,
      (value) => progress.push(value),
      undefined,
      {
        readGlbFile: async () => new Uint8Array([1]),
        loadDevGlb: async (devPath) => devPath.endsWith('b.dev')
          ? new THREE.Group()
          : renderableGroup(devPath),
        applyPlacementTransformToSceneUnits: () => {},
      },
    );

    expect(result).toEqual({ loaded: false, modCount: 0, stlCount: 0 });
    expect(state.modRootGroup?.children).toHaveLength(0);
    expect(state.loadedXmlModGroups.size).toBe(0);
    expect(progress[progress.length - 1]?.processedMods).toBe(3);
    expect(progress.some((value) => value.phase === 'done')).toBe(false);
  });

  it('全部 GLB 有效时返回完成并报告全部任务已处理', async () => {
    const scene = new THREE.Scene();
    const state = {
      currentProjectId: 1,
      modRootGroup: null,
      stlRootGroup: null,
      loadedXmlModGroups: new Map<string, THREE.Group>(),
      projectSourceToViewerMatrix: null,
      geometryLoadToken: 0,
    } as unknown as AppState;
    const nodes = [seed('CBM/a.cbm', 'a.dev'), seed('CBM/b.cbm', 'b.dev')];
    const progress: AutoLoadProgress[] = [];

    const result = await tryDevGlbFastPath(
      state,
      scene,
      nodes,
      (value) => progress.push(value),
      undefined,
      {
        readGlbFile: async () => new Uint8Array([1]),
        loadDevGlb: async (devPath) => renderableGroup(devPath),
        applyPlacementTransformToSceneUnits: () => {},
      },
    );

    expect(result).toEqual({ loaded: true, modCount: 2, stlCount: 0 });
    expect(state.modRootGroup?.children).toHaveLength(2);
    expect(progress[progress.length - 1]).toMatchObject({ phase: 'done', processedMods: 2 });
  });
});
