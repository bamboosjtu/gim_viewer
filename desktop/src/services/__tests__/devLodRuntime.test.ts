import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DevLodRuntime } from '../devLodRuntime.js';
import { DEV_GEOMETRY_VERSION } from '../devSpatialCatalog.js';
import { perfProductMomentSnapshot, perfReset, perfSnapshot } from '../../utils/perfTimings.js';
import {ByteWorkBudget} from '../../utils/byteWorkBudget.js';
import {DevGlbTemplate} from '../devGlbTemplateRuntime.js';

function fixture() {
  const status = vi.fn();
  const state = { isCurrentSession: () => true, loadedXmlModGroups: new Map(), geometryDiagnostics: new Map(), deviceUnknownBounds: new Set() } as any;
  const runtime = new DevLodRuntime(state, {} as any, { sourceSha256: 'sha', generation: 1 } as any, status);
  Object.assign(runtime.diagnostics, { anchorReady: true, catalogReady: true });
  return { runtime, internal: runtime as any, status };
}
function occurrence(id: number, failed = false) {
  const devPath = `DEV/${id}.dev`, key = `${DEV_GEOMETRY_VERSION}|sha|${devPath.toLowerCase()}|lod0`;
  return { entry: { devPath, templateStatus: failed ? 'failed' : 'ready' }, inView: true,
    desired: 0, browseDesired: 0, displayed: 0, key: failed ? undefined : key,
    failedKey: failed ? key : undefined, group: failed ? undefined : new THREE.Group() };
}

it('commits base geometry during camera motion and bounds refinement deferral', async () => {
  vi.useFakeTimers();
  const clock=vi.spyOn(performance,'now').mockImplementation(()=>Date.now());
  try {
    const {internal}=fixture(),base=vi.fn(),detail=vi.fn();
    internal.cameraMovingUntil=performance.now()+200;
    const refinement=internal.submit(2,detail,'detail',true);
    const initial=internal.submit(3,base,'base',false);
    await vi.advanceTimersByTimeAsync(16);
    expect(base).toHaveBeenCalledOnce();
    expect(detail).not.toHaveBeenCalled();
    for(let i=0;i<12;i++) {
      internal.cameraMovingUntil=performance.now()+200;
      await vi.advanceTimersByTimeAsync(100);
    }
    await Promise.all([initial,refinement]);
    expect(detail).toHaveBeenCalledOnce();
  } finally {clock.mockRestore();vi.clearAllTimers();vi.useRealTimers();}
});

it('keeps warm cache consumption capacity independent of compacted computation workers', async () => {
  const {internal}=fixture();internal.worker={workerCount:1,cacheConcurrency:32};
  const releases:Array<()=>void>=[];
  const requests=Array.from({length:40},(_,i)=>internal.acquireTemplateSlot(`cache-${i}`).then((release:()=>void)=>{releases.push(release);}));
  await Promise.resolve();expect(releases).toHaveLength(32);
  expect(internal.templateWaiters.size).toBe(8);
  for(const release of [...releases])release();
  await Promise.all(requests);for(const release of releases)release();
  expect(internal.templateWaiters.size).toBe(0);expect(internal.templateSlots).toBe(0);
});

it('resolves loaded roots from the live row and never retains a replaced or old-session group',()=>{
  const {runtime,internal}=fixture(),first=new THREE.Group(),second=new THREE.Group();
  internal.rows.set('root',{group:first});
  expect(runtime.getLoadedRoot('root')).toBe(first);
  internal.rows.set('root',{group:second});expect(runtime.getLoadedRoot('root')).toBe(second);
  internal.rows.delete('root');expect(runtime.getLoadedRoot('root')).toBeUndefined();
  internal.rows.set('root',{group:second});internal.state.isCurrentSession=()=>false;
  expect(runtime.getLoadedRoot('root')).toBeUndefined();
});

