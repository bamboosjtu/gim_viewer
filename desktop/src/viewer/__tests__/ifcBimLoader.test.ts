import { afterEach, expect, it, vi } from 'vitest';
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
  cache.read.mockResolvedValue({ bytes: new Uint8Array([1, 2]).buffer, index });
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
  expect(state.ifcRegionalRuntimes.has('logical')).toBe(true);
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
  expect(state.ifcRegionalRuntimes.size).toBe(0);
});

it('a corrupt artifact retries source even when no failed model can be disposed', async () => {
  const { state, session, ctx, model } = setup();
  cache.read.mockResolvedValue({ bytes: new Uint8Array([1]).buffer, index });
  ctx.fragments.core.load.mockRejectedValue(Error('Invalid artifact'));
  ctx.fragments.core.disposeModel.mockRejectedValue(Error('Not registered'));
  cache.raw.mockImplementation(async (...args: any[]) => {
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
