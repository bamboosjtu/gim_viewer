// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectSpatialComposition } from '../compositionSpatial.js';
import { projectEngineeringComposition, finalizeEngineeringComposition } from '@gim/gim-sdk/projection';
import type { ProjectionInput } from '../../../infrastructure/workers/compositionProjectionWorker.js';
import { AppState } from '../../../app/state.js';
import { buildSubstationSpatialIndexFromTexts } from '../../../gim/ifcSpatialParser.js';
import { beginEngineeringBuild, notifyEngineeringIfcEvidence,getEngineeringEvidenceSnapshot,queryEngineeringEvidence,ensureEngineeringEvidence } from '../engineeringService.js';
import { EngineeringWorkerClient, type EngineeringWorkerPort } from '../../../infrastructure/workers/engineeringWorkerClient.js';
import { createEngineeringWorkerHandler } from '../engineeringWorkerHandler.js';
import type { EngineeringWorkerRequest, EngineeringWorkerResponse,EngineeringSourceInput } from '../../../infrastructure/workers/engineeringWorkerProtocol.js';
import {WorkerRequests} from '../../../infrastructure/workers/workerRequests.js';
import { readCachedEntry, writeCacheFile, batchReadCachedFiles } from '../../../infrastructure/native/projectFiles.js';
import {createByteFile} from '@desktop/byteFile.js';
import{createSpatialSemanticStarter}from'../../../features/substation/runtime/spatial/spatialSemanticStarter.js';
import {benchmarkProgress} from '../../../measurement/modelEvidence.js';

vi.mock('@desktop/runtime.js', () => ({ isTauri: () => true }));
vi.mock('../../../infrastructure/native/projectFiles.js', () => ({ readCachedEntry: vi.fn(), writeCacheFile: vi.fn(), batchReadCachedFiles: vi.fn() }));

class LoopbackPort implements EngineeringWorkerPort {
  onmessage: EngineeringWorkerPort['onmessage'] = null;
  onerror: EngineeringWorkerPort['onerror'] = null;
  onmessageerror: EngineeringWorkerPort['onmessageerror'] = null;
  terminated = false;
  commands: string[] = [];
  holdExtract = false;
  resume: (() => void) | null = null;
  holdAssemble = false;
  holdRestore=false;
  resumeRestore:(()=>void)|null=null;
  holdCache = false;
  resumeCache: (()=>void)|null=null;
  resumeAssembly: (() => void) | null = null;
  assemblyComplete?: Promise<void>;
  private sourceSequence=0;
  private activeRequest=0;
  private sourceRequests=new WorkerRequests<EngineeringSourceInput>();
  sourceInputs:EngineeringSourceInput[]=[];
  private handle = createEngineeringWorkerHandler(paths=>{
    const readId=++this.sourceSequence;
    return this.sourceRequests.request(readId,()=>this.onmessage?.({data:{type:'read-sources',requestId:this.activeRequest,readId,paths}} as MessageEvent<EngineeringWorkerResponse>));
  });
  postMessage(request: EngineeringWorkerRequest): void {
    this.commands.push(request.type);
    if(request.type==='source-files'){
      if(request.input)this.sourceInputs.push(request.input);
      this.sourceRequests.settle(request.readId,request.input,request.error?Error(request.error):undefined);return;
    }
    this.activeRequest=request.requestId;
    const work = (async () => {
      if (this.holdExtract && request.type === 'extract') await new Promise<void>(resolve => { this.resume = resolve; });
      if (this.holdAssemble && request.type === 'assemble') await new Promise<void>(resolve => { this.resumeAssembly = resolve; });
      if(this.holdRestore&&request.type==='restore')await new Promise<void>(resolve=>{this.resumeRestore=resolve;});
      if (this.holdCache && request.type === 'encode-cache') await new Promise<void>(resolve => { this.resumeCache=resolve; });
      const reply = await this.handle(request);
      this.onmessage?.({ data: { ...reply, requestId: request.requestId } as EngineeringWorkerResponse } as MessageEvent<EngineeringWorkerResponse>);
    })().catch(error => {
      this.onmessage?.({ data: { type: 'error', requestId: request.requestId, message: String(error) } } as MessageEvent<EngineeringWorkerResponse>);
    });
    if (request.type === 'assemble') this.assemblyComplete = work;
  }
  terminate(): void { this.terminated = true; }
}
const sourceFiles = (name = '主变压器', ifc = false) => new Map([
  ['project.cbm', new File(['OBJECTMODELPOINTER=unit.dev'], 'project.cbm')],
  ['unit.dev', new File([`SYMBOLNAME=${name}\nSUBDEVICE0=terminal.dev`], 'unit.dev')],
  ['terminal.dev', new File(['SYMBOLNAME=测控柜'], 'terminal.dev')],
  ...(ifc ? [['delivery.ifc', new File(['IFC'], 'delivery.ifc')] as [string, File]] : []),
]);
const state = (sha = 'a'.repeat(64)) => { const state = new AppState(); state.activateProject(7, sha); state.ifc.regionalRuntimes.set('m',{index:{objects:[1,10].map(expressId=>({expressId,bounds:[0,0,-10,10,4,0]}))},release:vi.fn()} as never);return state; };
const portFactory = (port: LoopbackPort) => (isCurrent: () => boolean, signal: AbortSignal) => new EngineeringWorkerClient(port, isCurrent, signal);
const store = new Map<string, Uint8Array>();
afterEach(() => { vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.clearAllMocks(); store.clear();
  vi.stubGlobal('Worker',class {
    onmessage:((event:MessageEvent)=>void)|null=null;terminate(){}
    postMessage(input:ProjectionInput){queueMicrotask(()=>{const rows=projectSpatialComposition(input.snapshot,input.facts,input.bounds,undefined,input.declarations);this.onmessage?.({data:{composition:finalizeEngineeringComposition(projectEngineeringComposition(input.snapshot,rows,'工程组成',input.declarations)),contexts:rows.map(r=>[r.entityId,'test'])}} as MessageEvent);});}
  });
  vi.mocked(readCachedEntry).mockImplementation(async (_project, path) => {
    const bytes = store.get(path); if (!bytes) throw Error('cache-missing'); return bytes.slice();
  });
  vi.mocked(writeCacheFile).mockImplementation(async (_project, path, bytes) => { store.set(path, bytes.slice()); return path; });
});