it('owns optional instance batches across LOD placement, only-selected visibility and project release',async()=>{
  localStorage.setItem('gim-debug-dev-instancing','1');
  const {runtime,internal}=fixture();
  const source=new THREE.Group(),geometry=new THREE.BoxGeometry(1,1,1),material=new THREE.MeshStandardMaterial();
  source.add(new THREE.Mesh(geometry,material));const template=new DevGlbTemplate('DEV/a.dev',source);
  try {
    internal.state.modRootGroup=new THREE.Group();internal.state.currentIfcEntries=[];
    internal.ctx={world:{camera:{controls:{removeEventListener:vi.fn()}}}};
    internal.anchor=new THREE.Matrix4();internal.schedule=vi.fn();internal.requestReady=vi.fn();
    internal.submit=async(_priority:number,run:()=>void)=>run();
    internal.template=async()=>({template,bounds:new THREE.Box3().setFromObject(source),sha:'sha',status:'complete',diagnostics:{}});
    for(let i=0;i<3;i++) {
      const row={...occurrence(i),group:undefined,key:undefined,entry:{...occurrence(i).entry,devPath:'DEV/a.dev',
        rootOccurrence:`root${i}`,instanceKey:`instance${i}`,placementMatrix:new THREE.Matrix4().makeTranslation(i*10000,0,0).toArray()}};
      internal.rows.set(`root${i}`,row);await internal.renderOnce(row,0,0);
    }
    expect(internal.instances.statistics).toMatchObject({groups:3,batches:1,batchedMeshes:3});
    expect(internal.state.loadedXmlModGroups.size).toBe(3);
    internal.selected='root1';runtime.setOnlySelected(true);
    expect(internal.instances.statistics.batchedMeshes).toBe(1);
    expect(runtime.pick(new THREE.Raycaster(new THREE.Vector3(10,0,5),new THREE.Vector3(0,0,-1)))?.instanceKey).toBe('instance1');
    runtime.setOnlySelected(false);expect(internal.instances.statistics.batchedMeshes).toBe(3);
    const adapter=internal.instances;runtime.release();
    expect(adapter.statistics).toMatchObject({groups:0,batches:0,instanceBufferBytes:0});
    expect(internal.state.loadedXmlModGroups.size).toBe(0);
  } finally {runtime.release();template.dispose();localStorage.removeItem('gim-debug-dev-instancing');}
});

it('indexed view candidates preserve visible and selected detail under pressure while unknown sources still request L0', () => {
  const {runtime, internal} = fixture();
  const camera = new THREE.PerspectiveCamera(60, 1, .1, 100); camera.updateMatrixWorld(true);
  internal.ctx = {world: {camera: {three: camera}}};
  internal.anchor = new THREE.Matrix4(); internal.notifyCoordinateAnchor = vi.fn();
  internal.schedule = vi.fn(); internal.requestReady = vi.fn(); internal.render = vi.fn(async () => {});
  const boxes = [new THREE.Box3(new THREE.Vector3(-1,-1,-5),new THREE.Vector3(1,1,-4)),
    new THREE.Box3(new THREE.Vector3(90,90,90),new THREE.Vector3(100,100,100))];
  const rows = [0,1,2,3].map(id => ({...occurrence(id), box: id === 3 ? null : boxes[id === 0 ? 0 : 1],
    entry: {...occurrence(id).entry, rootOccurrence: String(id)}, displayed: 1,
    key: `${DEV_GEOMETRY_VERSION}|sha|dev/${id}.dev|lod1`, group: id === 3 ? undefined : new THREE.Group()}));
  rows.forEach((row, i) => {internal.rows.set(String(i), row); internal.viewIndex.set(String(i), row.box);});
  internal.selected = '2';
  runtime.setExternalMemoryPressure('critical'); internal.update();
  expect(rows.map(row => row.desired)).toEqual([1,0,1,0]);
  expect(internal.render.mock.calls.map((args:any[]) => [args[0].entry.rootOccurrence,args[1]])).toEqual([['1',0],['3',0]]);
  expect(runtime.diagnostics.viewIndex?.candidates).toBe(1);
});

it('stops source prefetch at high pressure, including a reply already in flight', async () => {
  const {internal} = fixture(); internal.session.projectId = 7;
  const files = new Map([['MOD/a.mod', new File(['abc'], 'a.mod')]]);
  const database = await import('@desktop/database.js');
  const read = vi.spyOn(database, 'batchReadCachedFiles').mockImplementation(async () => {
    internal.memoryPressure = 'critical';
    return new Map([['MOD/a.mod', new Uint8Array([1,2,3])]]);
  });
  try {
    internal.memoryPressure = 'high';
    expect(await internal.preloadSources(files)).toBe(files); expect(read).not.toHaveBeenCalled();
    internal.memoryPressure = 'normal';
    const output = await internal.preloadSources(files);
    expect(read).toHaveBeenCalledOnce(); expect(output.get('MOD/a.mod')).toBe(files.get('MOD/a.mod'));
  } finally { read.mockRestore(); }
});

