import { afterEach,describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../../../app/state.js';
import type { CbmNode, IfcEntry } from '../../../../gim/types.js';
import { loadAllIfcFiles } from '../substationIfcRuntime.js';
import { isSubstationViewerInteractive } from '../substationLoadingState.js';
import { perfMarkProductMoment, perfProductMomentSnapshot, perfReset, perfSnapshot } from '../../../../utils/perfTimings.js';

const mocks = vi.hoisted(() => ({
  frames:[] as Array<()=>void>,
  ensureEngineReady: vi.fn(),
  loadIfcEntry: vi.fn(),
  getViewerRuntimeWithUI: vi.fn(),
  syncProjectSourceToViewerFromFragments: vi.fn(),
  loadManualCoordOffsetFromLocalStorage: vi.fn(),
  buildIfcNameIndex: vi.fn(),
  fitCameraToScene: vi.fn(),
  fitCameraToStationOverview: vi.fn(),
  buildAndRenderCbmTree: vi.fn(),
  renderFileDevPanel: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
  setIfcStatus: vi.fn(),
}));
vi.mock('../../../../services/presentation/geometryPresentationService.js',()=>({observeFirstGeometry:vi.fn(async(_state,_ctx,_root,_session,onPresented,perf)=>{
  mocks.frames.push(()=>{perfMarkProductMoment('firstVisibleGeometryReady',{test:true},perf);perfMarkProductMoment('firstGeometryReady',{test:true},perf);perfMarkProductMoment('interactive',{test:true},perf);onPresented?.();});
})}));

vi.mock('../../../../services/presentation/shell_statusBar.js',async importOriginal=>({...(await importOriginal<typeof import('../../../../services/presentation/shell_statusBar.js')>()),setIfcStatus:mocks.setIfcStatus,setConnectionStatus:vi.fn()}));

vi.mock('../../../../viewer/ifcLoader.js', () => ({ ensureEngineReady: mocks.ensureEngineReady }));
vi.mock('../../../../viewer/ifcEntryLoader.js', () => ({ loadIfcEntry: mocks.loadIfcEntry }));
vi.mock('../../../../services/engineering/ifcNameIndex.js', () => ({ buildIfcNameIndex: mocks.buildIfcNameIndex }));
vi.mock('../../../../viewer/camera.js', () => ({
  fitCameraToScene: mocks.fitCameraToScene,
  fitCameraToStationOverview: mocks.fitCameraToStationOverview,
}));
vi.mock('../../../../services/presentation/viewerUIBinding.js', () => ({ getViewerRuntimeWithUI: mocks.getViewerRuntimeWithUI }));
vi.mock('../../../../services/project/coordinateAlignmentService.js', () => ({
  syncProjectSourceToViewerFromFragments: mocks.syncProjectSourceToViewerFromFragments,
  loadManualCoordOffsetFromLocalStorage: mocks.loadManualCoordOffsetFromLocalStorage,
}));
vi.mock('../../../../ui/cbmTreeView.js', () => ({ buildAndRenderCbmTree: mocks.buildAndRenderCbmTree }));
vi.mock('../../../../ui/fileDevView.js', () => ({ renderFileDevPanel: mocks.renderFileDevPanel }));
vi.mock('../../../../services/project/gimOpenCore.js', () => ({
  showLoading: mocks.showLoading,
  hideLoading: mocks.hideLoading,
  recordNativeExtractionStages: vi.fn(),
  resolveProjectName: vi.fn((headerName?: string, headerId?: string, fileName?: string) => headerName || headerId || fileName || ''),
}));
vi.mock('@desktop/runtime.js', () => ({ isTauri: () => false }));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeTree(): CbmNode {
  return {
    path: 'CBM/root.cbm',
    name: 'root',
    entityName: 'F1System',
    children: [],
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

describe('Substation Loading readiness lifecycle', () => {
  afterEach(()=>{vi.restoreAllMocks();});
  it('clears the pending barrier when viewer initialization rejects', async () => {
    vi.clearAllMocks();
    const state = new AppState();
    state.currentCbmTree = makeTree();
    const entries: IfcEntry[] = [{ path: 'a.ifc', name: 'a', modelId: 'a' } as IfcEntry];
    state.currentIfcEntries = entries;
    const session = state.activateProject(7, 'sha-substation');
    perfReset({ generation: session.generation, projectId: session.projectId, sourceSha256: session.sourceSha256 });
    mocks.getViewerRuntimeWithUI.mockRejectedValueOnce(new Error('viewer failed'));
    await expect(loadAllIfcFiles(state, entries, vi.fn(), { session })).rejects.toThrow('viewer failed');
    expect(state.ifcLoading.pending).toBe(false);
  });

  it('returns at first usable IFC, isolates spatial failure, and keeps the IFC tail sequential', async () => {
    vi.clearAllMocks();
    mocks.frames.length=0;
    const paintCallbacks:FrameRequestCallback[]=[];
    vi.spyOn(globalThis,'requestAnimationFrame').mockImplementation(callback=>{paintCallbacks.push(callback);return paintCallbacks.length;});
    const backgroundStarted=deferred<void>();
    const secondIfcGate = deferred<void>();
    const secondIfcStarted = deferred<void>();
    let firstProgress!: (amount: number) => void;
    const spatialStart = vi.fn(() => {
      backgroundStarted.resolve();
      expect(perfProductMomentSnapshot().interactive).not.toBeNull();
      perfMarkProductMoment('spatialSemanticStart', { test: true });
      throw new Error('test spatial semantic failure');
    });
    const stdSldStart = vi.fn(() => {
      expect(perfProductMomentSnapshot().interactive).not.toBeNull();
      perfMarkProductMoment('stdSldStart', { test: true });
      perfMarkProductMoment('stdSldReady', { test: true });
    });
    const cachePersistenceStart = vi.fn(() => {
      expect(perfProductMomentSnapshot().interactive).not.toBeNull();
      perfMarkProductMoment('cachePersistenceStart', { test: true });
      perfMarkProductMoment('cachePersistenceReady', { test: true });
    });
    const entries: IfcEntry[] = [
      { name: 'first.ifc', path: 'DEV/first.ifc', modelId: 'first' },
      { name: 'second.ifc', path: 'DEV/second.ifc', modelId: 'second' },
    ];
    const fragmentsList = new Map<string, { object: { children: unknown[] } }>();
    const ctx = {
      fragments: {
        list: fragmentsList,
        core: { disposeModel: vi.fn() },
      },
      world: { scene: { three: new THREE.Scene() } },
    } as any;

    mocks.getViewerRuntimeWithUI.mockResolvedValue({ ctx, modelCallbacks: {} });
    mocks.ensureEngineReady.mockResolvedValue(undefined);
    mocks.buildIfcNameIndex.mockResolvedValue(undefined);
    mocks.fitCameraToScene.mockImplementation(() => undefined);
    mocks.syncProjectSourceToViewerFromFragments.mockImplementation(async (state: AppState) => {
      state.projectSourceToViewerMatrix = new THREE.Matrix4();
    });
    mocks.loadIfcEntry.mockImplementation(async (
      runtimeCtx: any,
      state: AppState,
      entry: IfcEntry,
      _getIfcBuffer: unknown,
      onProgress: (amount: number) => void,
      options: { session?: ReturnType<AppState['captureProjectSession']>; onLoadSource?: (source: 'ifc') => void },
    ) => {
      if (entry.modelId === 'second') {
        secondIfcStarted.resolve();
        await secondIfcGate.promise;
      }
      if (entry.modelId === 'first') {
        expect(spatialStart).not.toHaveBeenCalled();
        firstProgress = onProgress;
      }
      if (!options.session || !state.isCurrentSession(options.session)) return;
      const runtimeModelId = state.ifc.getRuntimeModelId(entry.modelId, options.session);
      state.ifc.loadedModels.set(entry.modelId, { modelId: entry.modelId, runtimeModelId, visible: true });
      runtimeCtx.fragments.list.set(runtimeModelId, { object: { children: [] } });
      options.onLoadSource?.('ifc');
    });

    const state = new AppState();
    state.currentCbmTree = makeTree();
    state.currentIfcEntries = entries;
    state.currentFiles = null;
    const session = state.activateProject(7, 'sha-substation');
    perfReset({ generation: session.generation, projectId: session.projectId, sourceSha256: session.sourceSha256 });

    const loading = loadAllIfcFiles(state, entries, vi.fn(), {
      session,
      startSpatialSemantic: spatialStart,
      startStdSld: stdSldStart,
      startCachePersistence: cachePersistenceStart,
    });

    // The public promise must settle while the sequential IFC tail is still
    // held. Await that contract instead of racing cold dynamic imports against
    // waitFor's one-second polling deadline.
    await loading;
    await secondIfcStarted.promise;

    expect(perfProductMomentSnapshot().interactive).toBeNull();
    expect(isSubstationViewerInteractive(state)).toBe(false);
    expect(spatialStart).not.toHaveBeenCalled();expect(cachePersistenceStart).not.toHaveBeenCalled();
    expect(mocks.hideLoading).not.toHaveBeenCalled();
    const statusCount = mocks.setIfcStatus.mock.calls.length;
    firstProgress(.6);
    expect(mocks.setIfcStatus).toHaveBeenCalledTimes(statusCount);
    mocks.frames[0]();
    expect(isSubstationViewerInteractive(state)).toBe(true);
    expect(spatialStart).not.toHaveBeenCalled();
    expect(paintCallbacks.length).toBeGreaterThan(0);
    for(const callback of paintCallbacks.splice(0))callback(0);
    await backgroundStarted.promise;
    expect(spatialStart).toHaveBeenCalledOnce();

    expect(mocks.fitCameraToStationOverview).toHaveBeenCalledTimes(1);
    expect(mocks.loadIfcEntry).toHaveBeenCalledTimes(2);
    expect(spatialStart).toHaveBeenCalledTimes(1);
    expect(stdSldStart).toHaveBeenCalledTimes(1);
    expect(cachePersistenceStart).toHaveBeenCalledTimes(1);
    expect(perfProductMomentSnapshot().firstIfcLoadStart).not.toBeNull();
    expect(perfProductMomentSnapshot().stdSldStart).not.toBeNull();
    expect(perfProductMomentSnapshot().stdSldReady).not.toBeNull();
    expect(perfProductMomentSnapshot().cachePersistenceStart).not.toBeNull();
    expect(perfProductMomentSnapshot().cachePersistenceReady).not.toBeNull();
    expect(perfProductMomentSnapshot().spatialSemanticStart).not.toBeNull();
    expect(perfProductMomentSnapshot().firstUsableGeometryReady).not.toBeNull();
    expect(perfProductMomentSnapshot().interactive).not.toBeNull();
    expect(perfProductMomentSnapshot().firstIfcLoadStart!.atMs)
      .toBeLessThan(perfProductMomentSnapshot().interactive!.atMs);
    expect(perfProductMomentSnapshot().spatialSemanticStart!.atMs)
      .toBeGreaterThanOrEqual(perfProductMomentSnapshot().interactive!.atMs);
    expect(perfProductMomentSnapshot().stdSldStart!.atMs)
      .toBeGreaterThanOrEqual(perfProductMomentSnapshot().interactive!.atMs);
    expect(perfProductMomentSnapshot().cachePersistenceStart!.atMs)
      .toBeGreaterThanOrEqual(perfProductMomentSnapshot().interactive!.atMs);
    expect(perfProductMomentSnapshot().allIfcReady).toBeNull();

    secondIfcGate.resolve();
    await vi.waitFor(() => expect(perfProductMomentSnapshot().allIfcReady).not.toBeNull());
    expect(state.ifc.loadedModels.size).toBe(2);
    expect(perfProductMomentSnapshot().interactive!.atMs)
      .toBeLessThanOrEqual(perfProductMomentSnapshot().allIfcReady!.atMs);
    await loading;
    await vi.waitFor(()=>expect(mocks.setIfcStatus).toHaveBeenLastCalledWith(expect.stringContaining('IFC 已结束')));
  });

  it('releases opening on session invalidation before an outstanding model settles', async () => {
    vi.clearAllMocks();
    mocks.frames.length = 0;
    const first = deferred<void>(), started = deferred<void>();
    const entries = ['first', 'second'].map(modelId => ({ modelId, name: modelId, path: `${modelId}.ifc` }));
    const state = new AppState(), session = state.activateProject(7, 'source-a');
    state.currentIfcEntries = entries;
    state.currentFiles = new Map();
    const ctx = { fragments: { list: new Map(), core: { disposeModel: vi.fn() } }, world: { scene: { three: new THREE.Scene() } } };
    mocks.getViewerRuntimeWithUI.mockResolvedValue({ ctx, modelCallbacks: {} });
    mocks.ensureEngineReady.mockResolvedValue(undefined);
    let done = false;
    let notify!: () => void;
    mocks.loadIfcEntry.mockImplementation(async (_ctx, _state, _entry, _read, progress, options) => {
      notify = () => {
        progress(.5);
        options.onLoadSource('ifc');
        options.onStage('cache-write-failed');
      };
      started.resolve();
      await first.promise;
      notify();
    });
    const opening = loadAllIfcFiles(state, entries, vi.fn(), { session }).then(() => { done = true; });
    try {
      await started.promise;
      state.activateProject(8, 'source-b');
      expect(state.ifcLoading.pending).toBe(false);
      state.ifcLoading.pending = true;
      const status = mocks.setIfcStatus.mock.calls.length;
      const loading = mocks.showLoading.mock.calls.length;
      notify();
      await vi.waitFor(() => expect(done).toBe(true));
      expect(mocks.loadIfcEntry).toHaveBeenCalledOnce();
      expect(mocks.setIfcStatus).toHaveBeenCalledTimes(status);
      expect(mocks.showLoading).toHaveBeenCalledTimes(loading);
      expect(mocks.frames).toHaveLength(0);
      expect(state.ifcLoading.pending).toBe(true);
    } finally {
      first.resolve();
      await opening;
    }
  });

  it('keeps a handed-off IFC when presentation fails and continues to the next entry', async () => {
    vi.clearAllMocks();
    mocks.frames.length = 0;
    const entries = ['first', 'second'].map(modelId => ({ modelId, name: modelId, path: `${modelId}.ifc` }));
    const state = new AppState(), session = state.activateProject(7, 'source-a');
    state.currentIfcEntries = entries;
    const list = new Map();
    const disposeModel = vi.fn();
    const ctx = { fragments: { list, core: { disposeModel } }, world: { scene: { three: new THREE.Scene() } } };
    mocks.getViewerRuntimeWithUI.mockResolvedValue({ ctx, modelCallbacks: {} });
    mocks.ensureEngineReady.mockResolvedValue(undefined);
    mocks.syncProjectSourceToViewerFromFragments.mockImplementation(async () => {
      state.projectSourceToViewerMatrix = new THREE.Matrix4();
    });
    mocks.fitCameraToStationOverview.mockImplementationOnce(() => { throw Error('camera failed'); });
    mocks.loadIfcEntry.mockImplementation(async (_ctx, _state, entry: IfcEntry, _read, _progress, options) => {
      const runtimeModelId = state.ifc.getRuntimeModelId(entry.modelId, session);
      state.ifc.loadedModels.set(entry.modelId, { modelId: entry.modelId, runtimeModelId, visible: true });
      list.set(runtimeModelId, { object: new THREE.Group() });
      options.onLoadSource('ifc');
    });
    await loadAllIfcFiles(state, entries, vi.fn(), { session });
    await vi.waitFor(() => expect(state.ifcLoading.pending).toBe(false));
    expect(mocks.loadIfcEntry).toHaveBeenCalledTimes(2);
    expect(state.ifc.loadedModels.size).toBe(2);
    expect(disposeModel).not.toHaveBeenCalled();
    expect(mocks.frames).toHaveLength(1);
    expect(isSubstationViewerInteractive(state)).toBe(false);
  });

  it('keeps the cold IFC terminal status after late cache/progress callbacks without losing cache failures',async()=>{
    vi.clearAllMocks();
    const state=new AppState(),session=state.activateProject(7,'anonymous-b1');
    const entry:IfcEntry={name:'model.ifc',path:'CBM/model.ifc',modelId:'model'};
    state.currentCbmTree=makeTree();state.currentFiles=new Map();state.currentIfcEntries=[entry];
    perfReset({generation:session.generation,projectId:session.projectId,sourceSha256:session.sourceSha256});
    const ctx={fragments:{list:new Map(),core:{disposeModel:vi.fn()}},world:{scene:{three:new THREE.Scene()}}} as any;
    mocks.getViewerRuntimeWithUI.mockResolvedValue({ctx,modelCallbacks:{}});mocks.ensureEngineReady.mockResolvedValue(undefined);
    const nameIndexGate=deferred<void>();
    mocks.buildIfcNameIndex.mockReturnValue(nameIndexGate.promise);
    mocks.syncProjectSourceToViewerFromFragments.mockImplementation(async()=>{state.projectSourceToViewerMatrix=new THREE.Matrix4();});
    let progress!:(p:number)=>void,callbacks!:{onStage:(stage:string)=>void;onLoadSource:(source:'ifc'|'lod-cache')=>void};
    mocks.loadIfcEntry.mockImplementation(async(_ctx:any,_state:AppState,item:IfcEntry,_read:unknown,onProgress:(p:number)=>void,options:typeof callbacks)=>{
      progress=onProgress;callbacks=options;const runtimeModelId=state.ifc.getRuntimeModelId(item.modelId,session);
      state.ifc.loadedModels.set(item.modelId,{modelId:item.modelId,runtimeModelId,visible:true});ctx.fragments.list.set(runtimeModelId,{object:{children:[]}});options.onLoadSource('ifc');
    });
    await loadAllIfcFiles(state,[entry],vi.fn(),{session,ifcSourceSizes:new Map([[entry.path,8]])});
    await vi.waitFor(()=>expect(mocks.setIfcStatus).toHaveBeenLastCalledWith(expect.stringContaining('IFC 已结束')));
    expect(perfProductMomentSnapshot().allIfcReady).not.toBeNull();
    const terminal=mocks.setIfcStatus.mock.calls[mocks.setIfcStatus.mock.calls.length-1][0];
    callbacks.onStage('cache-written');callbacks.onStage('cold-convert');progress(.4);callbacks.onLoadSource('lod-cache');
    expect(mocks.setIfcStatus).toHaveBeenLastCalledWith(terminal);
    callbacks.onStage('cache-write-failed');
    expect(mocks.setIfcStatus).toHaveBeenLastCalledWith(expect.stringMatching(/IFC 已结束.*缓存写入失败 1/));
    callbacks.onStage('cache-written');expect(mocks.setIfcStatus).toHaveBeenLastCalledWith(terminal);
    state.activateProject(8,'next');nameIndexGate.resolve();const count=mocks.setIfcStatus.mock.calls.length;
    callbacks.onStage('cache-write-failed');progress(.5);expect(mocks.setIfcStatus).toHaveBeenCalledTimes(count);
  });

  it('continues after one IFC fails and records a later cache hit without reading its source', async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = new AppState();
    const session = state.activateProject(7, 'sha-substation');
    const entries: IfcEntry[] = [
      { name:'cold',path:'models/cold.ifc',modelId:'cold' },
      { name:'warm',path:'models/warm.ifc',modelId:'warm' },
    ];
    const readFailedSource = vi.fn(async () => new ArrayBuffer(16));
    const readWarmSource = vi.fn(async () => new ArrayBuffer(32));
    state.currentFiles = new Map([
      [entries[0].path, {size:16,arrayBuffer:readFailedSource} as unknown as File],
      [entries[1].path, {size:32,arrayBuffer:readWarmSource} as unknown as File],
    ]);
    state.currentCbmTree = makeTree();
    const list = new Map<string,{object:THREE.Group}>();
    const ctx = { fragments:{list,core:{disposeModel:vi.fn()}}, world:{scene:{three:new THREE.Scene()}} };
    mocks.getViewerRuntimeWithUI.mockResolvedValue({ctx,modelCallbacks:{}});
    mocks.ensureEngineReady.mockResolvedValue(undefined);
    mocks.buildIfcNameIndex.mockResolvedValue(undefined);
    mocks.syncProjectSourceToViewerFromFragments.mockImplementation(async () => {
      state.projectSourceToViewerMatrix = new THREE.Matrix4();
    });
    mocks.loadIfcEntry.mockImplementation(async (
      _ctx: unknown,
      _state: AppState,
      entry: IfcEntry,
      read: () => Promise<Uint8Array | null>,
      _progress: unknown,
      options: {onLoadSource?: (source: 'lod-cache') => void},
    ) => {
      if (entry.modelId === 'cold') {
        await read();
        throw new Error('source decode failed');
      }
      const runtimeModelId = state.ifc.getRuntimeModelId(entry.modelId, session);
      state.ifc.registerIfcRuntimeModel(entry.modelId, runtimeModelId, session);
      state.ifc.loadedModels.set(entry.modelId, {modelId:entry.modelId,runtimeModelId,visible:true});
      list.set(runtimeModelId, {object:new THREE.Group()});
      options.onLoadSource?.('lod-cache');
    });
    perfReset({generation:session.generation,projectId:session.projectId,sourceSha256:session.sourceSha256});

    await loadAllIfcFiles(state, entries, vi.fn(), {session});

    await vi.waitFor(() => expect(perfProductMomentSnapshot().allIfcReady?.meta).toMatchObject({
      total:2, loaded:1, failed:1,
    }));
    expect(readFailedSource).toHaveBeenCalledOnce();
    expect(readWarmSource).not.toHaveBeenCalled();
    expect(perfProductMomentSnapshot().firstUsableGeometryReady?.meta).toMatchObject({
      name:'warm', cacheHit:true,
    });
    expect(perfSnapshot().spans).toContainEqual(expect.objectContaining({
      label:'变电 IFC read · models/warm.ifc',
      meta:{bytes:0,source:'not-read',found:false},
    }));
    expect(mocks.setIfcStatus).toHaveBeenLastCalledWith(expect.stringContaining('失败 1'));
  });
});
