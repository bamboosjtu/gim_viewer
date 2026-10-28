import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { loadIfcEntry } from '../ifcEntryLoader.js';
import { ensureEngineReady, initEngine, registerModelEvents } from '../ifcLoader.js';
vi.mock('../wasmAssets.js', () => ({ resolveWebIfcWasmBaseUrl: async () => 'https://localhost/wasm/' }));
vi.mock('../ifcConversion.js', () => ({ loadRawIfc: (ctx:any,_state:any,_session:any,bytes:Uint8Array,id:string) =>
  ctx.ifcLoader.load(bytes,true,id), cancelIfcConversions:vi.fn() }));

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

function createEngine() {
  let ready = false;
  const core = { models: { materials: { list: { onItemSet: { add: vi.fn() } } } } };
  return {
    ifcLoader: { setup: vi.fn().mockResolvedValue(undefined) },
    world: { camera: { controls: { addEventListener: vi.fn() } } },
    fragments: {
      init: vi.fn(() => { ready = true; }),
      get core() {
        if (!ready) throw new Error('FragmentsManager not initialized. Call init() first.');
        return core;
      },
      list: { onItemSet: { add: vi.fn() }, onBeforeDelete: { add: vi.fn() }, onItemDeleted: { add: vi.fn() } },
    },
  };
}

describe('IFC initialization across project switches', () => {
  it('设备视图已就绪时仍初始化 IFC，切回变电时复用引擎与监听', async () => {
    const ctx = createEngine();
    const state = new AppState();
    state.initialized = true; // DEV-only equipment made the viewer interactive.
    const callbacks = { onModelAdded: vi.fn(), onModelRemoved: vi.fn() };
    await ensureEngineReady(ctx as any, state, callbacks);
    state.resetGimState(); // station → equipment → station keeps the viewer alive.
    await ensureEngineReady(ctx as any, state, callbacks);
    expect(ctx.ifcLoader.setup).toHaveBeenCalledTimes(1);
    expect(ctx.fragments.init).toHaveBeenCalledTimes(1);
    expect(ctx.world.camera.controls.addEventListener).toHaveBeenCalledTimes(1);
    expect(ctx.fragments.list.onItemSet.add).toHaveBeenCalledTimes(1);
  });

  it('并发初始化只启动一次 WASM/worker', async () => {
    const ctx = createEngine(), state = new AppState(), setup = deferred<void>();
    ctx.ifcLoader.setup.mockReturnValue(setup.promise);
    const first = initEngine(ctx as any, state), second = initEngine(ctx as any, state);
    await Promise.resolve();
    expect(ctx.ifcLoader.setup).toHaveBeenCalledTimes(1);
    expect(state.initialized).toBe(false);
    setup.resolve(undefined);
    await Promise.all([first, second]);
    expect(ctx.fragments.init).toHaveBeenCalledTimes(1);
    expect(state.initialized).toBe(true);
  });

  it('初始化失败后可以在同一视图重试', async () => {
    const ctx = createEngine(), state = new AppState();
    state.initialized = true;
    ctx.ifcLoader.setup.mockRejectedValueOnce(new Error('setup failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(initEngine(ctx as any, state)).rejects.toThrow('setup failed');
      await initEngine(ctx as any, state);
      expect(ctx.ifcLoader.setup).toHaveBeenCalledTimes(2);
      expect(ctx.fragments.init).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });
});

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
      { session: sessionA, openingPolicy:'full' },
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
      { session: sessionB, openingPolicy:'full' },
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
