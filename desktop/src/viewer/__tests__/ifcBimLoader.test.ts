import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { loadBimIfc } from '../ifcBimLoader.js';
const cache = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  raw: vi.fn(),
}));
vi.mock('@desktop/ifcLodCache.js', () => ({
  readIfcLodArtifact: cache.read,
  writeIfcLodArtifact: cache.write,
  deleteIfcLodArtifact: cache.remove,
}));
vi.mock('../ifcConversion.js', () => ({ loadRawIfc: cache.raw }));
vi.mock('../ifcRegionalRuntime.js', () => ({
  IfcRegionalRuntime: class {
    release() {}
  },
}));
afterEach(() => {
  vi.resetAllMocks();
});
const index = {
  objects: [
    {
      expressId: 1,
      globalId: 'guid',
      ifcType: 'IFCMEMBER',
      name: '',
      bounds: [0, 0, 0, 1, 1, 1],
    },
  ],
  openingRelations: [],
  unitScale: 1,
};
function setup() {
  const state = new AppState(),
    session = state.activateProject(1, 'source-sha'),
    model = {
      object: new THREE.Group(),
      getCoordinationMatrix: async () => new THREE.Matrix4(),
    };
  const ctx: any = {
    fragments: {
      baseCoordinationModel: 'base',
      list: new Map([['base', model]]),
      core: {
        settings: {},
        load: vi.fn(async () => model),
        disposeModel: vi.fn(),
      },
    },
  };
  return { state, session, ctx, model };
}
it('far artifact HIT restores without source read or conversion and attaches the original model identity', async () => {
  const { state, session, ctx } = setup();
  const release=vi.fn();state.ifc.regionalRuntimes.set('logical',{release} as any);
  const bytes = new Uint8Array([1, 2]).buffer;
  cache.read.mockResolvedValue({ bytes, index });
  const read = vi.fn();
  await loadBimIfc(
    ctx,
    state,
    session,
    'runtime',
    'logical',
    'CBM/a.ifc',
    read
  );
  expect(read).not.toHaveBeenCalled();
  expect(cache.raw).not.toHaveBeenCalled();
  expect(ctx.fragments.core.load).toHaveBeenCalledOnce();
  expect(ctx.fragments.core.load.mock.calls[0][0]).toBe(bytes);
  expect(state.ifc.regionalRuntimes.has('logical')).toBe(true);
  expect(release).toHaveBeenCalledOnce();
});
it('restores a valid empty regional index without treating it as a cache miss', async () => {
  const { state, session, ctx } = setup();
  cache.read.mockResolvedValue({ bytes: new Uint8Array([1, 2]).buffer, index: { ...index, objects: [] } });
  const read = vi.fn();
  const batches: any[] = [];
  const complete: any[] = [];
  await loadBimIfc(ctx, state, session, 'runtime', 'logical', 'CBM/empty.ifc', read, undefined, {
    onRegionalBatch: (batch) => batches.push(batch),
    onRegionalComplete: (meta) => complete.push(meta),
  });
  expect(read).not.toHaveBeenCalled();
  expect(cache.raw).not.toHaveBeenCalled();
  expect(batches).toHaveLength(0);
  expect(complete).toHaveLength(0); // A far-only hit is not a complete connection-mesh cache.
});
it('a cache read finishing after source switch cannot register a model', async () => {
  const { state, session, ctx } = setup();
  let resolve!: (data: any) => void;
  cache.read.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    })
  );
  const pending = loadBimIfc(
    ctx,
    state,
    session,
    'runtime',
    'logical',
    'CBM/a.ifc',
    vi.fn()
  );
  state.activateProject(2, 'B');
  resolve({ bytes: new Uint8Array([1]).buffer, index });
  await pending;
  expect(ctx.fragments.core.load).not.toHaveBeenCalled();
  expect(state.ifc.regionalRuntimes.size).toBe(0);
});