it('batches only reachable sources for a warm template miss and shares repeated preparation', async () => {
  const {internal}=fixture();internal.session.projectId=7;
  const texts=new Map([['DEV/a.dev','SOLIDMODELS.NUM=1\nSOLIDMODEL0=a.phm'],
    ['PHM/a.phm','SOLIDS.NUM=1\nSOLIDS0=a.mod'],['MOD/a.mod','<Device><Entities/></Device>']]);
  internal.sourceFiles=new Map([...texts].map(([path,text])=>[path,{size:new TextEncoder().encode(text).length}]));
  internal.sourceFiles.set('MOD/unrelated.mod',{size:10});
  internal.worker={installSources:vi.fn()};
  const database=await import('@desktop/database.js');
  const read=vi.spyOn(database,'batchReadCachedFiles').mockImplementation(async(_id,paths)=>
    new Map(paths.map(path=>[path,new TextEncoder().encode(texts.get(path)!)])));
  try {
    await internal.prepareMissingTemplateSources('DEV/a.dev');
    await internal.prepareMissingTemplateSources('DEV/a.dev');
    expect(read.mock.calls.map(args=>args[1])).toEqual([['DEV/a.dev'],['PHM/a.phm'],['MOD/a.mod']]);
    expect(internal.worker.installSources).toHaveBeenCalledOnce();
    expect([...internal.worker.installSources.mock.calls[0][0].keys()]).toEqual([...texts.keys()]);
    internal.memoryPressure='high';
    await internal.prepareMissingTemplateSources('DEV/b.dev');
    expect(read).toHaveBeenCalledTimes(3);
  } finally {read.mockRestore();}
});

it('prepares immutable sources only for a confirmed missing derived catalog, retaining authoritative failures and healthy warm reads', async () => {
  const {internal} = fixture(); internal.session.projectId=7;
  const cache=await import('@desktop/devLodCache.js'), database=await import('@desktop/database.js');
  const file={size:3,name:'a.dev',arrayBuffer:vi.fn()} as unknown as File;
  const files=new Map([['DEV/a.dev',file]]);
  const catalog=vi.spyOn(cache,'readDevArtifactBatch');
  const read=vi.spyOn(database,'batchReadCachedFiles').mockResolvedValue(new Map([['DEV/a.dev',new Uint8Array([1,2,3])]]));
  try {
    for (const status of ['hit','read-error','invalid','deferred'] as const) {
      expect(await internal.prepareSources(files,[{status,value:status==='hit'?{}:undefined}])).toBe(files);
    }
    expect(read).not.toHaveBeenCalled();
    const prepared=await internal.prepareSources(files,[{status:'miss'}]);
    expect(prepared.get('DEV/a.dev')).toBeInstanceOf(File);
    expect(new Uint8Array(await prepared.get('DEV/a.dev').arrayBuffer())).toEqual(new Uint8Array([1,2,3]));
    expect(read).toHaveBeenCalledOnce(); expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
    internal.state.isCurrentSession=()=>false;
    expect(await internal.prepareSources(files,[{status:'miss'}])).toBe(files);
    expect(read).toHaveBeenCalledOnce();
  } finally {catalog.mockRestore();read.mockRestore();}
});