describe('session-owned production engineering build', () => {
  it('releases a build immediately on scope disposal and leaves a replacement build intact', async () => {
    const app = state();
    const scope = app.sessionScope(app.captureProjectSession());
    const old = new LoopbackPort();
    old.holdAssemble = true;
    const terminated = vi.spyOn(old, 'terminate');
    const obsolete = beginEngineeringBuild(app, sourceFiles('旧设备'), { createWorker: portFactory(old) });
    await expect.poll(() => old.resumeAssembly !== null).toBe(true);

    scope.dispose();
    expect(terminated).toHaveBeenCalledOnce();
    expect(old.onmessage).toBeNull();
    expect(app.engineering.cleanup).toBeNull();
    expect(app.engineering.buildPending).toBe(false);
    await obsolete;

    app.activateProject(8, 'b'.repeat(64));
    const replacement = new LoopbackPort();
    await beginEngineeringBuild(app, sourceFiles('新设备'), { createWorker: portFactory(replacement) });
    const published = app.engineering.snapshot;
    expect(published).not.toBeNull();
    old.resumeAssembly?.();
    await old.assemblyComplete;
    expect(app.engineering.snapshot).toBe(published);
    expect(terminated).toHaveBeenCalledOnce();
    expect(replacement.terminated).toBe(false);
    app.invalidatePendingLoads();
  });

  it('settles geometry and the build state when Worker creation throws', async () => {
    const app = state();
    const update = vi.fn();
    await beginEngineeringBuild(app, sourceFiles(), {
      createWorker: () => { throw Error('Worker creation failed'); },
      onUpdate: update,
    });
    await expect(app.sourceGeometry.ready).resolves.toBeNull();
    expect(app.engineering).toMatchObject({ status: 'error', treeStatus: 'error', buildPending: false, cleanup: null });
    expect(update).toHaveBeenCalledOnce();
    app.invalidatePendingLoads();
  });
  it('batches reachable CBM siblings and their DEV pointers on a semantic cache fallback',async()=>{
    const app=state(),port=new LoopbackPort(),rows=Array.from({length:48},(_,i)=>`u${i}`);
    const files=new Map<string,File>([
      ['project.cbm',new File([rows.map((name,i)=>`SUBSYSTEM${i}=${name}.cbm`).join('\n')],'project.cbm')],
      ...rows.flatMap(name=>[[name+'.cbm',new File([`OBJECTMODELPOINTER=${name}.dev`],name+'.cbm')],[name+'.dev',new File(['TYPE=GIS'],name+'.dev')]] as [string,File][]),
      ['unrelated.dev',new File(['TYPE=OTHER'],'unrelated.dev')],
    ]);
    await beginEngineeringBuild(app,files,{createWorker:portFactory(port)});
    const sent=port.sourceInputs.flatMap(input=>input.batches.flatMap(batch=>batch.entries.map(e=>e.path)));
    expect(app.engineering.snapshot?.entities).toHaveLength(48);
    expect(new Set(sent).size).toBe(sent.length);expect(sent).not.toContain('unrelated.dev');
    expect(port.sourceInputs.length).toBeLessThanOrEqual(6);
  });
  it('reads only reachable physical documents once before and after semantic extraction',async()=>{
    const app=state(),port=new LoopbackPort(),files=sourceFiles();port.holdExtract=true;
    for(const name of ['unrelated.cbm','unrelated.dev'])files.set(name,new File(['UNUSED=1'],name));
    const sent=()=>port.sourceInputs.flatMap(input=>input.batches.flatMap(batch=>batch.entries.map(e=>e.path)));
    const build=beginEngineeringBuild(app,files,{createWorker:portFactory(port)});
    try{
      await app.sourceGeometry.ready;
      expect(sent()).not.toContain('unrelated.cbm');expect(sent()).not.toContain('unrelated.dev');
      await expect.poll(()=>port.resume!==null).toBe(true);
    }finally{port.resume?.();}
    await build;
    expect(sent().sort()).toEqual(['project.cbm','terminal.dev','unit.dev']);
  });
  it('keeps physical cache persistence outside automatic geometry settlement',async()=>{
    const app=state(),port=new LoopbackPort();app.currentProjectType='substation';
    app.deviceLodRuntime={diagnostics:{baseRepresentationsSettled:true,cacheWritesSettled:true,pending:0,viewPendingOccurrences:0}} as never;
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
    const write=vi.mocked(writeCacheFile).getMockImplementation()!;
    vi.mocked(writeCacheFile).mockImplementation(async(...args)=>{
      if(args[1].includes('/source-geometry-v1/'))await held;
      return write(...args);
    });
    try{
      await beginEngineeringBuild(app,sourceFiles(),{createWorker:portFactory(port)});
      expect(app.engineering.buildPending).toBe(false);expect(app.sourceGeometry.cachePending).toBe(true);
      expect(benchmarkProgress(app)).toMatchObject({automaticSettled:true,cacheSettled:false});
      expect(port.commands).toContain('encode-geometry-cache');
    }finally{release();}
    await expect.poll(()=>app.sourceGeometry.cachePending).toBe(false);
    expect(benchmarkProgress(app).cacheSettled).toBe(true);
  });
  it('publishes physical geometry while cold semantic extraction is held',async()=>{
    const app=state(),port=new LoopbackPort();port.holdExtract=true;
    const build=beginEngineeringBuild(app,sourceFiles(),{createWorker:portFactory(port)});
    expect((await app.sourceGeometry.ready)?.occurrences).toHaveLength(1);expect(app.engineering.snapshot).toBeNull();
    await expect.poll(()=>port.resume!==null).toBe(true);port.resume!();await build;
    expect(app.engineering.snapshot).not.toBeNull();
  });
  it('restores a physical directory before source-only warm entity/navigation rebuilding',async()=>{
    const app=state(),files=sourceFiles();await beginEngineeringBuild(app,files,{createWorker:portFactory(new LoopbackPort())});
    for(const path of [...store.keys()])if(/engineering-(?:entity|navigation)-/.test(path))store.delete(path);
    const port=new LoopbackPort();port.holdRestore=true;
    const build=beginEngineeringBuild(app,files,{createWorker:portFactory(port)});
    expect((await app.sourceGeometry.ready)?.occurrences).toHaveLength(1);expect(app.engineering.snapshot).toBeNull();expect(port.commands).not.toContain('extract-geometry');
    await expect.poll(()=>port.resumeRestore!==null).toBe(true);port.resumeRestore!();await build;
    expect(app.engineering.snapshot).not.toBeNull();
  });
  it('assembles a live Spatial index before its persistence tail completes',async()=>{
    const app=state(),port=new LoopbackPort();let release!:()=>void;
    const persist=new Promise<void>(r=>{release=r;});const starter=createSpatialSemanticStarter(async ready=>{
      app.substationSpatialIndex=buildSubstationSpatialIndexFromTexts([{entry:{modelId:'m',path:'delivery.ifc',name:'delivery'},text:"#1=IFCWALL('w',$,'墙',$,$,$,$,$);"}],null);
      ready(true);await persist;return true;
    });
    let persisted=false;const tail=starter.complete().then(()=>{persisted=true;});
    await beginEngineeringBuild(app,sourceFiles('设备',true),{createWorker:portFactory(port),ensureIfcSemantics:starter.ready});
    expect(app.engineering.snapshot).not.toBeNull();expect(port.commands.filter(c=>c==='assemble')).toHaveLength(1);expect(persisted).toBe(false);
    release();await tail;
  });
  it('falls back to per-file input when declared sizes underestimate a multi-file batch',async()=>{
    const app=state(),port=new LoopbackPort(),files=sourceFiles();
    const large=new Uint8Array(5*1024*1024);large.fill(32);
    files.set('unit.dev',new File(['SUBDEVICE0=unused-a.dev\nSUBDEVICE1=unused-b.dev'],'unit.dev'));
    for(const name of ['unused-a.dev','unused-b.dev'])files.set(name,{size:0,arrayBuffer:async()=>large.buffer}as File);
    await beginEngineeringBuild(app,files,{createWorker:portFactory(port)});expect(app.engineering.status).toBe('ready');expect(port.sourceInputs.some(input=>input.files.length===2)).toBe(true);
  });
  it('publishes the geometry catalog before joining IFC source semantics and assembles the full model once',async()=>{
    const app=state(),port=new LoopbackPort();let release!:()=>void;
    const gate=new Promise<void>(r=>{release=r;});
    const ensure=vi.fn(async()=>{await gate;app.substationSpatialIndex=buildSubstationSpatialIndexFromTexts([{entry:{modelId:'m',path:'delivery.ifc',name:'delivery'},text:"#1=IFCWALL('w',$,'墙',$,$,$,$,$);"}],null);notifyEngineeringIfcEvidence(app);return true;});
    const pending=beginEngineeringBuild(app,sourceFiles('设备',true),{createWorker:portFactory(port),ensureIfcSemantics:ensure});
    const catalog=await app.sourceGeometry.ready;expect(catalog?.occurrences).toHaveLength(1);
    await expect.poll(()=>ensure.mock.calls.length).toBe(1);expect(port.commands).not.toContain('assemble');
    release();await pending;expect(port.commands.filter(c=>c==='assemble')).toHaveLength(1);
    expect(app.engineering.status).toBe('ready');expect(app.engineering.snapshot?.entities.map(e=>e.name)).toContain('墙');
  });
  it('publishes partial DEV evidence when the joined IFC starter fails',async()=>{
    const app=state(),port=new LoopbackPort();
    await beginEngineeringBuild(app,sourceFiles('设备',true),{createWorker:portFactory(port),ensureIfcSemantics:async()=>{throw Error('source semantics failed');}});
    await expect.poll(()=>app.engineering.failureCode).toBe('ifc-semantic-failed');
    expect(app.engineering.snapshot).not.toBeNull();expect(app.engineering.status).toBe('partial');
    expect(port.commands.filter(c=>c==='assemble')).toHaveLength(1);expect(port.terminated).toBe(true);
  });
  it('exposes inventory while IFC preparation waits and reads unused family attributes only on explicit demand',async()=>{
    const app=state(),port=new LoopbackPort(),files=sourceFiles('设备',true);
    const unused=new File(['[设计]\n额定电压=RATEDVOLTAGE=220 kV'],'unused.fam'),read=vi.spyOn(unused,'arrayBuffer');files.set('unused.fam',unused);app.currentFiles=files;
    let release!:(value:boolean)=>void;const gate=new Promise<boolean>(resolve=>{release=resolve;});
    const build=beginEngineeringBuild(app,files,{createWorker:portFactory(port),ensureIfcSemantics:()=>gate});
    await app.sourceGeometry.ready;
    const inventory=await getEngineeringEvidenceSnapshot(app);
    expect(inventory.entries.find(e=>e.id==='unused.fam')?.status).toBe('not_requested');expect(read).not.toHaveBeenCalled();
    const range={entryIds:['unused.fam'],kinds:['attributes'] as const};
    expect((await queryEngineeringEvidence(app,{range,revision:inventory.revision,limit:10})).attributes).toEqual([]);
    app.substationSpatialIndex=buildSubstationSpatialIndexFromTexts([{entry:{modelId:'m',path:'delivery.ifc',name:'delivery'},text:"#1=IFCWALL('w',$,'墙',$,$,$,$,$);"}],null);
    release(true);await build;
    const loaded=await ensureEngineeringEvidence(app,range);
    expect((await queryEngineeringEvidence(app,{range,revision:loaded.revision,limit:10})).attributes[0].rawValue).toBe('220 kV');
    expect(read).toHaveBeenCalledTimes(1);expect(port.terminated).toBe(false);
    app.engineering.cleanup?.();expect(port.terminated).toBe(true);
  });
  it('rejects an obsolete model after switching projects while IFC source preparation is pending',async()=>{
    const app=state(),old=new LoopbackPort();let release!:()=>void;
    const gate=new Promise<void>(r=>{release=r;});const ensure=vi.fn(()=>gate);
    const pending=beginEngineeringBuild(app,sourceFiles('旧设备',true),{createWorker:portFactory(old),ensureIfcSemantics:ensure});
    await expect.poll(()=>ensure.mock.calls.length).toBe(1);app.activateProject(8,'b'.repeat(64));
    await beginEngineeringBuild(app,sourceFiles('新设备'),{createWorker:portFactory(new LoopbackPort())});const newest=app.engineering.snapshot;
    release();await pending;expect(app.engineering.snapshot).toBe(newest);expect(old.commands).not.toContain('assemble');expect(old.terminated).toBe(true);
  });
  it('materializes cloneable sources only at the Worker boundary without rereading native storage',async()=>{
    const files=sourceFiles(),reference=state();
    await beginEngineeringBuild(reference,files,{createWorker:portFactory(new LoopbackPort())});
    store.clear();vi.mocked(batchReadCachedFiles).mockClear();
    const prepared=new Map(await Promise.all([...files].map(async([path,file])=>[path,createByteFile(new Uint8Array(await file.arrayBuffer()),file.name)]as const)));
    const app=state(),port=new LoopbackPort();
    await beginEngineeringBuild(app,prepared,{createWorker:portFactory(port)});
    expect(port.commands).toContain('extract');expect(port.commands).toContain('source-files');expect(port.commands).not.toContain('files');expect(app.engineering.status).toBe('ready');
    expect(app.engineering.snapshot).toEqual(reference.engineering.snapshot);
    expect(app.sourceGeometry.catalog).toEqual(reference.sourceGeometry.catalog);
    expect(batchReadCachedFiles).not.toHaveBeenCalled();
    expect(await prepared.get('project.cbm')?.text()).toBe(await files.get('project.cbm')?.text());
  });
  it('builds without a Viewer and restores valid source/entity artifacts without source parsing', async () => {
    const app = state(), first = new LoopbackPort(), files = sourceFiles();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(first) });
    expect(app.engineering.status).toBe('ready');
    expect(app.engineering.snapshot?.entities).toHaveLength(2);
    expect((await app.sourceGeometry.ready)?.occurrences).toHaveLength(1);
    expect(app.engineering.cacheStatus).toBe('saved');
    expect(first.commands).toContain('extract');
    expect(first.terminated).toBe(false);
    const cold = app.engineering.snapshot;
    const next = new LoopbackPort();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(next) });
    expect(app.engineering.snapshot).toEqual(cold);
    expect(app.engineering.cacheStatus).toBe('hit');
    expect(next.commands).toEqual(['init','restore','release-model']);
    expect(app.engineering.navigationCacheHit).toBe(true);
    expect(app.sourceGeometry.catalog?.occurrences).toHaveLength(1);
  });

  it('does not report a full hit when only the source cache restored and entity/navigation were rebuilt', async () => {
    const app = state(), files = sourceFiles();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(new LoopbackPort()) });
    const cold = app.engineering.snapshot;
    for (const path of [...store.keys()]) if (/engineering-(?:entity|navigation)-/.test(path)) store.delete(path);
    const port = new LoopbackPort();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(port) });
    expect(app.engineering.snapshot).toEqual(cold);
    expect(app.engineering.navigationCacheHit).toBe(false);
    expect(app.engineering.cacheStatus).toBe('saved');
    expect(port.commands.filter(command => command === 'encode-cache')).toHaveLength(2);
  });

  it('keeps saved source/entity domains and the published view when a copied source tree prevents navigation projection',async()=>{
    const app=state(),files=sourceFiles(),port=new LoopbackPort();let copied=false;
    await beginEngineeringBuild(app,files,{createWorker:portFactory(port),onUpdate:()=>{
      if(!copied&&app.engineering.navigation){copied=true;app.engineering.navigation={...app.engineering.navigation,
        sourceNodes:new Map(app.engineering.navigation.sourceNodes)};}
    }});
    expect(copied).toBe(true);expect(app.engineering.status).toBe('ready');
    expect(app.engineering.snapshot?.entities).toHaveLength(2);expect(app.engineering.navigation?.sourceNodes.size).toBeGreaterThan(0);
    expect(app.engineering.cacheStatus).toBe('partial');expect(app.engineering.cacheError).toBe('navigation-projection-unavailable');
    expect(app.engineering.buildPending).toBe(false);expect(port.terminated).toBe(false);
    expect([...store.keys()].some(path=>path.includes('engineering-source'))).toBe(true);
    expect([...store.keys()].some(path=>path.includes('engineering-entity'))).toBe(true);
    expect([...store.keys()].some(path=>path.includes('engineering-navigation'))).toBe(false);
    const next=new LoopbackPort();await beginEngineeringBuild(app,files,{createWorker:portFactory(next)});
    expect(next.commands).toEqual(['init','restore','encode-cache','release-model']);expect(app.engineering.cacheStatus).toBe('saved');
    expect(app.engineering.cacheError).toBe('');
  });

  it('rebuilds a corrupt navigation artifact without reextracting or renormalizing valid sources and entities', async () => {
    const app = state(), files = sourceFiles();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(new LoopbackPort()) });
    const cold = app.engineering.snapshot, view = app.engineering.navigation;
    const entry = [...store.keys()].find(path => path.includes('engineering-navigation'))!;
    store.set(entry, new Uint8Array([1, 2, 3]));
    const port = new LoopbackPort();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(port) });
    expect(port.commands).toEqual(['init','restore','encode-cache','release-model']);
    expect(app.engineering.snapshot).toEqual(cold); expect(app.engineering.navigation).toEqual(view);
    expect(app.engineering.navigationCacheHit).toBe(false); expect(app.engineering.cacheStatus).toBe('saved');
    const next = new LoopbackPort(); await beginEngineeringBuild(app, files, { createWorker: portFactory(next) });
    expect(app.engineering.navigationCacheHit).toBe(true);
  });

  it('persists the final projected tree and restores it without IFC semantics or geometry runtimes', async () => {
    const app = state(), files = sourceFiles('主变压器', true);
    app.substationSpatialIndex = buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'delivery.ifc', name: 'delivery' }, text: [
      "#1=IFCPROJECT('p',$,'工程',$,$,$,$,$,$);", "#2=IFCBUILDING('b',$,'主控楼',$,$,$,$,$,.ELEMENT.,$,$,$);",
      "#3=IFCBUILDINGSTOREY('s',$,'一层',$,$,$,$,$,.ELEMENT.,0.);", "#10=IFCWALL('w',$,'墙',$,$,$,$,$);",
      "#20=IFCRELAGGREGATES('r1',$,$,$,#1,(#2));", "#21=IFCRELAGGREGATES('r2',$,$,$,#2,(#3));", "#22=IFCRELCONTAINEDINSPATIALSTRUCTURE('r3',$,$,$,(#10),#3);",
    ].join('\n') }], null);
    await beginEngineeringBuild(app, files, { createWorker: portFactory(new LoopbackPort()) });
    expect(app.engineering.cacheStatus).toBe('saved'); const cold = app.engineering.navigation;expect(cold?.compositionComplete).toBe(true);expect(app.engineering.treeStatus).toBe('ready');
    app.substationSpatialIndex = null;app.ifc.regionalRuntimes.clear();
    const port = new LoopbackPort(), start = vi.fn();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(port), ensureIfcSemantics: start });
    expect(port.commands).toEqual(['init','restore','release-model']); expect(start).not.toHaveBeenCalled();
    expect(app.engineering.navigation).toEqual(cold); expect(app.engineering.navigationCacheHit).toBe(true);
    expect([...app.engineering.navigation!.composition.nodes.values()].map(n => n.title)).toContain('主控楼');
    expect([...app.engineering.navigation!.sourceNodes.values()].map(n => n.title)).toContain('一层');
  });

  it('rebuilds only entities from a valid source artifact when the entity artifact is corrupt', async () => {
    const app = state(), files = sourceFiles();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(new LoopbackPort()) });
    const cold = app.engineering.snapshot;
    const entityEntry = [...store.keys()].find(p => p.includes('engineering-entity'))!;
    store.set(entityEntry, new Uint8Array([0, 1, 2]));
    const port = new LoopbackPort();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(port) });
    expect(app.engineering.snapshot).toEqual(cold);
    expect(port.commands).toEqual(['init','restore','encode-cache','release-model']);
    expect(app.engineering.cacheStatus).toBe('saved');
  });

  it('uses bounded native binary batches for lazy semantic files', async () => {
    const originals = sourceFiles(), app = state();
    const lazy = new Map<string, File>();
    for (const [path, file] of originals) lazy.set(path, { size: file.size, arrayBuffer: vi.fn(async () => { throw Error('unexpected single-file RPC'); }) } as unknown as File);
    vi.mocked(batchReadCachedFiles).mockImplementation(async (_project, paths) => new Map(await Promise.all(paths.map(async path => [path, new Uint8Array(await originals.get(path)!.arrayBuffer())] as const))));
    await beginEngineeringBuild(app, lazy, { createWorker: portFactory(new LoopbackPort()) });
    expect(app.engineering.status).toBe('ready');
    expect(vi.mocked(batchReadCachedFiles).mock.calls.flatMap(([,paths])=>paths).sort()).toEqual([...originals.keys()].sort());
    for(const file of lazy.values())expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(app.engineering.snapshot?.entities).toHaveLength(2);
  });

  it('reextracts source evidence when the source artifact is corrupt', async () => {
    const app = state(), files = sourceFiles();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(new LoopbackPort()) });
    const sourceEntry = [...store.keys()].find(p => p.includes('engineering-source'))!;
    store.set(sourceEntry, new Uint8Array([0, 1, 2]));
    const port = new LoopbackPort();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(port) });
    expect(port.commands).toContain('extract');
    expect(app.engineering.status).toBe('ready');
  });

  it('keeps DEV semantics available internally and publishes the tree only after IFC projection completes', async () => {
    const app = state(), port = new LoopbackPort();
    await beginEngineeringBuild(app, sourceFiles('主变压器', true), { createWorker: portFactory(port) });
    expect(app.engineering.status).toBe('partial');expect(app.engineering.treeStatus).toBe('loading');
    expect(app.engineering.buildPending).toBe(true);
    expect([...store.keys()].filter(path=>!path.includes('source-geometry-v1'))).toHaveLength(0);
    expect(port.terminated).toBe(false);
    app.substationSpatialIndex = buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'delivery.ifc', name: 'delivery' },
      text: "ISO-10303-21;HEADER;ENDSEC;DATA;#1=IFCWALL('wall',$,'墙',$,$,$,$,$);ENDSEC;END-ISO-10303-21;" }], null);
    notifyEngineeringIfcEvidence(app);
    await expect.poll(() => app.engineering.cacheStatus).toBe('saved');
    expect(app.engineering.buildPending).toBe(false);
    expect(app.engineering.status).toBe('ready');
    expect(app.engineering.snapshot?.entities).toHaveLength(3);
    expect(port.terminated).toBe(false);
    expect(app.deviceLodRuntime).toBeNull();
  });

  it('requests shared IFC semantics after DEV extraction without a renderer readiness signal', async () => {
    const app = state(), starter = vi.fn(async () => false);
    await beginEngineeringBuild(app, sourceFiles('主变压器', true), {
      createWorker: portFactory(new LoopbackPort()), ensureIfcSemantics: starter,
    });
    await expect.poll(() => starter.mock.calls.length).toBe(1);
    await expect.poll(() => app.engineering.error).toContain('IFC 来源语义');
    expect(app.engineering.status).toBe('partial');
    expect(app.engineering.snapshot?.entities).toHaveLength(2);
  });

  it('serializes overlapping IFC publications and commits only the newest spatial snapshot', async () => {
    const app = state(), port = new LoopbackPort();
    await beginEngineeringBuild(app, sourceFiles('主变压器', true), { createWorker: portFactory(port) });
    const spatial = (name: string) => buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'delivery.ifc', name: 'delivery' },
      text: `#1=IFCWALL('wall',$,'${name}',$,$,$,$,$);` }], null);
    port.holdAssemble = true;
    app.substationSpatialIndex = spatial('先前墙'); notifyEngineeringIfcEvidence(app);
    await expect.poll(() => port.resumeAssembly !== null).toBe(true);
    app.substationSpatialIndex = spatial('最新墙'); notifyEngineeringIfcEvidence(app);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(port.commands.filter(command => command === 'assemble')).toHaveLength(2); // initial partial + one enrichment
    const publications: string[][] = [];
    app.engineering.listeners.add(() => { publications.push(app.engineering.snapshot?.entities.map(entity => entity.name) ?? []); });
    port.holdAssemble = false; port.resumeAssembly!();
    await expect.poll(() => app.engineering.cacheStatus).toBe('saved');
    expect(app.engineering.status).toBe('ready'); expect(app.engineering.error).toBe('');
    expect(app.engineering.snapshot?.entities.map(entity => entity.name)).toContain('最新墙');
    expect(publications.flat()).not.toContain('先前墙');
    expect(port.commands.filter(command => command === 'assemble')).toHaveLength(3);
    expect(port.terminated).toBe(false);
  });

  it('enriches IFC which becomes available during initial assembly instead of closing the Worker early', async () => {
    const app = state(), port = new LoopbackPort(); port.holdAssemble = true;
    const build = beginEngineeringBuild(app, sourceFiles('主变压器', true), { createWorker: portFactory(port) });
    await expect.poll(() => port.resumeAssembly !== null).toBe(true);
    app.substationSpatialIndex = buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'delivery.ifc', name: 'delivery' },
      text: "#1=IFCWALL('wall',$,'新墙',$,$,$,$,$);" }], null);
    notifyEngineeringIfcEvidence(app); port.holdAssemble = false; port.resumeAssembly!();
    await build; await expect.poll(() => app.engineering.cacheStatus).toBe('saved');
    expect(app.engineering.status).toBe('ready'); expect(app.engineering.error).toBe('');
    expect(app.engineering.sources?.complete).toBe(true);
    expect(app.engineering.snapshot?.entities.map(entity => entity.name)).toContain('新墙');
    expect(port.commands.filter(command => command === 'assemble')).toHaveLength(2);
    expect(port.terminated).toBe(false);
  });

  it('cancels an old project while extracting and rejects its late result', async () => {
    const app = state(), old = new LoopbackPort(); old.holdExtract = true;
    const pending = beginEngineeringBuild(app, sourceFiles(), { createWorker: portFactory(old) });
    await expect.poll(() => old.resume !== null).toBe(true);
    app.activateProject(8, 'b'.repeat(64));
    const next = new LoopbackPort();
    await beginEngineeringBuild(app, sourceFiles('断路器'), { createWorker: portFactory(next) });
    const newest = app.engineering.snapshot;
    old.resume!(); await pending;
    expect(old.terminated).toBe(true);
    expect(app.engineering.snapshot).toBe(newest);
    expect(app.engineering.snapshot?.scope).toBe('b'.repeat(64));
    expect(app.engineering.status).toBe('ready');
  });

  it('keeps a published model usable after a cache write failure', async () => {
    const write = vi.mocked(writeCacheFile).getMockImplementation()!;
    vi.mocked(writeCacheFile).mockImplementation(async (...args) => {
      if (args[1].includes('/engineering-navigation-v1/')) throw Error('disk-full');
      return write(...args);
    });
    const app = state();
    await beginEngineeringBuild(app, sourceFiles(), { createWorker: portFactory(new LoopbackPort()) });
    expect(app.engineering.status).toBe('ready');
    expect(app.engineering.snapshot?.entities).toHaveLength(2);
    expect(app.engineering.cacheStatus).toBe('error');
    expect(app.engineering.cacheError).toContain('disk-full');
    expect([...store.keys()].some(path => path.includes('/engineering-source-v1/'))).toBe(true);
    expect([...store.keys()].some(path => path.includes('/engineering-entity-v1/'))).toBe(true);
    expect([...store.keys()].some(path => path.includes('/engineering-navigation-v1/'))).toBe(false);
  });

  it('cancels both deferred cache writes on project switch before source commit', async () => {
    const app = state();
    let commitOld!: () => void;
    const barrier = new Promise<void>((resolve) => { commitOld = resolve; });
    const old = new LoopbackPort();
    const build = beginEngineeringBuild(app, sourceFiles(), {
      createWorker: portFactory(old),
      beforeCacheWrite: barrier,
    });
    await expect.poll(() => app.engineering.cacheStatus).toBe('saving');
    await expect.poll(() => old.commands.includes('encode-geometry-cache')).toBe(true);
    expect(app.engineering.status).toBe('ready');
    expect(writeCacheFile).not.toHaveBeenCalled();

    app.activateProject(8, 'b'.repeat(64));
    expect(app.sourceGeometry.cachePending).toBe(false);
    await build;
    await beginEngineeringBuild(app, sourceFiles('断路器'), { createWorker: portFactory(new LoopbackPort()) });
    commitOld();
    await expect.poll(() => app.sourceGeometry.cachePending).toBe(false);
    expect(app.engineering.cacheStatus).toBe('saved');
    expect(app.engineering.snapshot?.scope).toBe('b'.repeat(64));
    expect(vi.mocked(writeCacheFile).mock.calls.map(([projectId]) => projectId)).toEqual([8, 8, 8, 8]);
  });

  it('cancels a cache request on project switch without saving a late old-domain result',async()=>{
    const app=state(),old=new LoopbackPort();old.holdCache=true;
    const pending=beginEngineeringBuild(app,sourceFiles(),{createWorker:portFactory(old)});
    await expect.poll(()=>old.resumeCache!==null).toBe(true);
    expect(app.engineering.status).toBe('ready');expect([...store.keys()].filter(path=>!path.includes('source-geometry-v1'))).toHaveLength(0);
    app.activateProject(8,'b'.repeat(64));
    await beginEngineeringBuild(app,sourceFiles('断路器'),{createWorker:portFactory(new LoopbackPort())});
    const newest=app.engineering.snapshot;old.resumeCache!();await pending;
    expect(old.terminated).toBe(true);expect(app.engineering.snapshot).toBe(newest);
    expect([...store.keys()].filter(path=>!path.includes('source-geometry-v1')).every(path=>path.includes('b'.repeat(64)))).toBe(true);
  });

  it('records a physical geometry cache encoding gap instead of returning silently', async () => {
    const app = state();
    app.currentProjectType = 'substation';
    app.deviceLodRuntime = { diagnostics: { baseRepresentationsSettled: true, cacheWritesSettled: true, pending: 0, viewPendingOccurrences: 0 } } as never;
    vi.spyOn(EngineeringWorkerClient.prototype, 'encodeGeometryCache').mockResolvedValueOnce(undefined);
    await beginEngineeringBuild(app, sourceFiles(), { createWorker: portFactory(new LoopbackPort()) });
    await expect.poll(() => app.sourceGeometry.cachePending).toBe(false);
    expect(app.sourceGeometry.cacheError).toContain('编码未返回内容');
  });

  it('keeps normalization available when cache encoding fails', async () => {
    vi.stubGlobal('CompressionStream', class { constructor() { throw Error('compression-unavailable'); } });
    const app = state();
    await beginEngineeringBuild(app, sourceFiles(), { createWorker: portFactory(new LoopbackPort()) });
    expect(app.engineering.status).toBe('ready');
    expect(app.engineering.snapshot?.entities).toHaveLength(2);
    expect(app.engineering.cacheStatus).toBe('error');
    expect(app.engineering.cacheError).toContain('compression-unavailable');
    expect([...store.keys()].filter(path=>!path.includes('source-geometry-v1'))).toHaveLength(0);
  });

  it('publishes the in-memory model before source extraction commits, then saves its cache', async () => {
    const app = state(); let commit!: () => void;
    const barrier = new Promise<void>(resolve => { commit = resolve; });
    const port=new LoopbackPort();const build = beginEngineeringBuild(app, sourceFiles(), { createWorker: portFactory(port), beforeCacheWrite: barrier });
    await expect.poll(() => app.engineering.status).toBe('ready');
    expect([...store.keys()].filter(path=>!path.includes('source-geometry-v1'))).toHaveLength(0);
    expect(port.commands).not.toContain('encode-cache');
    commit(); await build;
    expect(store.size).toBe(4);
    expect(app.engineering.cacheStatus).toBe('saved');
  });
});
it('keeps all three engineering views browseable when a declared IFC is skipped by geometry loading',async()=>{
 const app=state(),files=sourceFiles('主变压器',true);files.set('skipped.ifc',new File(['IFC'],'skipped.ifc'));
 app.engineering.ifcGeometryFinished=true;
 app.substationSpatialIndex=buildSubstationSpatialIndexFromTexts([
  {entry:{modelId:'m',path:'delivery.ifc',name:'delivery'},text:"#1=IFCWALL('wall',$,'墙',$,$,$,$,$);"},
  {entry:{modelId:'n',path:'skipped.ifc',name:'skipped'},text:"#2=IFCWALL('wall2',$,'墙2',$,$,$,$,$);"},
 ],null);
 await beginEngineeringBuild(app,files,{createWorker:portFactory(new LoopbackPort())});
 expect(app.engineering.treeStatus).toBe('ready');
 expect(app.engineering.navigation?.compositionCoverage).toBe('partial');
 expect(app.engineering.navigation?.composition.nodes.size).toBeGreaterThan(0);
 expect(app.engineering.navigation?.inventory?.nodes.size).toBeGreaterThan(0);
 expect(app.engineering.navigation?.sourceNodes.size).toBeGreaterThan(0);
 expect(app.engineering.cacheStatus).toBe('partial');
});

