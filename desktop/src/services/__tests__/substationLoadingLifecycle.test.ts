import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import type { CbmNode, IfcEntry } from '../../gim/types.js';
import { loadAllIfcFiles } from '../openGimService.js';
import { perfMarkProductMoment, perfProductMomentSnapshot, perfReset } from '../../utils/perfTimings.js';

const mocks = vi.hoisted(() => ({
  ensureEngineReady: vi.fn(),
  loadIfcEntry: vi.fn(),
  getViewerRuntimeWithUI: vi.fn(),
  syncProjectSourceToViewerFromFragments: vi.fn(),
  loadManualCoordOffsetFromLocalStorage: vi.fn(),
  buildIfcNameIndex: vi.fn(),
  fitCameraToScene: vi.fn(),
  autoLoadModAndStlGeometry: vi.fn(),
  buildAndRenderCbmTree: vi.fn(),
  renderFileDevPanel: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

vi.mock('../../viewer/ifcLoader.js', () => ({ ensureEngineReady: mocks.ensureEngineReady }));
vi.mock('../../viewer/ifcEntryLoader.js', () => ({ loadIfcEntry: mocks.loadIfcEntry }));
vi.mock('../../viewer/ifcNameIndex.js', () => ({ buildIfcNameIndex: mocks.buildIfcNameIndex }));
vi.mock('../../viewer/camera.js', () => ({ fitCameraToScene: mocks.fitCameraToScene }));
vi.mock('../viewerUIBinding.js', () => ({ getViewerRuntimeWithUI: mocks.getViewerRuntimeWithUI }));
vi.mock('../coordinateAlignmentService.js', () => ({
  syncProjectSourceToViewerFromFragments: mocks.syncProjectSourceToViewerFromFragments,
  loadManualCoordOffsetFromLocalStorage: mocks.loadManualCoordOffsetFromLocalStorage,
}));
vi.mock('../modAutoLoadService.js', () => ({ autoLoadModAndStlGeometry: mocks.autoLoadModAndStlGeometry }));
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

describe('Substation Loading v2 readiness lifecycle', () => {
  it('returns at first usable IFC, isolates spatial failure, and keeps the IFC tail sequential', async () => {
    vi.clearAllMocks();
    const secondIfcGate = deferred<void>();
    const spatialGate = deferred<void>();
    const spatialStart = vi.fn(() => {
      // A real spatial starter owns its promise and is intentionally not
      // awaited by loadAllIfcFiles.  Keep this one pending to prove that the
      // interactive caller is independent from it.
      void spatialGate.promise;
      expect(perfProductMomentSnapshot().interactive).not.toBeNull();
      perfMarkProductMoment('spatialSemanticStart', { test: true });
      throw new Error('test spatial semantic failure');
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
      if (entry.modelId === 'second') await secondIfcGate.promise;
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
    });
    let callerSettled = false;
    void loading.then(() => { callerSettled = true; });

    await vi.waitFor(() => expect(mocks.fitCameraToScene).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(callerSettled).toBe(true);
    expect(mocks.loadIfcEntry).toHaveBeenCalledTimes(2);
    expect(spatialStart).toHaveBeenCalledTimes(1);
    expect(perfProductMomentSnapshot().firstIfcLoadStart).not.toBeNull();
    expect(perfProductMomentSnapshot().spatialSemanticStart).not.toBeNull();
    expect(perfProductMomentSnapshot().firstUsableGeometryReady).not.toBeNull();
    expect(perfProductMomentSnapshot().interactive).not.toBeNull();
    expect(perfProductMomentSnapshot().spatialSemanticStart!.atMs)
      .toBeGreaterThanOrEqual(perfProductMomentSnapshot().interactive!.atMs);
    expect(perfProductMomentSnapshot().allIfcReady).toBeNull();

    secondIfcGate.resolve();
    await vi.waitFor(() => expect(perfProductMomentSnapshot().allIfcReady).not.toBeNull());
    expect(state.loadedModels.size).toBe(2);
    expect(perfProductMomentSnapshot().interactive!.atMs)
      .toBeLessThanOrEqual(perfProductMomentSnapshot().allIfcReady!.atMs);
    await loading;
    spatialGate.resolve();
  });
});