it('bounds source prefetch by indexed bytes, keeps oversized and unknown sources lazy and tolerates individual missing replies', async () => {
  const {internal}=fixture(); internal.session.projectId=7;
  const database=await import('@desktop/database.js');
  const sources=new Map(['DEV/a.dev','MOD/a.mod','MOD/b.mod','MOD/large.mod','MOD/unknown.mod'].map((path,i)=>[path,{size:[3,3*1024*1024,3*1024*1024,9*1024*1024,0][i],name:path} as File]));
  const read=vi.spyOn(database,'batchReadCachedFiles').mockImplementation(async(_project,paths)=>new Map(paths.map(path=>[path,path==='MOD/a.mod'?null:new Uint8Array(path==='DEV/a.dev'?3:5)])));
  try {
    const prepared=await internal.preloadSources(sources);
    expect(read.mock.calls.map(call=>call[1])).toEqual([['DEV/a.dev','MOD/a.mod'],['MOD/b.mod']]);
    expect(prepared.get('DEV/a.dev')).toBeInstanceOf(File);expect(prepared.get('MOD/b.mod')).toBeInstanceOf(File);
    for(const path of ['MOD/a.mod','MOD/large.mod','MOD/unknown.mod'])expect(prepared.get(path)).toBe(sources.get(path));
  } finally {read.mockRestore();}
});
it('upgrades partial L0 cache recovery once after enough real RPC demand, never for L1 or a large workset', async () => {
  const {internal}=fixture();internal.diagnostics.uniqueDevSources=100;
  const source={size:3,name:'a.mod'} as File;
  internal.sourceFiles=new Map([['MOD/a.mod',source]]);
  internal.worker={diagnostics:{rpcReads:0},installSources:vi.fn()};
  const prefetch=vi.spyOn(internal,'preloadSources').mockResolvedValue(new Map([['MOD/a.mod',new File(['abc'],'a.mod')]]));
  for(let i=0;i<40;i++)internal.recoverMissingSources(String(i),1);
  expect(prefetch).not.toHaveBeenCalled();
  for(let i=0;i<32;i++)internal.recoverMissingSources(String(i),0);
  expect(prefetch).not.toHaveBeenCalled();
  internal.worker.diagnostics.rpcReads=40;internal.recoverMissingSources('33',0);await Promise.resolve();
  expect(prefetch).toHaveBeenCalledOnce();expect(internal.worker.installSources).toHaveBeenCalledOnce();
  internal.recoverMissingSources('34',0);expect(prefetch).toHaveBeenCalledOnce();
  internal.sourceRecoveryAttempted=false;
  internal.sourceFiles=new Map(Array.from({length:5},(_,i)=>[`MOD/${i}.mod`,{size:8*1024*1024} as File]));
  internal.recoverMissingSources('35',0);expect(prefetch).toHaveBeenCalledOnce();
  internal.sourceRecoveryAttempted=false;internal.sourceFiles=new Map([['MOD/a.mod',source]]);
  let finish!:(files:Map<string,File>)=>void;prefetch.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  internal.recoverMissingSources('36',0);internal.state.isCurrentSession=()=>false;
  finish(new Map([['MOD/a.mod',new File(['abc'],'a.mod')]]));await Promise.resolve();
  expect(internal.worker.installSources).toHaveBeenCalledOnce();
});
it('a stalled optional source batch cannot become a startup gate, and late replies do not install sources', async () => {
  vi.useFakeTimers();const {internal}=fixture();internal.session.projectId=7;
  const database=await import('@desktop/database.js');
  const files=new Map([['DEV/a.dev',{size:3,name:'a.dev'} as File]]);
  let finishRead!:(value:any)=>void;
  const read=vi.spyOn(database,'batchReadCachedFiles').mockImplementation(()=>new Promise(resolve=>{finishRead=resolve;}));
  try {
    const preparing=internal.preloadSources(files);await vi.advanceTimersByTimeAsync(10_000);
    const result=await preparing;expect(result.get('DEV/a.dev')).toBe(files.get('DEV/a.dev'));
    finishRead(new Map([['DEV/a.dev',new Uint8Array([1,2,3])]]));await Promise.resolve();
    expect(result.get('DEV/a.dev')).toBe(files.get('DEV/a.dev'));expect(vi.getTimerCount()).toBe(0);
  } finally {read.mockRestore();vi.useRealTimers();}
});