it('rebuilds old semantic-version artifacts through the warm worker and reuses source and physical geometry',async()=>{
  const app=state(),files=sourceFiles(),first=new LoopbackPort();
  await beginEngineeringBuild(app,files,{createWorker:portFactory(first)});
  const cold=app.engineering.snapshot,geometry=await app.sourceGeometry.ready;
  const stale=(bytes:Uint8Array):Uint8Array=>{
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=4+view.getUint32(0,true);
    const header=JSON.parse(new TextDecoder().decode(bytes.subarray(4,end))) as {contract:string};
    expect(header.contract).toMatch(/[|]decision-revision:[0-9]+[|]/);
    header.contract=header.contract.replace(/[|]decision-revision:[0-9]+[|]/,'|');
    const encoded=new TextEncoder().encode(JSON.stringify(header)),body=bytes.subarray(end);
    const result=new Uint8Array(4+encoded.length+body.length);
    new DataView(result.buffer).setUint32(0,encoded.length,true);
    result.set(encoded,4);result.set(body,4+encoded.length);
    return result;
  };
  const source=[...store.entries()].find(([path])=>path.includes('engineering-source-'))!;
  const physical=[...store.entries()].find(([path])=>path.includes('source-geometry-'))!;
  expect(physical).toBeDefined();expect(source).toBeDefined();
  const old=[...store.entries()].filter(([path])=>/engineering-(?:entity|navigation)-/.test(path));
  expect(old).toHaveLength(2);
  for(const [path,bytes] of old)store.set(path,stale(bytes));
  const warm=new LoopbackPort();
  await beginEngineeringBuild(app,files,{createWorker:portFactory(warm)});
  expect(warm.commands).toEqual(['init','restore','encode-cache','encode-cache','release-model']);
  expect(warm.sourceInputs).toHaveLength(0);
  expect(app.engineering.cacheStatus).toBe('saved');expect(app.engineering.navigationCacheHit).toBe(false);
  expect(app.engineering.snapshot).toEqual(cold);
  expect(await app.sourceGeometry.ready).toEqual(geometry);
  expect(store.get(source[0])).toBe(source[1]);expect(store.get(physical[0])).toBe(physical[1]);
  await beginEngineeringBuild(app,files,{createWorker:portFactory(new LoopbackPort())});
  expect(app.engineering.navigationCacheHit).toBe(true);
});
