import { afterEach,describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import type { CbmNode, IfcEntry } from '../../gim/types.js';
import { loadAllIfcFiles } from '../openGimService.js';
import { perfMarkProductMoment, perfProductMomentSnapshot, perfReset } from '../../utils/perfTimings.js';

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
  autoLoadModAndStlGeometry: vi.fn(),
  buildAndRenderCbmTree: vi.fn(),
  renderFileDevPanel: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
  setIfcStatus: vi.fn(),
}));
vi.mock('../geometryPresentationService.js',()=>({observeFirstGeometry:vi.fn(async(_state,_ctx,_root,_session,onPresented,perf)=>{
  mocks.frames.push(()=>{perfMarkProductMoment('firstVisibleGeometryReady',{test:true},perf);perfMarkProductMoment('firstGeometryReady',{test:true},perf);perfMarkProductMoment('interactive',{test:true},perf);onPresented?.();});
})}));

vi.mock('../presentation/shell_statusBar.js',async importOriginal=>({...(await importOriginal<typeof import('../presentation/shell_statusBar.js')>()),setIfcStatus:mocks.setIfcStatus,setConnectionStatus:vi.fn()}));

vi.mock('../../viewer/ifcLoader.js', () => ({ ensureEngineReady: mocks.ensureEngineReady }));
vi.mock('../../viewer/ifcEntryLoader.js', () => ({ loadIfcEntry: mocks.loadIfcEntry }));
vi.mock('../../viewer/ifcNameIndex.js', () => ({ buildIfcNameIndex: mocks.buildIfcNameIndex }));
vi.mock('../../viewer/camera.js', () => ({
  fitCameraToScene: mocks.fitCameraToScene,
  fitCameraToStationOverview: mocks.fitCameraToStationOverview,
}));
vi.mock('../viewerUIBinding.js', () => ({ getViewerRuntimeWithUI: mocks.getViewerRuntimeWithUI }));
vi.mock('../coordinateAlignmentService.js', () => ({
  syncProjectSourceToViewerFromFragments: mocks.syncProjectSourceToViewerFromFragments,
  loadManualCoordOffsetFromLocalStorage: mocks.loadManualCoordOffsetFromLocalStorage,
}));
vi.mock('../modAutoLoadService.js', () => ({ autoLoadModAndStlGeometry: mocks.autoLoadModAndStlGeometry,
  isGeometryTokenValid:(state:AppState,token:number)=>state.geometryLoadToken===token }));
vi.mock('../../ui/cbmTreeView.js', () => ({ buildAndRenderCbmTree: mocks.buildAndRenderCbmTree }));
vi.mock('../../ui/fileDevView.js', () => ({ renderFileDevPanel: mocks.renderFileDevPanel }));
vi.mock('../gimOpenCore.js', () => ({
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
  it('returns at first usable IFC, isolates spatial failure, and keeps the IFC tail sequential', async () => {
    vi.clearAllMocks();
    mocks.frames.length=0;
    const paintCallbacks:FrameRequestCallback[]=[];
    vi.spyOn(globalThis,'requestAnimationFrame').mockImplementation(callback=>{paintCallbacks.push(callback);return paintCallbacks.length;});
    const backgroundStarted=deferred<void>();
    const secondIfcGate = deferred<void>();
    const secondIfcStarted = deferred<void>();
    const spatialGate = deferred<void>();
    const spatialStart = vi.fn(() => {
      backgroundStarted.resolve();
      // A real spatial starter owns its promise and is intentionally not
      // awaited by loadAllIfcFiles.  Keep this one pending to prove that the
      // interactive caller is independent from it.
      void spatialGate.promise;
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
    mocks.autoLoadModAndStlGeometry.mockResolvedValue({ modCount: 0, stlCount: 0 });
    mocks.loadIfcEntry.mockImplementation(async (
      runtimeCtx: any,
      state: AppState,
      entry: IfcEntry,
      _getIfcBuffer: unknown,
      _onProgress: unknown,
      options: { session?: ReturnType<AppState['captureProjectSession']>; onLoadSource?: (source: 'ifc') => void },
    ) => {
      if (entry.modelId === 'second') {
        secondIfcStarted.resolve();
        await secondIfcGate.promise;
      }
      if (entry.modelId === 'first') expect(spatialStart).not.toHaveBeenCalled();
      if (!options.session || !state.isCurrentSession(options.session)) return;
      const runtimeModelId = state.getRuntimeModelId(entry.modelId, options.session);
      state.loadedModels.set(entry.modelId, { modelId: entry.modelId, runtimeModelId, visible: true });
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
    let callerSettled = false;
    void loading.then(() => { callerSettled = true; });

    // The public promise must settle while the sequential IFC tail is still
    // held. Await that contract instead of racing cold dynamic imports against
    // waitFor's one-second polling deadline.
    await loading;
    await secondIfcStarted.promise;

    expect(perfProductMomentSnapshot().interactive).toBeNull();
    expect(spatialStart).not.toHaveBeenCalled();expect(cachePersistenceStart).not.toHaveBeenCalled();
    expect(mocks.hideLoading).not.toHaveBeenCalled();
    mocks.frames[0]();
    expect(spatialStart).not.toHaveBeenCalled();
    expect(paintCallbacks.length).toBeGreaterThan(0);
    for(const callback of paintCallbacks.splice(0))callback(0);
    await backgroundStarted.promise;
    expect(spatialStart).toHaveBeenCalledOnce();

    expect(mocks.fitCameraToStationOverview).toHaveBeenCalledTimes(1);
    expect(callerSettled).toBe(true);
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
    expect(state.loadedModels.size).toBe(2);
    expect(perfProductMomentSnapshot().interactive!.atMs)
      .toBeLessThanOrEqual(perfProductMomentSnapshot().allIfcReady!.atMs);
    await loading;
    spatialGate.resolve();
    await vi.waitFor(()=>expect(mocks.setIfcStatus).toHaveBeenLastCalledWith(expect.stringContaining('IFC 已结束')));
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
    mocks.buildIfcNameIndex.mockReturnValue(nameIndexGate.promise);mocks.autoLoadModAndStlGeometry.mockResolvedValue({modCount:0,stlCount:0});
    mocks.syncProjectSourceToViewerFromFragments.mockImplementation(async()=>{state.projectSourceToViewerMatrix=new THREE.Matrix4();});
    let progress!:(p:number)=>void,callbacks!:{onStage:(stage:string)=>void;onLoadSource:(source:'ifc'|'lod-cache')=>void};
    mocks.loadIfcEntry.mockImplementation(async(_ctx:any,_state:AppState,item:IfcEntry,_read:unknown,onProgress:(p:number)=>void,options:typeof callbacks)=>{
      progress=onProgress;callbacks=options;const runtimeModelId=state.getRuntimeModelId(item.modelId,session);
      state.loadedModels.set(item.modelId,{modelId:item.modelId,runtimeModelId,visible:true});ctx.fragments.list.set(runtimeModelId,{object:{children:[]}});options.onLoadSource('ifc');
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
});
