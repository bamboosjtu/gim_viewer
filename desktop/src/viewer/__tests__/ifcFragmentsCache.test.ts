import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { FRAGMENTS_CACHE_DEBUG_KEY } from '../../config/features.js';
import { perfReset, perfSnapshot } from '../../utils/perfTimings.js';
import { loadIfcEntry } from '../ifcEntryLoader.js';
import { registerModelEvents } from '../ifcLoader.js';

const db = vi.hoisted(() => ({
  validate: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@desktop/database.js', () => ({
  validateFragmentCache: db.validate,
  readFragmentCacheFile: db.read,
  writeFragmentCacheFile: db.write,
  upsertFragmentCacheRecord: db.upsert,
  deleteFragmentCacheRecord: db.remove,
}));

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

function createContext() {
  const onItemSet = createEvent<{ value: any }>();
  const onBeforeDelete = createEvent<{ value: any }>();
  const onItemDeleted = createEvent<string>();
  const materialOnItemSet = createEvent<{ value: object }>();
  const models = new Map<string, any>() as Map<string, any> & {
    onItemSet: Event<{ value: any }>;
    onBeforeDelete: Event<{ value: any }>;
    onItemDeleted: Event<string>;
  };
  models.onItemSet = onItemSet;
  models.onBeforeDelete = onBeforeDelete;
  models.onItemDeleted = onItemDeleted;
  const makeModel = (runtimeModelId: string, inputBytes?: Uint8Array) => {
    // Normalize the test fixture to an ArrayBuffer-backed view. Newer TypeScript
    // versions model Uint8Array's default buffer as ArrayBufferLike, while the
    // Fragments API returns a concrete ArrayBuffer from getBuffer().
    const bytes: Uint8Array<ArrayBuffer> = inputBytes
      ? new Uint8Array(inputBytes)
      : new Uint8Array([9, 8, 7]);
    return {
      modelId: runtimeModelId,
      object: new THREE.Object3D(),
      useCamera: vi.fn(),
      getBuffer: vi.fn(async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    };
  };
  const addModel = (runtimeModelId: string, bytes?: Uint8Array) => {
    const model = makeModel(runtimeModelId, bytes);
    models.set(runtimeModelId, model);
    onItemSet.emit({ value: model });
    return model;
  };
  const disposeModel = vi.fn((runtimeModelId: string) => {
    const model = models.get(runtimeModelId);
    if (!model) return;
    onBeforeDelete.emit({ value: model });
    models.delete(runtimeModelId);
    onItemDeleted.emit(runtimeModelId);
  });
  const ctx = {
    world: { camera: { three: {} }, scene: { three: new THREE.Scene() } },
    fragments: {
      list: models,
      core: {
        update: vi.fn(),
        disposeModel,
        load: vi.fn(async (bytes: Uint8Array, _options: unknown) => {
          const runtimeModelId = (_options as { modelId: string }).modelId;
          addModel(runtimeModelId, bytes);
        }),
        models: { materials: { list: { onItemSet: materialOnItemSet } } },
      },
    },
    ifcLoader: {
      load: vi.fn(async (bytes: Uint8Array, _coordinate: boolean, runtimeModelId: string) => {
        addModel(runtimeModelId, bytes);
        return models.get(runtimeModelId);
      }),
    },
  } as any;
  return { ctx, models, addModel };
}

function validCache() {
  return {
    project_id: 1,
    entry_path: 'DEV/a.ifc',
    has_record: true,
    stored_fragments_version: 'fragments-cache-v6|fragments@3.4.0|web-ifc@0.0.77',
    current_fragments_version: 'fragments-cache-v6|fragments@3.4.0|web-ifc@0.0.77',
    fragments_version_match: true,
    source_gim_sha256: 'sha-a',
    source_gim_sha256_match: true,
    source_ifc_size_match: true,
    fragment_file_exists: true,
    fragment_file_size: 3,
    fragment_file_size_match: true,
    valid: true,
  };
}

describe('Fragments cache-on A/B loader', () => {
  beforeEach(() => {
    perfReset({ generation: 1, projectId: 1, sourceSha256: 'sha-a' });
    localStorage.setItem(FRAGMENTS_CACHE_DEBUG_KEY, '1');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    db.validate.mockReset();
    db.read.mockReset();
    db.write.mockReset();
    db.upsert.mockReset();
    db.remove.mockReset();
    db.write.mockResolvedValue({ path: 'cache/a.ifc.frag', size: 3 });
    db.upsert.mockResolvedValue(undefined);
    db.remove.mockResolvedValue(undefined);
  });

  afterEach(() => {
    localStorage.removeItem(FRAGMENTS_CACHE_DEBUG_KEY);
    vi.unstubAllGlobals();
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('有效缓存命中只读/加载 frag，不读取 IFC，并记录 hit/bytes', async () => {
    db.validate.mockResolvedValue(validCache());
    db.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const { ctx } = createContext();
    const state = new AppState();
    const session = state.activateProject(1, 'sha-a');
    registerModelEvents(ctx, state, { onModelAdded: vi.fn(), onModelRemoved: vi.fn() });
    const entry = { name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'ifc-a' };
    const getIfcBuffer = vi.fn(async () => new Uint8Array([4, 5]));

    await loadIfcEntry(ctx, state, entry, getIfcBuffer, undefined, { session });

    expect(db.validate).toHaveBeenCalledTimes(1);
    expect(db.read).toHaveBeenCalledTimes(1);
    expect(getIfcBuffer).not.toHaveBeenCalled();
    expect(ctx.ifcLoader.load).not.toHaveBeenCalled();
    expect(perfSnapshot().fragmentsCache).toMatchObject({ enabled: true, attempts: 1, hits: 1, misses: 0, fallbacks: 0, readBytes: 3 });
    expect(perfSnapshot().fragmentsCache.operations.read).toMatchObject({ count: 1, bytes: 3 });
  });

  it.each([
    ['version mismatch', { ...validCache(), fragments_version_match: false, valid: false }],
    ['source SHA mismatch', { ...validCache(), source_gim_sha256_match: false, valid: false }],
    ['truncated cache', { ...validCache(), fragment_file_size_match: false, valid: false }],
  ])('%s 自动回退 IFC，不提交 cache hit', async (_label, validation) => {
    db.validate.mockResolvedValue(validation);
    db.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const { ctx } = createContext();
    const state = new AppState();
    const session = state.activateProject(1, 'sha-a');
    registerModelEvents(ctx, state, { onModelAdded: vi.fn(), onModelRemoved: vi.fn() });
    const entry = { name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'ifc-a' };

    await loadIfcEntry(ctx, state, entry, async () => new Uint8Array([4, 5]), undefined, { session });

    expect(ctx.ifcLoader.load).toHaveBeenCalledTimes(1);
    expect(perfSnapshot().fragmentsCache).toMatchObject({ attempts: 1, hits: 0, misses: 1, fallbacks: 0 });
  });

  it('缓存记录存在但文件缺失时回退 IFC，不读取不存在的 frag', async () => {
    db.validate.mockResolvedValue({
      ...validCache(),
      fragment_file_exists: false,
      fragment_file_size: 0,
      fragment_file_size_match: false,
      valid: false,
    });
    const { ctx } = createContext();
    const state = new AppState();
    const session = state.activateProject(1, 'sha-a');
    registerModelEvents(ctx, state, { onModelAdded: vi.fn(), onModelRemoved: vi.fn() });
    const entry = { name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'ifc-a' };

    await loadIfcEntry(ctx, state, entry, async () => new Uint8Array([4, 5]), undefined, { session });

    expect(db.read).not.toHaveBeenCalled();
    expect(ctx.ifcLoader.load).toHaveBeenCalledTimes(1);
    expect(perfSnapshot().fragmentsCache).toMatchObject({
      attempts: 1,
      hits: 0,
      misses: 1,
      fallbacks: 0,
    });
  });

  it('有效记录但 frag 为空时计入 fallback，清理后回退 IFC', async () => {
    db.validate.mockResolvedValue(validCache());
    db.read.mockResolvedValue(new Uint8Array(0));
    const { ctx } = createContext();
    const state = new AppState();
    const session = state.activateProject(1, 'sha-a');
    registerModelEvents(ctx, state, { onModelAdded: vi.fn(), onModelRemoved: vi.fn() });
    const entry = { name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'ifc-a' };

    await loadIfcEntry(ctx, state, entry, async () => new Uint8Array([4, 5]), undefined, { session });

    expect(db.remove).toHaveBeenCalledTimes(1);
    expect(ctx.ifcLoader.load).toHaveBeenCalledTimes(1);
    expect(perfSnapshot().fragmentsCache).toMatchObject({ attempts: 1, hits: 0, misses: 0, fallbacks: 1 });
    expect(perfSnapshot().fragmentsCache.operations.read).toMatchObject({ count: 1, bytes: 0 });
  });

  it('校验后读取到截断 frag 时按记录尺寸回退 IFC，不产生假命中', async () => {
    db.validate.mockResolvedValue(validCache());
    db.read.mockResolvedValue(new Uint8Array([1, 2]));
    const { ctx } = createContext();
    const state = new AppState();
    const session = state.activateProject(1, 'sha-a');
    registerModelEvents(ctx, state, { onModelAdded: vi.fn(), onModelRemoved: vi.fn() });
    const entry = { name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'ifc-a' };

    await loadIfcEntry(ctx, state, entry, async () => new Uint8Array([4, 5]), undefined, { session });

    expect(db.remove).toHaveBeenCalledTimes(1);
    expect(ctx.fragments.core.load).not.toHaveBeenCalled();
    expect(ctx.ifcLoader.load).toHaveBeenCalledTimes(1);
    expect(perfSnapshot().fragmentsCache).toMatchObject({
      attempts: 1,
      hits: 0,
      misses: 0,
      fallbacks: 1,
    });
  });

  it('Fragments 反序列化失败时删除缓存并回退 IFC', async () => {
    db.validate.mockResolvedValue(validCache());
    db.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const { ctx } = createContext();
    ctx.fragments.core.load.mockRejectedValueOnce(new Error('Malformed tile'));
    const state = new AppState();
    const session = state.activateProject(1, 'sha-a');
    registerModelEvents(ctx, state, { onModelAdded: vi.fn(), onModelRemoved: vi.fn() });
    const entry = { name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'ifc-a' };

    await loadIfcEntry(ctx, state, entry, async () => new Uint8Array([4, 5]), undefined, { session });

    expect(db.remove).toHaveBeenCalledTimes(1);
    expect(ctx.fragments.core.load).toHaveBeenCalledTimes(1);
    expect(ctx.ifcLoader.load).toHaveBeenCalledTimes(1);
    expect(perfSnapshot().fragmentsCache).toMatchObject({
      attempts: 1,
      hits: 0,
      misses: 0,
      fallbacks: 1,
    });
    expect(perfSnapshot().fragmentsCache.operations.load.failures).toBe(1);
  });

  it('旧 session 的迟到读取失败不删除新工程同路径缓存', async () => {
    db.validate.mockResolvedValue(validCache());
    let rejectRead!: (reason?: unknown) => void;
    db.read.mockImplementation(() => new Promise<Uint8Array>((_resolve, reject) => {
      rejectRead = reject;
    }));
    const { ctx } = createContext();
    const state = new AppState();
    const sessionA = state.activateProject(1, 'sha-a');
    registerModelEvents(ctx, state, { onModelAdded: vi.fn(), onModelRemoved: vi.fn() });
    const entry = { name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'ifc-a' };
    const pending = loadIfcEntry(ctx, state, entry, async () => new Uint8Array([4, 5]), undefined, { session: sessionA });

    // 让 A 的 read 在 B 激活后才失败，模拟跨工程迟到的 IPC reject。
    await Promise.resolve();
    state.invalidatePendingLoads();
    state.resetGimState();
    state.activateProject(2, 'sha-b');
    perfReset({ generation: 3, projectId: 2, sourceSha256: 'sha-b' });
    rejectRead(new Error('late read failure'));
    await pending;

    expect(db.remove).not.toHaveBeenCalled();
    expect(perfSnapshot().fragmentsCache).toMatchObject({
      enabled: null,
      attempts: 0,
      hits: 0,
      fallbacks: 0,
    });
  });

  it('旧 session 的迟到 validate/read 结果不污染新工程统计', async () => {
    let resolveValidation!: (value: ReturnType<typeof validCache>) => void;
    db.validate.mockImplementation(() => new Promise((resolve) => { resolveValidation = resolve; }));
    const { ctx } = createContext();
    const state = new AppState();
    const sessionA = state.activateProject(1, 'sha-a');
    registerModelEvents(ctx, state, { onModelAdded: vi.fn(), onModelRemoved: vi.fn() });
    const entry = { name: 'a.ifc', path: 'DEV/a.ifc', modelId: 'ifc-a' };
    const pending = loadIfcEntry(ctx, state, entry, async () => new Uint8Array([4]), undefined, { session: sessionA });

    state.invalidatePendingLoads();
    state.resetGimState();
    state.activateProject(2, 'sha-b');
    perfReset({ generation: 3, projectId: 2, sourceSha256: 'sha-b' });
    resolveValidation(validCache());
    await pending;

    expect(perfSnapshot().fragmentsCache).toMatchObject({ enabled: null, attempts: 0, hits: 0, misses: 0, fallbacks: 0 });
    expect(db.read).not.toHaveBeenCalled();
  });
});
