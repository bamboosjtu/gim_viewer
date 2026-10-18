import {afterEach,expect,it,vi} from 'vitest';
import * as THREE from 'three';
import {AppState} from '../../app/state.js';
import {DevLodRuntime} from '../devLodRuntime.js';
const mock=vi.hoisted(()=>({read:vi.fn(),parse:vi.fn(),compile:vi.fn(),cancel:vi.fn(),catalog:vi.fn(),bounds:vi.fn(),workerCount:2}));
vi.mock('@desktop/devLodCache.js',()=>({readDevArtifactResult:mock.catalog,
  readDevArtifactBatch:mock.read,writeDevArtifactDetailed:async()=>({ok:true}),deleteDevArtifact:vi.fn()}));
vi.mock('../glbCacheService.js',()=>({parseDevGlbAsset:mock.parse}));
vi.mock('../devGeometryWorkerClient.js',()=>({createDevGeometryPreprocessor:()=>({workerCount:mock.workerCount,activePaths:[],compile:mock.compile,cancel:mock.cancel,bounds:mock.bounds,
  acknowledge:vi.fn(),promote:vi.fn(),cancelQueued:vi.fn()})}));
vi.mock('../modAutoLoadService.js',async(importActual)=>({...await importActual<any>(),collectCbmDeviceInstances:()=>[
  {path:'root/a',devPath:'shared.dev',name:'a',transformMatrix:''},{path:'root/b',devPath:'shared.dev',name:'b',transformMatrix:''}]}));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.resetAllMocks();});
it('a wanted request cancelled during queue turnover retries, places shared warm geometry and reaches completion',async()=>{
  vi.useFakeTimers();vi.stubGlobal('crypto',{subtle:{digest:async()=>new Uint8Array(32).buffer}});
  mock.catalog.mockResolvedValue({status:'hit',value:{devPath:'DEV/shared.dev',sourceBounds:[-.5,-.5,-.5,.5,.5,.5],boundsQuality:'conservative',primitiveCounts:{},unsupportedTypes:[]}});
  const result={result:{status:'complete',bytes:new Uint8Array([1]),diagnostics:{status:'complete'}},sha:'00'.repeat(32)};
  mock.read.mockRejectedValueOnce(new DOMException('queue turnover','AbortError'))
    .mockImplementation(async(_store,keys)=>new Map(keys.map((key:string)=>[key,{status:'hit',value:result}])));
  mock.parse.mockImplementation(async()=>{const scene=new THREE.Group();scene.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial()));return {scene,animations:[]};});
  const state=new AppState(),session=state.activateProject(1,'sha');state.currentFiles=new Map();state.projectSourceToViewerMatrix=new THREE.Matrix4();
  const camera=new THREE.PerspectiveCamera(60,1,0.1,1000);camera.position.set(0,0,300);camera.lookAt(0,0,0);
  const ctx:any={world:{scene:{three:new THREE.Scene()},camera:{three:camera,controls:new THREE.EventDispatcher()}}},status=vi.fn();
  const runtime=new DevLodRuntime(state,ctx,session,status);
  try {
    await runtime.start();await vi.advanceTimersByTimeAsync(2000);
    expect(mock.compile).not.toHaveBeenCalled();expect(mock.parse).toHaveBeenCalledOnce();
    expect(state.loadedXmlModGroups.size).toBe(2);expect(runtime.diagnostics.currentViewReady).toBe(true);
    expect(runtime.diagnostics.viewPendingOccurrences).toBe(0);expect(status.mock.lastCall![0]).toContain('当前视图已完成');
    expect(status.mock.lastCall![0]).toContain('冷编译 L0 0/L1 0/L2 0 · 缓存命中 L0 1/L1 0/L2 0');
  }finally{runtime.release();}
  expect(state.loadedXmlModGroups.size).toBe(0);expect(mock.cancel).toHaveBeenCalledOnce();
});

it('a validated empty catalog entry is terminal and never enters compile or template write', async () => {
  vi.useFakeTimers();
  mock.workerCount=2;
  mock.catalog.mockResolvedValue({status:'hit',value:{devPath:'DEV/shared.dev',sourceBounds:null,boundsQuality:'empty',primitiveCounts:{},unsupportedTypes:[]}});
  mock.read.mockImplementation(async(_store,keys)=>new Map(keys.map((key:string)=>[key,{status:'miss' as const}])));
  const state=new AppState(),session=state.activateProject(1,'sha');state.currentFiles=new Map();state.projectSourceToViewerMatrix=new THREE.Matrix4();
  const camera=new THREE.PerspectiveCamera(60,1,0.1,1000);camera.position.set(0,0,300);camera.lookAt(0,0,0);
  const ctx:any={world:{scene:{three:new THREE.Scene()},camera:{three:camera,controls:new THREE.EventDispatcher()}}},status=vi.fn();
  const runtime=new DevLodRuntime(state,ctx,session,status);
  try {
    await runtime.start();await vi.advanceTimersByTimeAsync(2000);
    expect(mock.compile).not.toHaveBeenCalled();
    expect(mock.parse).not.toHaveBeenCalled();
    expect(runtime.diagnostics.emptyOccurrences).toBe(2);
    expect(runtime.diagnostics.baseRepresentationsSettled).toBe(true);
    expect(runtime.diagnostics.allStationReady).toBe(true);
    expect(state.loadedXmlModGroups.size).toBe(0);
    expect(status.mock.lastCall![0]).toContain('缓存命中 L0 0/L1 0/L2 0');
  } finally { runtime.release(); }
});

it('an unavailable worker pool or failed catalog task cannot strand warm geometry or report endless preparation',async()=>{
  vi.useFakeTimers();mock.workerCount=0;mock.catalog.mockResolvedValue({status:'miss'});mock.bounds.mockRejectedValue(Error('pool unavailable'));
  mock.read.mockImplementation(async(_store,keys)=>new Map(keys.map((key:string)=>[key,{status:'miss' as const}])));mock.compile.mockRejectedValue(Error('pool unavailable'));
  const state=new AppState(),session=state.activateProject(1,'sha');state.currentFiles=new Map();state.projectSourceToViewerMatrix=new THREE.Matrix4();
  const ctx:any={world:{scene:{three:new THREE.Scene()},camera:{three:new THREE.PerspectiveCamera(),controls:new THREE.EventDispatcher()}}},status=vi.fn();
  const runtime=new DevLodRuntime(state,ctx,session,status);
  try{
    await runtime.start();await vi.advanceTimersByTimeAsync(2000);
    expect(runtime.diagnostics.catalogReady).toBe(true);expect(runtime.diagnostics.unknownBounds).toBe(2);
    expect(runtime.diagnostics.failedOccurrences).toBe(2);expect(runtime.diagnostics.currentViewSettled).toBe(true);
    expect(runtime.diagnostics.currentViewReady).toBe(false);expect(status.mock.lastCall![0]).toContain('当前视图已完成，部分实例失败');
    expect(status.mock.lastCall![0]).not.toContain('准备中');
  }finally{runtime.release();mock.workerCount=2;}
});
