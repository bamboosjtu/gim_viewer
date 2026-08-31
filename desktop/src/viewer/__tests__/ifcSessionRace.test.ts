import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { loadIfcEntry } from '../ifcEntryLoader.js';
import { registerModelEvents } from '../ifcLoader.js';

type Model = {
  modelId: string;
  object: THREE.Object3D;
  useCamera: ReturnType<typeof vi.fn>;
};

type Event<T> = {
  add: (handler: (value: T) => void) => void;
  emit: (value: T) => void;
};

function createEvent<T>(): Event<T> {
  let handler: ((value: T) => void) | null = null;
  return {
    add(next) { handler = next; },
    emit(value) { handler?.(value); },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function createModel(modelId: string): Model {
  return {
    modelId,
    object: new THREE.Object3D(),
    useCamera: vi.fn(),
  };
}

/**
 * 回归：工程 A 的慢 IFC 在切换到工程 B 后才完成，不得进入 B 的
 * Fragments 列表、Three.js scene、loadedModels 或模型列表回调。
 */
describe('IFC project session race', () => {
  it('拒绝跨工程迟到模型，同时保留工程 B 模型', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    const onItemSet = createEvent<{ value: Model }>();
    const onBeforeDelete = createEvent<{ value: Model }>();
    const onItemDeleted = createEvent<string>();
    const materialOnItemSet = createEvent<{ value: object }>();
    const models = new Map<string, Model>() as Map<string, Model> & {
      onItemSet: Event<{ value: Model }>;
      onBeforeDelete: Event<{ value: Model }>;
      onItemDeleted: Event<string>;
    };
    models.onItemSet = onItemSet;
    models.onBeforeDelete = onBeforeDelete;
    models.onItemDeleted = onItemDeleted;

    const disposeModel = vi.fn((runtimeModelId: string) => {
      const model = models.get(runtimeModelId);
      if (!model) return;
      onBeforeDelete.emit({ value: model });
      models.delete(runtimeModelId);
      onItemDeleted.emit(runtimeModelId);
    });
    const scene = new THREE.Scene();
    const added: Array<[string, string]> = [];
    const removed: Array<[string, string]> = [];
    const modelADeferred = deferred<Model>();
    const entryA = { name: 'A.ifc', path: 'DEV/A.ifc', modelId: 'ifc-a' };
    const entryB = { name: 'B.ifc', path: 'DEV/B.ifc', modelId: 'ifc-b' };
    let runtimeA = '';

    const ctx = {
      world: { camera: { three: {} }, scene: { three: scene } },
      fragments: {
        list: models,
        core: {
          update: vi.fn(),
          disposeModel,
          models: { materials: { list: { onItemSet: materialOnItemSet } } },
        },
      },
      ifcLoader: {
        load: vi.fn((_buffer: Uint8Array, _coordinate: boolean, runtimeModelId: string) => {
          if (!runtimeA) runtimeA = runtimeModelId;
          const result = runtimeModelId === runtimeA
            ? modelADeferred.promise
            : Promise.resolve(createModel(runtimeModelId));
          return result.then((model) => {
            models.set(runtimeModelId, model);
            onItemSet.emit({ value: model });
            return model;
          });
        }),
      },
    } as any;

    const state = new AppState();
    const sessionA = state.activateProject(1, 'sha-a');
    state.currentIfcEntries = [entryA];
    registerModelEvents(ctx, state, {
      onModelAdded: (logicalId, runtimeId) => added.push([logicalId, runtimeId]),
      onModelRemoved: (logicalId, runtimeId) => removed.push([logicalId, runtimeId]),
    });

    const loadingA = loadIfcEntry(
      ctx,
      state,
      entryA,
      async () => new Uint8Array([1]),
      undefined,
      { session: sessionA },
    );
    // 让 A 走到慢速 ifcLoader.load，并确认 owner 已登记。
    await Promise.resolve();
    expect(runtimeA).toBeTruthy();

    // 模拟真实项目切换顺序：先失效，再清状态，最后激活 B。
    state.invalidatePendingLoads();
    state.resetGimState();
    const sessionB = state.activateProject(2, 'sha-b');
    state.currentIfcEntries = [entryB];

    const loadingB = loadIfcEntry(
      ctx,
      state,
      entryB,
      async () => new Uint8Array([2]),
      undefined,
      { session: sessionB },
    );
    await loadingB;

    const runtimeB = state.getRuntimeModelId(entryB.modelId, sessionB);
    expect(models.has(runtimeB)).toBe(true);
    expect(state.loadedModels.get(entryB.modelId)?.runtimeModelId).toBe(runtimeB);
    expect(added).toEqual([[entryB.modelId, runtimeB]]);

    // A 最后完成：onItemSet 先到达也必须被 owner/session 守卫拒绝。
    modelADeferred.resolve(createModel(runtimeA));
    await loadingA;
    await Promise.resolve();

    expect(models.has(runtimeA)).toBe(false);
    expect(scene.children.map((child) => child)).toHaveLength(1);
    expect(scene.children[0]).toBe(models.get(runtimeB)?.object);
    expect(state.loadedModels.has(entryA.modelId)).toBe(false);
    expect(state.loadedModels.get(entryB.modelId)?.runtimeModelId).toBe(runtimeB);
    expect(added).toEqual([[entryB.modelId, runtimeB]]);
    expect(disposeModel).toHaveBeenCalledWith(runtimeA);
    expect(removed.some(([logicalId]) => logicalId === entryA.modelId)).toBe(false);

    vi.unstubAllGlobals();
  });
});