it('correlates cold/warm GLB decoding, placement and cache writes without changing geometry identity', async () => {
  const {webcrypto}=await import('node:crypto'); vi.stubGlobal('crypto',webcrypto);
  const {serializeDevToGlbDetailed}=await import('../glbCacheService.js');
  const cache=await import('@desktop/devLodCache.js');
  const sources=new Map(Object.entries({
    'DEV/a.dev':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.phm',
    'PHM/body.phm':'SOLIDMODELS.NUM=1\nSOLIDMODEL0=body.mod',
    'MOD/body.mod':'<Device><Entities><Entity ID="1" Visible="TRUE"><Cuboid L="1000" W="1000" H="1000"/></Entity></Entities></Device>',
  }).map(([path,text])=>[path,new File([text],path)]));
  const result=await serializeDevToGlbDetailed('DEV/a.dev',sources,{lod:0});
  let stored:any;
  const write=vi.spyOn(cache,'writeDevArtifactDetailed').mockImplementation(async(_store,_key,value)=>{stored=value;return {ok:true};});
  localStorage.setItem('GIM_PERF_TASK_TRACE','1');
  const boxes:number[][]=[];
  try {
    for (const mode of ['cold','warm']) {
      perfReset(); const {runtime,internal}=fixture();
      internal.ctx={world:{camera:{controls:{removeEventListener:vi.fn()}}}};
      internal.state.modRootGroup=new THREE.Group(); internal.state.currentIfcEntries=[];
      internal.state.deviceUnknownBounds=new Set();
      internal.anchor=new THREE.Matrix4(); internal.state.projectSourceToViewerMatrix=internal.anchor;
      internal.schedule=vi.fn(); internal.requestReady=vi.fn();
      internal.submit=async(_priority:number,run:()=>void)=>run();
      internal.cacheReader.read=async()=>({status:mode==='cold'?'miss':'hit',value:mode==='cold'?undefined:stored,release:()=>{}});
      internal.catalogHint=async()=>({status:'miss'});
      internal.worker={workerCount:1,compile:vi.fn(async()=>result),promote:vi.fn(),acknowledge:vi.fn(),cancel:vi.fn()};
      let releaseWriter: (()=>void)|undefined=mode==='cold'?await internal.writeBudget.acquire(internal.writeBudget.limit):undefined;
      const row={...occurrence(1),entry:{devPath:'DEV/a.dev',rootOccurrence:'root',instanceKey:'root-instance',
        placementMatrix:new THREE.Matrix4().toArray(),templateStatus:'unrequested'},group:undefined,key:undefined};
      const key=internal.key('DEV/a.dev',0); internal.wanted.add(key); internal.rows.set('root',row);
      try {
        await internal.renderOnce(row,0,0);
        if(mode==='cold') {
          expect(internal.state.loadedXmlModGroups.has('root-instance')).toBe(true);
          expect(internal.inputBudget.bytes).toBe(result.bytes!.byteLength);
          expect(write).not.toHaveBeenCalled();
          expect(runtime.diagnostics.cacheWritesReady).toBe(false);
          releaseWriter?.();releaseWriter=undefined;
        }
        await Promise.all([...internal.pendingWrites.values()]);
        const phases=perfSnapshot().spans.filter(span=>span.label.startsWith('DEV task'));
        const taskId=phases.find(span=>span.label==='DEV task · cacheRead')?.meta?.taskId;
        expect(typeof taskId).toBe('string');
        for (const name of ['deserialize','templateBuild','templateWall','sceneCommitQueue','placementCommit']) {
          expect(phases.find(span=>span.label===`DEV task · ${name}`)?.meta?.taskId).toBe(taskId);
        }
        if (mode==='cold') {
          expect(internal.worker.compile.mock.calls[0][4]).toBe(taskId);
          expect(phases.find(span=>span.label==='DEV task · cacheWrite')?.meta?.taskId).toBe(taskId);
        } else {
          expect(internal.worker.compile).not.toHaveBeenCalled();
          expect(phases.find(span=>span.label==='DEV task · deserialize')?.meta?.cacheSource).toBe('disk');
        }
        const group=internal.state.loadedXmlModGroups.get('root-instance');
        expect(group.userData.rootOccurrence).toBe('root');
        const box=new THREE.Box3().setFromObject(group); boxes.push([...box.min.toArray(),...box.max.toArray()]);
      } finally {releaseWriter?.();runtime.release();}
    }
    expect(boxes[1]).toEqual(boxes[0]);
  } finally {write.mockRestore();vi.unstubAllGlobals();localStorage.removeItem('GIM_PERF_TASK_TRACE');perfReset();}
});

function cacheWriterFixture() {
  const value=fixture();
  value.internal.ctx={world:{camera:{controls:{removeEventListener:vi.fn()}}}};
  value.internal.state.deviceUnknownBounds=new Set();value.internal.requestReady=vi.fn();
  return value;
}
it('transfers pending serialized buffers between input and write budgets and records a failed native write', async () => {
  const {runtime,internal}=cacheWriterFixture();internal.inputBudget=new ByteWorkBudget(1024);internal.writeBudget=new ByteWorkBudget(1100);
  const cache=await import('@desktop/devLodCache.js');const finish:Array<(value:{ok:boolean;error?:string})=>void>=[];
  const write=vi.spyOn(cache,'writeDevArtifactDetailed').mockImplementation((_store,_key,value,_context,prepared)=>{
    expect(prepared!.data).toBe((value as any).result.bytes);
    return new Promise(resolve=>finish.push(resolve));
  });
  const releaseA=vi.fn(await internal.inputBudget.acquire(500)),releaseB=vi.fn(await internal.inputBudget.acquire(500));
  const artifact=()=>({result:{status:'complete',bytes:new Uint8Array(500)}});
  try {
    await internal.persistArtifact('templates','a',artifact(),0,'a.dev',undefined,releaseA);
    const b=internal.persistArtifact('templates','b',artifact(),0,'b.dev',undefined,releaseB);
    await vi.waitFor(()=>expect(write).toHaveBeenCalledOnce());
    expect(releaseA).toHaveBeenCalledOnce();expect(releaseB).not.toHaveBeenCalled();
    expect(internal.inputBudget.bytes).toBe(500);expect(runtime.diagnostics.cacheWriteWaitingBytes).toBeGreaterThan(500);
    expect(internal.writeBudget.bytes).toBeLessThanOrEqual(1100);
    finish[0]({ok:true});await b;await vi.waitFor(()=>expect(write).toHaveBeenCalledTimes(2));
    expect(releaseB).toHaveBeenCalledOnce();expect(internal.inputBudget.bytes).toBe(0);
    finish[1]({ok:false,error:'disk failure'});await Promise.all([...internal.pendingWrites.values()]);
    expect(internal.writeBudget.bytes).toBe(0);expect(internal.writeBudget.peakBytes).toBeLessThanOrEqual(1100);
    expect(runtime.diagnostics).toMatchObject({cacheWritesSettled:true,cacheWritesReady:false,artifactWriteFailures:1,cacheWritePendingCount:0});
  } finally {finish.forEach(resolve=>resolve({ok:true}));runtime.release();write.mockRestore();}
});

