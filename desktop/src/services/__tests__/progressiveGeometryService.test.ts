import { InvalidDevGeometryError } from '../glbCacheService.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { runProgressiveDevGlbPipeline } from '../progressiveGeometryService.js';
import { AppState } from '../../app/state.js';
import type { ProgressiveGeometryDependencies } from '../progressiveGeometryService.js';
import type { GeometryCacheManifestEntry } from '@desktop/database.js';
import type { CbmNode } from '../../gim/types.js';
import { isTauri } from '@desktop/runtime.js';
import { SubstationBackgroundCoordinator } from '../substationBackgroundRuntime.js';

// jsdom 下 isTauri() 恒为 false；通过 mock 控制 Tauri/浏览器两种模式
vi.mock('@desktop/runtime.js', () => ({
  isTauri: vi.fn(() => false),
}));

/**
 * 构造最小 CBM 树：
 * root
 *  ├─ devA 实例 1（devPath=a.dev, 平移 z=+1000）
 *  ├─ devA 实例 2（同 devPath，平移 z=+2000）—— 验证同 DEV 只序列化一次
 *  └─ devB（devPath=b.dev）—— 验证序列化返回 null 时跳过
 */
function makeSeed(path: string, devPath: string, z: number): CbmNode {
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
    transformMatrix: `1,0,0,0,0,1,0,0,0,0,1,0,0,0,${z},1`,
    systemNames: [],
    devSymbolName: '',
    devType: '',
    devExpanded: false,
  };
}