it('returns the far model before the derived cache write settles and records the write outcome', async () => {
  const { state, session, ctx, model } = setup();
  let finish!: () => void;
  cache.write.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  const batch = {sequence:0,objects:[],chunks:[],bytes:0,final:true};
  const complete = {objectCount:0,sequence:1};
  cache.raw.mockImplementation(async (...args: any[]) => {
    args[8].onRegionalBatch(batch);
    args[8].onRegionalComplete(complete);
    args[8].onFarArtifact(new Uint8Array([2]), index);
    return model;
  });
  const onRegionalBatch = vi.fn(), onRegionalComplete = vi.fn();
  const stages: string[] = [];
  const profiles: any[] = [];
  const resolved = await loadBimIfc(ctx, state, session, 'runtime', 'logical', 'CBM/a.ifc',
    vi.fn(async () => new Uint8Array([3])), undefined, {
      onStage: (stage) => stages.push(stage),
      onProfile: (profile) => profiles.push(profile),
      onRegionalBatch, onRegionalComplete,
    });
  expect(resolved).toBe(model);
  expect(stages).toContain('far-ready');
  expect(stages).toContain('cache-write-start');
  expect(onRegionalBatch).toHaveBeenCalledWith(batch);
  expect(onRegionalComplete).toHaveBeenCalledWith(complete);
  expect(cache.write).toHaveBeenCalledOnce();
  expect(cache.write.mock.calls[0][1]).toEqual({bytes: new Uint8Array([2]).buffer, index});
  expect(profiles).toHaveLength(0);
  finish();
  await vi.waitFor(() => expect(profiles).toHaveLength(1));
  expect(profiles[0].cacheWriteOk).toBe(true);
  expect(stages).toContain('cache-written');
});
it('a corrupt artifact retries source even when no failed model can be disposed', async () => {
  const { state, session, ctx, model } = setup();
  cache.read.mockResolvedValueOnce({ bytes: new Uint8Array([1]).buffer, index }).mockResolvedValue(null);
  ctx.fragments.core.load.mockRejectedValue(Error('Invalid artifact'));
  ctx.fragments.core.disposeModel.mockRejectedValue(Error('Not registered'));
  cache.raw.mockImplementation(async (...args: any[]) => {
    await args[3]();
    args[8].onFarArtifact(new Uint8Array([2]), index);
    return model;
  });
  const read = vi.fn(async () => new Uint8Array([3]));
  await loadBimIfc(ctx, state, session, 'runtime', 'logical', 'CBM/a.ifc', read);
  expect(read).toHaveBeenCalledOnce();
  expect(cache.remove).toHaveBeenCalledOnce();
  expect(cache.write).toHaveBeenCalledOnce();
  expect(model.object.userData.ifcLodCacheHit).toBe(false);
});

it('uses the standalone IFC digest for both the cache key and the exact conversion input', async () => {
  const {state,session,ctx}=setup();
  const bytes=new Uint8Array([0,97,98,99]).subarray(1);
  const sha256='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const read=vi.fn(async()=>bytes);
  vi.stubGlobal('crypto',webcrypto);
  const digest=vi.spyOn(webcrypto.subtle,'digest');
  try {
    await loadBimIfc(ctx,state,session,'runtime','logical','model.ifc',read,undefined,{standaloneSource:true});
    expect(read).toHaveBeenCalledOnce();
    expect(digest).toHaveBeenCalledOnce();
    expect(cache.read).toHaveBeenCalledWith(expect.stringContaining(`|${sha256}|model.ifc`));
    expect(cache.raw.mock.calls[0][3]).toBe(bytes);
    expect(cache.raw.mock.calls[0][8].sourceSha256).toBe(sha256);
  } finally { digest.mockRestore();vi.unstubAllGlobals(); }
});

it('loads a cached far model without reading or constructing a duplicate connection preview', async () => {
  const {state,session,ctx,model}=setup();
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  cache.read.mockResolvedValueOnce({bytes,index});
  const onRegionalBatch = vi.fn(), onRegionalComplete = vi.fn(), onProfile = vi.fn();
  ctx.fragments.core.load.mockImplementation(async(buffer: ArrayBuffer) => {
    structuredClone(buffer,{transfer:[buffer]});
    return model;
  });
  const sourceRead=vi.fn();
  await loadBimIfc(ctx,state,session,'runtime','logical','CBM/a.ifc',sourceRead,undefined,{
    onRegionalBatch,onRegionalComplete,onProfile,
  });
  expect(cache.read).toHaveBeenCalledOnce();
  expect(cache.raw).not.toHaveBeenCalled();
  expect(sourceRead).not.toHaveBeenCalled();
  expect(onRegionalBatch).not.toHaveBeenCalled();
  expect(onRegionalComplete).not.toHaveBeenCalled();
  expect(bytes.byteLength).toBe(0);
  expect(onProfile).toHaveBeenCalledWith(expect.objectContaining({bytes:3,cacheHit:true}));
});
it('keeps a partial preview live without publishing completion or a far cache for an interrupted stream', async () => {
  const {state,session,ctx}=setup();
  const complete=vi.fn(), preview=vi.fn();
  const batch = {sequence:0,objects:[],chunks:[],bytes:0,final:false};
  cache.raw.mockImplementation(async (...args:any[])=>{
    args[8].onRegionalBatch(batch);
    throw Error('source interrupted');
  });
  await expect(loadBimIfc(ctx,state,session,'runtime','logical','CBM/a.ifc',async()=>new Uint8Array([1]),undefined,
    {onRegionalBatch:preview,onRegionalComplete:complete})).rejects.toThrow('source interrupted');
  expect(preview).toHaveBeenCalledWith(batch);
  expect(complete).not.toHaveBeenCalled();expect(cache.write).not.toHaveBeenCalled();
});

it('a project switch during warm deserialization disposes the old far model', async () => {
  const {state,session,ctx,model}=setup();
  cache.read.mockResolvedValueOnce({bytes:new Uint8Array([1]).buffer,index});
  ctx.fragments.core.load.mockImplementation(async () => {
    state.activateProject(2,'new-sha');
    return model;
  });
  await loadBimIfc(ctx,state,session,'runtime','logical','CBM/a.ifc',vi.fn());
  expect(ctx.fragments.core.disposeModel).toHaveBeenCalledWith('runtime');
  expect(state.ifc.regionalRuntimes.size).toBe(0);
  expect(cache.raw).not.toHaveBeenCalled();
});