it('cancels an unadmitted write on release but retains the active buffer reservation until native completion', async () => {
  const {runtime,internal}=cacheWriterFixture();internal.inputBudget=new ByteWorkBudget(1024);internal.writeBudget=new ByteWorkBudget(700);
  const cache=await import('@desktop/devLodCache.js');let complete!:(value:{ok:boolean})=>void;
  const write=vi.spyOn(cache,'writeDevArtifactDetailed').mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  const a=vi.fn(await internal.inputBudget.acquire(500)),b=vi.fn(await internal.inputBudget.acquire(500));
  const artifact={result:{status:'complete',bytes:new Uint8Array(500)}};
  try {
    await internal.persistArtifact('templates','a',artifact,0,'a.dev',undefined,a);
    const pending=internal.persistArtifact('templates','b',artifact,0,'b.dev',undefined,b);
    await vi.waitFor(()=>expect(write).toHaveBeenCalledOnce());runtime.release();await pending;
    await vi.waitFor(()=>expect(runtime.diagnostics.cacheWriteCancelled).toBe(1));
    expect(b).toHaveBeenCalledOnce();expect(a).toHaveBeenCalledOnce();expect(write).toHaveBeenCalledOnce();
    expect(internal.inputBudget.bytes).toBe(0);expect(internal.writeBudget.bytes).toBeGreaterThan(500);
    complete({ok:true});await Promise.all([...internal.pendingWrites.values()]);
    expect(internal.writeBudget.bytes).toBe(0);expect(runtime.diagnostics.cacheWritePendingCount).toBe(0);
  } finally {complete?.({ok:true});runtime.release();write.mockRestore();}
});

it('releases admitted write-slot waiters on project close without starting additional native writes', async () => {
  const {runtime,internal}=cacheWriterFixture();const cache=await import('@desktop/devLodCache.js');
  const completions:Array<(value:{ok:boolean})=>void>=[];
  const write=vi.spyOn(cache,'writeDevArtifactDetailed').mockImplementation(()=>new Promise(resolve=>completions.push(resolve)));
  try {
    await Promise.all(Array.from({length:6},(_,i)=>internal.persistArtifact('catalog',String(i),{bounds:[0,0,0,1,1,1]})));
    expect(write).toHaveBeenCalledTimes(4);expect(internal.writeWaiters).toHaveLength(2);
    runtime.release();await vi.waitFor(()=>expect(runtime.diagnostics.cacheWriteCancelled).toBe(2));
    expect(internal.writeWaiters).toHaveLength(0);expect(write).toHaveBeenCalledTimes(4);
    completions.forEach(resolve=>resolve({ok:true}));await Promise.all([...internal.pendingWrites.values()]);
    expect(internal.writeBudget.bytes).toBe(0);expect(internal.pendingWrites.size).toBe(0);
  } finally {completions.forEach(resolve=>resolve({ok:true}));runtime.release();write.mockRestore();}
});
it('3326 processed includes 34 failures without reporting success or counting an existing coarse group twice', () => {
  perfReset();
  const { runtime, internal, status } = fixture();
  internal.rows = new Map(Array.from({ length: 3326 }, (_, i) => [String(i), occurrence(i, i >= 3292)]));
  internal.ready();
  expect(runtime.diagnostics.currentViewSettled).toBe(true);
  expect(runtime.diagnostics.baseRepresentationsSettled).toBe(true);
  expect(runtime.diagnostics.currentViewReady).toBe(false);
  expect(runtime.diagnostics.baseRepresentationsReady).toBe(false);
  expect(runtime.diagnostics.allStationReady).toBe(false);
  expect(perfProductMomentSnapshot().devCurrentViewSettled?.meta?.failed).toBe(34);
  expect(perfProductMomentSnapshot().devCurrentViewReady).toBeNull();
  expect(status.mock.lastCall![0]).toContain('几何实例已处理 3326/3326 · 已显示 3292');
  expect(status.mock.lastCall![0]).toContain('冷编译 L0 0/L1 0/L2 0 · 缓存命中 L0 0/L1 0/L2 0 · 失败 34');
  expect(status.mock.lastCall![0]).not.toContain('准备中');
  const row = internal.rows.get('3292'); row.group = new THREE.Group();
  internal.ready();
  expect(status.mock.lastCall![0]).toContain('几何实例已处理 3326/3326 · 已显示 3293');
});
it('late failures cannot poison a newer LOD request; explicit refinement retries a transient failure', async () => {
  const { runtime, internal } = fixture();
  const row = occurrence(1, true); row.desired = 2;
  internal.rows.set('root', row);
  internal.failed(row, Error('old LOD0 failure'), row.failedKey);
  expect(row.failedKey).toContain('lod0');
  internal.render = vi.fn(async () => {
    expect(row.failedKey).toBeUndefined();
    row.group = new THREE.Group(); row.entry.templateStatus = 'ready';
    row.key = `${DEV_GEOMETRY_VERSION}|sha|dev/1.dev|lod2`;
    internal.ready();
  });
  internal.anchor = new THREE.Matrix4();
  expect(await runtime.refine('root')).toEqual([row.group]);
  expect(runtime.diagnostics.currentViewReady).toBe(true);
  expect(runtime.diagnostics.failedOccurrences).toBe(0);
});