function makeTree(): CbmNode {
  const a1 = makeSeed('CBM/a1.cbm', 'a.dev', 1000);
  const a2 = makeSeed('CBM/a2.cbm', 'a.dev', 2000);
  const b = makeSeed('CBM/b.cbm', 'b.dev', 3000);
  return {
    path: 'CBM/project.cbm',
    name: 'root',
    entityName: 'F1System',
    children: [a1, a2, b],
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

function makeGroup(): THREE.Group {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
  return group;
}

interface DepsRecorder {
  serializeCalls: string[];
  writeCalls: string[];
  versionWrites: number;
  loadCalls: string[];
  manifestEntries?: GeometryCacheManifestEntry[][];
}

function makeDeps(opts: { serializeNullFor?: string[] } = {}, rec?: DepsRecorder): ProgressiveGeometryDependencies {
  const recorder = rec ?? { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
  return {
    serializeDevToGlb: vi.fn(async (devPath: string) => {
      recorder.serializeCalls.push(devPath);
      if (opts.serializeNullFor?.some((p) => devPath.includes(p))) return null;
      return new Uint8Array([1, 2, 3]);
    }),
    loadDevGlb: vi.fn(async (devPath: string) => {
      recorder.loadCalls.push(devPath);
      return makeGroup();
    }),
    writeGlbFile: vi.fn(async (_projectId: number, entryPath: string) => {
      recorder.writeCalls.push(entryPath);
    }),
    writeGeometryCacheVersion: vi.fn(async () => {
      recorder.versionWrites++;
    }),
    writeGeometryCacheManifest: vi.fn(async (_projectId: number, _sourceSha256: string, entries: GeometryCacheManifestEntry[]) => {
      recorder.manifestEntries?.push(entries);
    }),
    applyPlacementTransformToSceneUnits: vi.fn(() => {}),
    yieldToMain: vi.fn(async () => {}),
  };
}

function makeState(opts: { projectId?: number } = {}): AppState {
  const state = new AppState();
  state.currentFiles = new Map();
  state.currentCbmTree = makeTree();
  state.currentProjectId = opts.projectId ?? null;
  state.currentSourceSha256 = 'sha-test';
  state.geometryLoadToken = 1; // 与测试传入的 token 对齐（真实流程由调用方 ++ 后传入）
  return state;
}

describe('runProgressiveDevGlbPipeline', () => {
  it('mixed deterministic states plus a transient write failure do not publish; a new open retries', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const allPaths=['normal','empty','unsupported','invalid','transient'];
    for (const failWrite of [true,false]) {
      const state=makeState({projectId:7});
      state.currentCbmTree!.children=allPaths.map((p,i)=>makeSeed(`CBM/${p}.cbm`,`${p}.dev`,i*1000));
      const rec:DepsRecorder={serializeCalls:[],writeCalls:[],versionWrites:0,loadCalls:[],manifestEntries:[]};
      const deps=makeDeps({},rec);
      deps.serializeDevToGlbDetailed=async path=>{
        rec.serializeCalls.push(path);
        if(path.endsWith('invalid.dev'))throw new InvalidDevGeometryError(path,'source extent','source-origin-span-v1 fixture');
        const status=path.endsWith('empty.dev')?'empty':path.endsWith('unsupported.dev')?'unsupported':'complete';
        return {status,bytes:status==='complete'?new Uint8Array([1,2,3]):null,diagnostics:{status,discoveredModCount:1,discoveredStlCount:0,renderableModCount:status==='complete'?1:0,renderableStlCount:0,emptySourceCount:status==='empty'?1:0,unsupportedSourceCount:status==='unsupported'?1:0,partialSourceCount:0,unsupportedPrimitiveTypeCounts:{}}};
      };
      deps.writeGlbFile=async (_pid,path)=>{rec.writeCalls.push(path);if(failWrite&&path.includes('transient.dev'))throw new Error('transient disk write failed');};
      const result=await runProgressiveDevGlbPipeline(state,new THREE.Scene(),()=>{},{token:1},deps);
      expect(rec.serializeCalls).toHaveLength(5); // no complete marker means current contract retries the batch
      expect(result.sourceInvalidDevs).toEqual(['DEV/invalid.dev']);
      expect(result.failedDevs).toEqual(failWrite?['DEV/transient.dev']:[]);
      expect(rec.versionWrites).toBe(failWrite?0:1);
      expect(rec.manifestEntries).toHaveLength(failWrite?0:1);
      if(!failWrite){
        expect(rec.manifestEntries![0].map(e=>e.status)).toEqual(['glb','empty','unsupported','source-invalid','glb']);
        expect(rec.manifestEntries![0].filter(e=>e.status==='source-invalid').map(e=>e.entry_path)).toEqual(['DEV/invalid.dev']);
      }
    }
  });

  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(false);
  });

  afterEach(() => {
    vi.mocked(isTauri).mockReturnValue(false);
  });

  it('stale source rejection cannot poison a new project diagnostic or publish a version',async()=>{
    vi.mocked(isTauri).mockReturnValue(true);
    const state=makeState({projectId:7});
    const rec:DepsRecorder={serializeCalls:[],writeCalls:[],versionWrites:0,loadCalls:[],manifestEntries:[]};
    const deps=makeDeps({},rec);deps.serializeDevToGlb=async path=>{state.currentProjectId=8;throw new InvalidDevGeometryError(path,'source invalid','source-origin-span-v1 fixture');};
    const result=await runProgressiveDevGlbPipeline(state,new THREE.Scene(),()=>{},{token:1},deps);
    expect(result.interrupted).toBe(true);expect(state.geometryDiagnosticsByDevPath.size).toBe(0);expect(rec.versionWrites).toBe(0);
  });

  it('typed source rejection publishes a tombstone; generic failure still prevents publication', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    for (const deterministic of [true,false]) {
      const state=makeState({projectId:7});
      const rec:DepsRecorder={serializeCalls:[],writeCalls:[],versionWrites:0,loadCalls:[],manifestEntries:[]};
      const deps=makeDeps({},rec);
      deps.serializeDevToGlb=async path=>{rec.serializeCalls.push(path);if(path.endsWith('b.dev'))throw deterministic?new InvalidDevGeometryError(path,'extent-exceeds-500m; MOD/b.mod','source-origin-span-v1 fixture'):new Error('disk read failed');return new Uint8Array([1,2,3]);};
      const result=await runProgressiveDevGlbPipeline(state,new THREE.Scene(),()=>{},{token:1},deps);
      expect(rec.serializeCalls).toHaveLength(2);
      expect(result.renderedInstances).toBe(2);
      expect(rec.versionWrites).toBe(deterministic?1:0);
      if(deterministic){expect(result.sourceInvalidDevs).toEqual(['DEV/b.dev']);expect(result.failedDevs).toEqual([]);expect(rec.manifestEntries?.[0][1]).toMatchObject({status:'source-invalid',size:0,diagnostic:expect.stringContaining('MOD/b.mod')});}
      else expect(result.failedDevs).toEqual(['DEV/b.dev']);
    }
  });

  it.each([false,true])('production DEV loop: cooperative checkpoints=%s',async(cooperate)=>{
    vi.mocked(isTauri).mockReturnValue(true);
    const hold=()=>{let resolve!:(value?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {resolve,promise};};
    const aStarted=hold(),aFinish=hold(),bStarted=hold(),bFinish=hold(),fineStarted=hold(),fineFinish=hold(),done=hold();
    const state=makeState({projectId:7}),scene=new THREE.Scene(),order:string[]=[],events:any[]=[],units:any[]=[];
    const rec:DepsRecorder={serializeCalls:[],writeCalls:[],versionWrites:0,loadCalls:[],manifestEntries:[]};
    const deps=makeDeps({},rec);
    deps.serializeDevToGlb=async path=>{order.push(path+' start');if(path.endsWith('a.dev')){aStarted.resolve();await aFinish.promise;}else{bStarted.resolve();await bFinish.promise;}return new Uint8Array([1,2,3]);};
    const coordinator=new SubstationBackgroundCoordinator({session:{id:90},isCurrent:()=>state.currentProjectId===7,onFineEvent:event=>events.push(event),onCheckpoint:unit=>units.push(unit)});
    coordinator.enqueue({task:'devGeometry',priority:1,heavy:true,startAfter:'allIfcPreviewsReady',run:async()=>{
      const result=await runProgressiveDevGlbPipeline(state,scene,()=>{}, {token:1,onDevCheckpoint:cooperate?async unit=>{
        if(unit.path.endsWith('a.dev')){expect(rec.writeCalls).toEqual(['DEV/a.dev']);expect(state.loadedXmlModGroups.size).toBe(2);expect(rec.versionWrites).toBe(0);}
        await coordinator.servicePendingUserFineAtCheckpoint(unit);
      }:undefined},deps);done.resolve(result);
    }});
    coordinator.markInteractive();coordinator.markAllIfcPreviewsReady();await aStarted.promise;
    const fine=coordinator.enqueueUserIfcFine('small-ifc',async()=>{order.push('fine start');fineStarted.resolve();await fineFinish.promise;order.push('fine end');});
    aFinish.resolve();
    if(cooperate){await fineStarted.promise;expect(order).toEqual(['DEV/a.dev start','fine start']);expect(rec.versionWrites).toBe(0);fineFinish.resolve();await fine.promise;await bStarted.promise;}
    else {await bStarted.promise;expect(order).toEqual(['DEV/a.dev start','DEV/b.dev start']);expect(events.map(x=>x.state)).toEqual(['queued']);}
    bFinish.resolve();const result=await done.promise;
    if(!cooperate){await fineStarted.promise;fineFinish.resolve();await fine.promise;}
    expect(result.renderedInstances).toBe(3);expect(result.interrupted).toBe(false);expect(rec.versionWrites).toBe(1);
    expect(rec.manifestEntries?.[0].map(x=>x.entry_path)).toEqual(['DEV/a.dev','DEV/b.dev']);
    expect(state.loadedXmlModGroups.size).toBe(3);
    expect(events.map(x=>x.state)).toEqual(['queued','running','completed']);
    expect(events[1].queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(events[2].durationMs).toBeGreaterThanOrEqual(0);
    if(cooperate)expect(units.map(x=>x.serviced)).toEqual([true,false]);
    console.info(JSON.stringify({cooperate,order,events,units}));
  });

  it('同 DEV 多实例只序列化一次，逐实例渲染并注册 instanceKey', async () => {
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    const progress = vi.fn();
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), progress, { token: 1 }, makeDeps({}, rec));

    // a.dev 被 a1/a2 两个实例共享 → 只序列化一次
    expect(rec.serializeCalls).toEqual(['DEV/a.dev', 'DEV/b.dev']);
    // 渲染：a1 + a2 + b = 3 实例；GLB template 按 unique DEV parse 一次
    expect(result.renderedInstances).toBe(3);
    expect(result.compiledDevs).toBe(2);
    expect(result.interrupted).toBe(false);
    expect(rec.loadCalls).toHaveLength(2);
    expect(result.devGlbProfile?.templateParseCount).toBe(2);
    expect(result.devGlbProfile?.sharedPlacementCount).toBe(3);
    // instanceKey 注册（键格式 dev:{devPath}#{seed.path}）
    expect(state.loadedXmlModGroups.has('dev:DEV/a.dev#CBM/a1.cbm')).toBe(true);
    expect(state.loadedXmlModGroups.has('dev:DEV/a.dev#CBM/a2.cbm')).toBe(true);
    // 进度回调：compiling 若干次 + done 一次
    const phases = progress.mock.calls.map((c) => c[0].phase);
    expect(phases[phases.length - 1]).toBe('done');
    const last = progress.mock.calls[progress.mock.calls.length - 1][0];
    expect(last.compiledDevs).toBe(2);
    expect(last.renderedInstances).toBe(3);
  });

  it('序列化返回 null（无几何）的 DEV 跳过渲染但计入编译数', async () => {
    const state = makeState({ projectId: 7 });
    const result = await runProgressiveDevGlbPipeline(
      state,
      new THREE.Scene(),
      vi.fn(),
      { token: 1 },
      makeDeps({ serializeNullFor: ['b.dev'] }),
    );
    expect(result.compiledDevs).toBe(2);
    expect(result.renderedInstances).toBe(2); // 仅 a1/a2
    expect(state.loadedXmlModGroups.has('DEV/b.dev#CBM/b.cbm')).toBe(false);
  });

  it('无 projectId（浏览器模式）跳过落盘与版本文件，仍渐进渲染', async () => {
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState(); // projectId = null
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, makeDeps({}, rec));

    expect(result.renderedInstances).toBe(3);
    expect(rec.writeCalls).toEqual([]); // 不落盘
    expect(rec.versionWrites).toBe(0); // 不写版本文件
  });

  it('token 不匹配时立即中断且不写版本文件', async () => {
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    state.geometryLoadToken = 5; // 与传入 token=1 不匹配
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, makeDeps({}, rec));

    expect(result.interrupted).toBe(true);
    expect(result.compiledDevs).toBe(0);
    expect(rec.versionWrites).toBe(0);
  });

  it('管线中途切换项目（token 失效）停止且不写版本标记', async () => {
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    // 自定义 yieldToMain：第一次 yield 后递增 token 模拟项目切换
    const deps = makeDeps({}, rec);
    let yields = 0;
    deps.yieldToMain = vi.fn(async () => {
      yields++;
      if (yields === 1) state.geometryLoadToken++;
    });
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, deps);

    expect(result.interrupted).toBe(true);
    expect(result.compiledDevs).toBe(1); // 第一个 DEV 编译完成后被中断
    expect(rec.versionWrites).toBe(0); // 中断不写版本 → 下次打开自动重编译
  });

  it('序列化抛错的 DEV 跳过且不阻断后续 DEV，但阻止版本标记提交（P1 评审）', async () => {
    vi.mocked(isTauri).mockReturnValue(true); // Tauri 模式验证版本文件写入
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    const deps = makeDeps({}, rec);
    deps.serializeDevToGlb = vi.fn(async (devPath: string) => {
      if (devPath.includes('a.dev')) throw new Error('export failed');
      rec.serializeCalls.push(devPath);
      return new Uint8Array([1]);
    });
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, deps);

    expect(result.compiledDevs).toBe(2);
    expect(result.renderedInstances).toBe(1); // 仅 b
    // P1 评审：存在无确定性结果的 DEV → 不写版本标记，
    // 避免「完成」掩盖缺失 GLB 导致二次打开静默丢几何
    expect(rec.versionWrites).toBe(0);
    expect(result.failedDevs).toEqual(['DEV/a.dev']);
    expect(result.rawFallbackDevs).toEqual(['DEV/a.dev']);
    expect(result.devGlbProfile?.failureType).toEqual({ 'DEV/a.dev': 'parse-exception' });
  });

  it('strict geometry dependency 缺失时保留 missing 诊断并只进入该 DEV 回退', async () => {
    const state = makeState({ projectId: 7 });
    const deps = makeDeps();
    deps.serializeDevToGlb = vi.fn(async (devPath: string) => {
      if (devPath.includes('a.dev')) {
        const error = new Error('DEV DEV/a.dev 内 MOD 加载失败');
        (error as Error & { cause?: unknown }).cause = new Error('MOD 文件不存在: MOD/missing.mod');
        throw error;
      }
      return new Uint8Array([1, 2, 3]);
    });

    const result = await runProgressiveDevGlbPipeline(
      state,
      new THREE.Scene(),
      vi.fn(),
      { token: 1 },
      deps,
    );

    expect(result.rawFallbackDevs).toEqual(['DEV/a.dev']);
    expect(result.devGlbProfile?.failureType).toEqual({ 'DEV/a.dev': 'missing' });
    expect(result.devGlbProfile?.fullProjectRawFallbackCount).toBe(0);
  });

  it('同一 DEV 的 GLB 解码失败只尝试一次并返回定向 raw fallback', async () => {
    const state = makeState({ projectId: 7 });
    const loadCalls: string[] = [];
    const deps = makeDeps({}, undefined);
    deps.loadDevGlb = vi.fn(async (devPath: string) => {
      loadCalls.push(devPath);
      return devPath === 'DEV/a.dev' ? null : makeGroup();
    });

    const result = await runProgressiveDevGlbPipeline(
      state,
      new THREE.Scene(),
      vi.fn(),
      { token: 1 },
      deps,
    );

    // a.dev has two placements, but a failed DEV is one failure domain.
    expect(loadCalls).toEqual(['DEV/a.dev', 'DEV/b.dev']);
    expect(result.renderedInstances).toBe(1); // b.dev remains intact
    expect(result.failedDevs).toEqual(['DEV/a.dev',]);
    expect(result.rawFallbackDevs).toEqual(['DEV/a.dev']);
    expect(state.loadedXmlModGroups.size).toBe(1);
  });

  it('warm geometry rebuild 可通过 files 覆盖使用磁盘源，不写入 state.currentFiles', async () => {
    const state = makeState({ projectId: 7 });
    const originalFiles = state.currentFiles;
    const rebuildFiles = new Map<string, File>([['DEV/a.dev', new File(['x'], 'DEV/a.dev')]]);
    const seenFiles: Map<string, File>[] = [];
    const deps = makeDeps();
    deps.serializeDevToGlb = vi.fn(async (_devPath: string, files: Map<string, File>) => {
      seenFiles.push(files);
      return new Uint8Array([1, 2, 3]);
    });

    const result = await runProgressiveDevGlbPipeline(
      state,
      new THREE.Scene(),
      vi.fn(),
      { token: 1, files: rebuildFiles },
      deps,
    );

    expect(result.interrupted).toBe(false);
    expect(seenFiles.length).toBe(2);
    expect(seenFiles.every((files) => files === rebuildFiles)).toBe(true);
    expect(state.currentFiles).toBe(originalFiles);
  });

  it('落盘失败的 DEV 阻止版本标记提交但渲染照常（P1 评审）', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    const deps = makeDeps({}, rec);
    deps.writeGlbFile = vi.fn(async (_projectId: number, entryPath: string) => {
      if (entryPath.includes('a.dev')) throw new Error('disk full');
    });
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, deps);

    expect(result.renderedInstances).toBe(3); // 渲染不受影响
    expect(rec.versionWrites).toBe(0); // 缓存完整性受损 → 不提交完成标记
    expect(result.failedDevs).toEqual(['DEV/a.dev']);
  });

  it('全部 DEV 均为空几何（tombstone）时仍提交版本标记（P1 评审）', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [], manifestEntries: [] };
    const state = makeState({ projectId: 7 });
    const result = await runProgressiveDevGlbPipeline(
      state,
      new THREE.Scene(),
      vi.fn(),
      { token: 1 },
      makeDeps({ serializeNullFor: ['a.dev', 'b.dev'] }, rec),
    );

    // tombstone 是确定性结果：无几何也是有效缓存状态
    expect(rec.versionWrites).toBe(1);
    expect(result.failedDevs).toEqual([]);
    expect(rec.manifestEntries).toHaveLength(1);
    expect(rec.manifestEntries?.[0]).toEqual([
      { entry_path: 'DEV/a.dev', status: 'empty', size: 0 },
      { entry_path: 'DEV/b.dev', status: 'empty', size: 0 },
    ]);
  });

  it('管线开始时捕获 projectId 快照（P1 竞态：中途变更 state 不影响落盘目标）', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [] };
    const state = makeState({ projectId: 7 });
    const writtenProjectIds: number[] = [];
    const deps = makeDeps({}, rec);
    deps.writeGlbFile = vi.fn(async (projectId: number) => {
      writtenProjectIds.push(projectId);
      // 模拟异步间隙中用户切到新项目（state.currentProjectId 被改写）
      state.currentProjectId = 99;
    });
    await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, deps);

    // 所有落盘都使用管线启动时捕获的旧 projectId=7，而非被污染的 99
    expect(writtenProjectIds.every((id) => id === 7)).toBe(true);
  });

  it('Tauri 模式下逐 DEV 落盘并写版本标记', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [], manifestEntries: [] };
    const state = makeState({ projectId: 9 });
    await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, makeDeps({}, rec));

    // a.dev 序列化一次、落盘一次（多实例共享）
    expect(rec.writeCalls).toEqual(['DEV/a.dev', 'DEV/b.dev']);
    expect(rec.versionWrites).toBe(1);
    expect(rec.manifestEntries?.[0]).toEqual([
      { entry_path: 'DEV/a.dev', status: 'glb', size: 3 },
      { entry_path: 'DEV/b.dev', status: 'glb', size: 3 },
    ]);
  });

  it('DEV 路径大小写变体只生成一个 manifest 条目并共享序列化结果', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const rec: DepsRecorder = { serializeCalls: [], writeCalls: [], versionWrites: 0, loadCalls: [], manifestEntries: [] };
    const state = makeState({ projectId: 11 });
    const tree = makeTree();
    tree.children[0].devPath = 'dev/A.DEV';
    tree.children[1].devPath = 'DEV/a.dev';
    state.currentCbmTree = tree;
    const result = await runProgressiveDevGlbPipeline(state, new THREE.Scene(), vi.fn(), { token: 1 }, makeDeps({}, rec));

    expect(result.failedDevs).toEqual([]);
    expect(rec.serializeCalls).toEqual(['dev/A.DEV', 'DEV/b.dev']);
    expect(rec.manifestEntries?.[0].filter((entry) => entry.entry_path.toLowerCase() === 'dev/a.dev')).toHaveLength(1);
    expect(rec.versionWrites).toBe(1);
  });
});