it('ordinary selection stays at L0/L1 and only explicit refinement requests L2', async () => {
  const { runtime, internal } = fixture();
  const row = occurrence(3);
  row.group = undefined;
  row.key = undefined;
  internal.rows.set('root', row);
  internal.anchor = new THREE.Matrix4();
  const lods: number[] = [];
  internal.render = vi.fn(async (_row: any, lod: number) => {
    lods.push(lod);
    row.group = new THREE.Group();
    row.key = `${DEV_GEOMETRY_VERSION}|sha|dev/3.dev|lod${lod}`;
    row.displayed = lod;
    row.entry.templateStatus = 'ready';
  });
  await runtime.select('root');
  expect(internal.fineRequested.has('root')).toBe(false);
  expect(internal.render).toHaveBeenCalledWith(row, 0, 0);

  internal.render.mockClear();
  await runtime.refine('root');
  expect(internal.fineRequested.has('root')).toBe(true);
  expect(internal.render).toHaveBeenCalledWith(row, 2, 0);
  expect(lods).toEqual([0, 2]);
  runtime.clearSelection();
  expect(internal.fineRequested.has('root')).toBe(false);
});

it('keeps browser readiness settled while an explicit L2 request is pending', () => {
  const { runtime, internal } = fixture();
  const row = occurrence(6);
  row.desired = 2;
  row.browseDesired = 0;
  internal.rows.set('root', row);
  internal.fineRequested.add('root');
  internal.ready();
  expect(runtime.diagnostics.currentViewSettled).toBe(true);
  expect(runtime.diagnostics.baseRepresentationsSettled).toBe(true);
});

it('does not turn a browseable L0/L1 group into a base failure when explicit L2 fails', async () => {
  const { runtime, internal } = fixture();
  const row = occurrence(9);
  row.displayed = 1;
  row.browseDesired = 1;
  row.desired = 1;
  row.key = `${DEV_GEOMETRY_VERSION}|sha|dev/9.dev|lod1`;
  internal.rows.set('root', row);
  internal.anchor = new THREE.Matrix4();
  internal.render = vi.fn(async () => { throw new Error('fine CSG failed'); });
  await expect(runtime.refine('root')).rejects.toThrow('fine CSG failed');
  internal.ready();
  expect(row.group).toBeDefined();
  expect(row.entry.templateStatus).toBe('ready');
  expect(runtime.diagnostics.failedOccurrences).toBe(0);
  expect(runtime.diagnostics.currentViewReady).toBe(true);
  expect(runtime.diagnostics.fineFailures).toHaveLength(1);
});

it('retries one failed DEV browser task without clearing other occurrences', async () => {
  const { runtime, internal } = fixture();
  const failed = occurrence(10, true), other = occurrence(11);
  internal.rows.set('failed', failed); internal.rows.set('other', other);
  internal.anchor = new THREE.Matrix4();
  internal.render = vi.fn(async (row: any, lod: number) => {
    row.group = new THREE.Group(); row.key = `${DEV_GEOMETRY_VERSION}|sha|${row.entry.devPath.toLowerCase()}|lod${lod}`;
    row.displayed = lod; row.entry.templateStatus = 'ready';
  });
  await runtime.retry('failed');
  expect(failed.group).toBeDefined();
  expect(other.group).toBeDefined();
  expect(failed.entry.templateStatus).toBe('ready');
});

it('moving from one selected device to another releases the old fine request', async () => {
  const { runtime, internal } = fixture();
  const a = occurrence(4), b = occurrence(5);
  internal.rows.set('a', a); internal.rows.set('b', b);
  internal.anchor = new THREE.Matrix4();
  internal.render = vi.fn(async (row: any, lod: number) => {
    row.group = new THREE.Group(); row.key = `${DEV_GEOMETRY_VERSION}|sha|${row.entry.devPath.toLowerCase()}|lod${lod}`;
    row.displayed = lod; row.entry.templateStatus = 'ready';
  });
  await runtime.refine('a');
  expect(internal.fineRequested.has('a')).toBe(true);
  await runtime.ensureBase('b');
  expect(internal.fineRequested.has('a')).toBe(false);
  expect(a.desired).toBeLessThanOrEqual(1);
  expect(internal.fineRequested.has('b')).toBe(false);
});

it('focuses scene visibility on the selected DEV and restores the full station', () => {
  const { runtime, internal } = fixture();
  const a = occurrence(7), b = occurrence(8);
  internal.rows.set('a', a); internal.rows.set('b', b); internal.selected = 'a';
  runtime.setOnlySelected(true);
  expect(a.group!.visible).toBe(true);
  expect(b.group!.visible).toBe(false);
  runtime.setOnlySelected(false);
  expect(a.group!.visible).toBe(true);
  expect(b.group!.visible).toBe(true);
});

it('commit queue yields between batches, prioritizes selection and cancels expired work', async () => {
  vi.useFakeTimers();
  try {
    const { internal } = fixture(); const calls: number[] = [];
    internal.cameraMovingUntil = performance.now() + 200;
    const background = internal.submit(2, () => calls.push(2));
    const selected = internal.submit(0, () => calls.push(0));
    await vi.advanceTimersByTimeAsync(16); await selected;
    expect(calls).toEqual([0]);
    internal.cameraMovingUntil = 0;
    await vi.advanceTimersByTimeAsync(16); await background;
    expect(calls).toEqual([0, 2]);
    internal.cameraMovingUntil = performance.now() + 200;
    const expired = internal.submit(2, () => calls.push(9));
    const rejected = expect(expired).rejects.toMatchObject({ name: 'AbortError' });
    internal.state.deviceUnknownBounds = new Map(); internal.ctx.world = { camera: {} };
    internal.release(); await rejected;
    await vi.advanceTimersByTimeAsync(300); expect(calls).toEqual([0, 2]);
  } finally { vi.useRealTimers(); }
});

it('current view readiness does not wait for the whole catalog', () => {
  const { runtime, internal } = fixture();
  internal.rows.set('root', occurrence(1));
  runtime.diagnostics.catalogReady = false;
  internal.ready();
  // 视图本身的 ready 仍不等目录；但状态栏不能在整个目录未就绪时宣称“已完成”。
  expect(runtime.diagnostics.currentViewReady).toBe(true);
  expect(runtime.diagnostics.currentViewSettled).toBe(false);
  expect(runtime.diagnostics.baseRepresentationsSettled).toBe(false);
  expect(internal.status.mock.lastCall![0]).toContain('设备范围索引准备中');
  runtime.diagnostics.catalogReady = true;
  internal.ready();
  expect(runtime.diagnostics.currentViewSettled).toBe(true);
  expect(internal.status.mock.lastCall![0]).toContain('当前视图已完成');
});it('records default DEV current-view and base-representation product moments', () => {
  perfReset(); const { internal } = fixture(); internal.rows.set('root', occurrence(1)); internal.ready();
  const moments = perfProductMomentSnapshot();
  expect(moments.devCurrentViewReady).not.toBeNull();
  expect(moments.devCurrentViewSettled).not.toBeNull();
  expect(moments.devBaseRepresentationsSettled).not.toBeNull();
  expect(moments.devGeometryReady?.meta?.path).toBe('device-lod');
  expect(moments.devAllStationReady).toBeNull();
});

it('camera motion invalidates readiness until the new view has been evaluated', () => {
  vi.useFakeTimers();
  try {
    const { internal, runtime } = fixture(); internal.rows.set('root', occurrence(1));
    internal.ready(); expect(runtime.diagnostics.currentViewReady).toBe(true);
    internal.cameraSchedule(); internal.ready();
    expect(runtime.diagnostics.currentViewReady).toBe(false);
    expect(runtime.diagnostics.currentViewSettled).toBe(false);
    clearTimeout(internal.cameraTimer);
  } finally { vi.useRealTimers(); }
});

it('reports exact finished counts without pre-incrementing an unfinished station', () => {
  const { internal, status }=fixture(); const ready=occurrence(1), waiting=occurrence(2); waiting.group=undefined as any; waiting.key=undefined as any;
  internal.rows=new Map([['one',ready],['two',waiting]]);internal.ready();
  expect(status.mock.lastCall![0]).toContain('几何实例已处理 1/2');
});
