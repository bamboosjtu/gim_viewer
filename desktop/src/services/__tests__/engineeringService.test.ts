// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../app/state.js';
import { buildSubstationSpatialIndexFromTexts } from '../../gim/ifcSpatialParser.js';
import { beginEngineeringBuild, notifyEngineeringIfcEvidence } from '../engineeringService.js';
import { EngineeringWorkerClient, type EngineeringWorkerPort } from '../engineeringWorkerClient.js';
import { createEngineeringWorkerHandler } from '../engineeringWorker.js';
import type { EngineeringWorkerRequest, EngineeringWorkerResponse } from '../engineeringWorkerProtocol.js';
import { readCachedEntry, writeCacheFile, batchReadCachedFiles } from '@desktop/database.js';

vi.mock('@desktop/runtime.js', () => ({ isTauri: () => true }));
vi.mock('@desktop/database.js', () => ({ readCachedEntry: vi.fn(), writeCacheFile: vi.fn(), batchReadCachedFiles: vi.fn() }));

class LoopbackPort implements EngineeringWorkerPort {
  onmessage: EngineeringWorkerPort['onmessage'] = null;
  onerror: EngineeringWorkerPort['onerror'] = null;
  onmessageerror: EngineeringWorkerPort['onmessageerror'] = null;
  terminated = false;
  commands: string[] = [];
  holdExtract = false;
  resume: (() => void) | null = null;
  holdAssemble = false;
  holdCache = false;
  resumeCache: (()=>void)|null=null;
  resumeAssembly: (() => void) | null = null;
  private handle = createEngineeringWorkerHandler();
  postMessage(request: EngineeringWorkerRequest): void {
    this.commands.push(request.type);
    void (async () => {
      if (this.holdExtract && request.type === 'extract') await new Promise<void>(resolve => { this.resume = resolve; });
      if (this.holdAssemble && request.type === 'assemble') await new Promise<void>(resolve => { this.resumeAssembly = resolve; });
      if (this.holdCache && request.type === 'encode-cache') await new Promise<void>(resolve => { this.resumeCache=resolve; });
      try {
        const reply = await this.handle(request);
        this.onmessage?.({ data: { ...reply, requestId: request.requestId } as EngineeringWorkerResponse } as MessageEvent<EngineeringWorkerResponse>);
      } catch (error) { this.onmessage?.({ data: { type: 'error', requestId: request.requestId, message: String(error) } } as MessageEvent<EngineeringWorkerResponse>); }
    })();
  }
  terminate(): void { this.terminated = true; }
}
const sourceFiles = (name = '主变压器', ifc = false) => new Map([
  ['project.cbm', new File(['OBJECTMODELPOINTER=unit.dev'], 'project.cbm')],
  ['unit.dev', new File([`SYMBOLNAME=${name}\nSUBDEVICE0=terminal.dev`], 'unit.dev')],
  ['terminal.dev', new File(['SYMBOLNAME=测控柜'], 'terminal.dev')],
  ...(ifc ? [['delivery.ifc', new File(['IFC'], 'delivery.ifc')] as [string, File]] : []),
]);
const state = (sha = 'a'.repeat(64)) => { const state = new AppState(); state.activateProject(7, sha); return state; };
const portFactory = (port: LoopbackPort) => (isCurrent: () => boolean, signal: AbortSignal) => new EngineeringWorkerClient(port, isCurrent, signal);
const store = new Map<string, Uint8Array>();
afterEach(() => { vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.clearAllMocks(); store.clear();
  vi.mocked(readCachedEntry).mockImplementation(async (_project, path) => {
    const bytes = store.get(path); if (!bytes) throw Error('cache-missing'); return bytes.slice();
  });
  vi.mocked(writeCacheFile).mockImplementation(async (_project, path, bytes) => { store.set(path, bytes.slice()); return path; });
});

describe('session-owned production engineering build', () => {
  it('builds without a Viewer and restores valid source/entity artifacts without source parsing', async () => {
    const app = state(), first = new LoopbackPort(), files = sourceFiles();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(first) });
    expect(app.engineeringStatus).toBe('ready');
    expect(app.engineeringSnapshot?.entities).toHaveLength(2);
    expect((await app.engineeringGeometryReady)?.occurrences).toHaveLength(1);
    expect(app.engineeringCacheStatus).toBe('saved');
    expect(first.commands).toContain('extract');
    expect(first.terminated).toBe(true);
    const cold = app.engineeringSnapshot;
    const next = new LoopbackPort();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(next) });
    expect(app.engineeringSnapshot).toEqual(cold);
    expect(app.engineeringCacheStatus).toBe('hit');
    expect(next.commands).toEqual(['restore']);
    expect(app.engineeringNavigationCacheHit).toBe(true);
    expect(app.engineeringGeometryCatalog?.occurrences).toHaveLength(1);
  });

  it('rebuilds a corrupt navigation artifact without reextracting or renormalizing valid sources and entities', async () => {
    const app = state(), files = sourceFiles();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(new LoopbackPort()) });
    const cold = app.engineeringSnapshot, view = app.engineeringNavigation;
    const entry = [...store.keys()].find(path => path.includes('engineering-navigation'))!;
    store.set(entry, new Uint8Array([1, 2, 3]));
    const port = new LoopbackPort();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(port) });
    expect(port.commands).toEqual(['restore','encode-cache']);
    expect(app.engineeringSnapshot).toEqual(cold); expect(app.engineeringNavigation).toEqual(view);
    expect(app.engineeringNavigationCacheHit).toBe(false); expect(app.engineeringCacheStatus).toBe('saved');
    const next = new LoopbackPort(); await beginEngineeringBuild(app, files, { createWorker: portFactory(next) });
    expect(app.engineeringNavigationCacheHit).toBe(true);
  });

  it('restores named IFC building/storey contexts and source rows without a Spatial runtime or Viewer', async () => {
    const app = state(), files = sourceFiles('主变压器', true);
    app.substationSpatialIndex = buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'delivery.ifc', name: 'delivery' }, text: [
      "#1=IFCPROJECT('p',$,'工程',$,$,$,$,$,$);", "#2=IFCBUILDING('b',$,'主控楼',$,$,$,$,$,.ELEMENT.,$,$,$);",
      "#3=IFCBUILDINGSTOREY('s',$,'一层',$,$,$,$,$,.ELEMENT.,0.);", "#10=IFCWALL('w',$,'墙',$,$,$,$,$);",
      "#20=IFCRELAGGREGATES('r1',$,$,$,#1,(#2));", "#21=IFCRELAGGREGATES('r2',$,$,$,#2,(#3));", "#22=IFCRELCONTAINEDINSPATIALSTRUCTURE('r3',$,$,$,(#10),#3);",
    ].join('\n') }], null);
    await beginEngineeringBuild(app, files, { createWorker: portFactory(new LoopbackPort()) });
    expect(app.engineeringCacheStatus).toBe('saved'); const cold = app.engineeringNavigation;
    app.substationSpatialIndex = null;
    const port = new LoopbackPort(), start = vi.fn();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(port), ensureIfcSemantics: start });
    expect(port.commands).toEqual(['restore']); expect(start).not.toHaveBeenCalled();
    expect(app.engineeringNavigation).toEqual(cold); expect(app.engineeringNavigationCacheHit).toBe(true);
    expect([...app.engineeringNavigation!.composition.nodes.values()].map(n => n.title)).toContain('主控楼');
    expect([...app.engineeringNavigation!.sourceNodes.values()].map(n => n.title)).toContain('一层');
  });

  it('rebuilds only entities from a valid source artifact when the entity artifact is corrupt', async () => {
    const app = state(), files = sourceFiles();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(new LoopbackPort()) });
    const cold = app.engineeringSnapshot;
    const entityEntry = [...store.keys()].find(p => p.includes('engineering-entity'))!;
    store.set(entityEntry, new Uint8Array([0, 1, 2]));
    const port = new LoopbackPort();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(port) });
    expect(app.engineeringSnapshot).toEqual(cold);
    expect(port.commands).toEqual(['restore','encode-cache']);
    expect(app.engineeringCacheStatus).toBe('saved');
  });

  it('uses bounded native binary batches for lazy semantic files', async () => {
    const originals = sourceFiles(), app = state();
    const lazy = new Map<string, File>();
    for (const [path, file] of originals) lazy.set(path, { size: file.size, arrayBuffer: vi.fn(async () => { throw Error('unexpected single-file RPC'); }) } as unknown as File);
    vi.mocked(batchReadCachedFiles).mockImplementation(async (_project, paths) => new Map(await Promise.all(paths.map(async path => [path, new Uint8Array(await originals.get(path)!.arrayBuffer())] as const))));
    await beginEngineeringBuild(app, lazy, { createWorker: portFactory(new LoopbackPort()) });
    expect(app.engineeringStatus).toBe('ready');
    expect(batchReadCachedFiles).toHaveBeenCalledTimes(1);
    expect(app.engineeringSnapshot?.entities).toHaveLength(2);
  });

  it('reextracts source evidence when the source artifact is corrupt', async () => {
    const app = state(), files = sourceFiles();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(new LoopbackPort()) });
    const sourceEntry = [...store.keys()].find(p => p.includes('engineering-source'))!;
    store.set(sourceEntry, new Uint8Array([0, 1, 2]));
    const port = new LoopbackPort();
    await beginEngineeringBuild(app, files, { createWorker: portFactory(port) });
    expect(port.commands).toContain('extract');
    expect(app.engineeringStatus).toBe('ready');
  });

  it('publishes partial DEV wholes before IFC semantics, then completes without a geometry gate', async () => {
    const app = state(), port = new LoopbackPort();
    await beginEngineeringBuild(app, sourceFiles('主变压器', true), { createWorker: portFactory(port) });
    expect(app.engineeringStatus).toBe('partial');
    expect(store.size).toBe(0);
    expect(port.terminated).toBe(false);
    app.substationSpatialIndex = buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'delivery.ifc', name: 'delivery' },
      text: "ISO-10303-21;HEADER;ENDSEC;DATA;#1=IFCWALL('wall',$,'墙',$,$,$,$,$);ENDSEC;END-ISO-10303-21;" }], null);
    notifyEngineeringIfcEvidence(app);
    await expect.poll(() => app.engineeringCacheStatus).toBe('saved');
    expect(app.engineeringStatus).toBe('ready');
    expect(app.engineeringSnapshot?.entities).toHaveLength(3);
    expect(port.terminated).toBe(true);
    expect(app.deviceLodRuntime).toBeNull();
  });

  it('requests shared IFC semantics after DEV extraction without a renderer readiness signal', async () => {
    const app = state(), starter = vi.fn(async () => false);
    await beginEngineeringBuild(app, sourceFiles('主变压器', true), {
      createWorker: portFactory(new LoopbackPort()), ensureIfcSemantics: starter,
    });
    await expect.poll(() => starter.mock.calls.length).toBe(1);
    await expect.poll(() => app.engineeringError).toContain('IFC 来源语义');
    expect(app.engineeringStatus).toBe('partial');
    expect(app.engineeringSnapshot?.entities).toHaveLength(2);
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
    app.engineeringListeners.add(() => { publications.push(app.engineeringSnapshot?.entities.map(entity => entity.name) ?? []); });
    port.holdAssemble = false; port.resumeAssembly!();
    await expect.poll(() => app.engineeringCacheStatus).toBe('saved');
    expect(app.engineeringStatus).toBe('ready'); expect(app.engineeringError).toBe('');
    expect(app.engineeringSnapshot?.entities.map(entity => entity.name)).toContain('最新墙');
    expect(publications.flat()).not.toContain('先前墙');
    expect(port.commands.filter(command => command === 'assemble')).toHaveLength(3);
    expect(port.terminated).toBe(true);
  });

  it('enriches IFC which becomes available during initial assembly instead of closing the Worker early', async () => {
    const app = state(), port = new LoopbackPort(); port.holdAssemble = true;
    const build = beginEngineeringBuild(app, sourceFiles('主变压器', true), { createWorker: portFactory(port) });
    await expect.poll(() => port.resumeAssembly !== null).toBe(true);
    app.substationSpatialIndex = buildSubstationSpatialIndexFromTexts([{ entry: { modelId: 'm', path: 'delivery.ifc', name: 'delivery' },
      text: "#1=IFCWALL('wall',$,'新墙',$,$,$,$,$);" }], null);
    notifyEngineeringIfcEvidence(app); port.holdAssemble = false; port.resumeAssembly!();
    await build; await expect.poll(() => app.engineeringCacheStatus).toBe('saved');
    expect(app.engineeringStatus).toBe('ready'); expect(app.engineeringError).toBe('');
    expect(app.engineeringSources?.complete).toBe(true);
    expect(app.engineeringSnapshot?.entities.map(entity => entity.name)).toContain('新墙');
    expect(port.commands.filter(command => command === 'assemble')).toHaveLength(2);
    expect(port.terminated).toBe(true);
  });

  it('cancels an old project while extracting and rejects its late result', async () => {
    const app = state(), old = new LoopbackPort(); old.holdExtract = true;
    const pending = beginEngineeringBuild(app, sourceFiles(), { createWorker: portFactory(old) });
    await expect.poll(() => old.resume !== null).toBe(true);
    app.activateProject(8, 'b'.repeat(64));
    const next = new LoopbackPort();
    await beginEngineeringBuild(app, sourceFiles('断路器'), { createWorker: portFactory(next) });
    const newest = app.engineeringSnapshot;
    old.resume!(); await pending;
    expect(old.terminated).toBe(true);
    expect(app.engineeringSnapshot).toBe(newest);
    expect(app.engineeringSnapshot?.scope).toBe('b'.repeat(64));
    expect(app.engineeringStatus).toBe('ready');
  });

  it('keeps a published model usable after a cache write failure', async () => {
    vi.mocked(writeCacheFile).mockRejectedValue(Error('disk-full'));
    const app = state();
    await beginEngineeringBuild(app, sourceFiles(), { createWorker: portFactory(new LoopbackPort()) });
    expect(app.engineeringStatus).toBe('ready');
    expect(app.engineeringSnapshot?.entities).toHaveLength(2);
    expect(app.engineeringCacheStatus).toBe('error');
    expect(app.engineeringCacheError).toContain('disk-full');
  });

  it('cancels a cache request on project switch without saving a late old-domain result',async()=>{
    const app=state(),old=new LoopbackPort();old.holdCache=true;
    const pending=beginEngineeringBuild(app,sourceFiles(),{createWorker:portFactory(old)});
    await expect.poll(()=>old.resumeCache!==null).toBe(true);
    expect(app.engineeringStatus).toBe('ready');expect(store.size).toBe(0);
    app.activateProject(8,'b'.repeat(64));
    await beginEngineeringBuild(app,sourceFiles('断路器'),{createWorker:portFactory(new LoopbackPort())});
    const newest=app.engineeringSnapshot;old.resumeCache!();await pending;
    expect(old.terminated).toBe(true);expect(app.engineeringSnapshot).toBe(newest);
    expect([...store.keys()].every(path=>path.includes('b'.repeat(64)))).toBe(true);
  });

  it('keeps normalization available when cache encoding fails', async () => {
    vi.stubGlobal('CompressionStream', class { constructor() { throw Error('compression-unavailable'); } });
    const app = state();
    await beginEngineeringBuild(app, sourceFiles(), { createWorker: portFactory(new LoopbackPort()) });
    expect(app.engineeringStatus).toBe('ready');
    expect(app.engineeringSnapshot?.entities).toHaveLength(2);
    expect(app.engineeringCacheStatus).toBe('error');
    expect(app.engineeringCacheError).toContain('compression-unavailable');
    expect(store.size).toBe(0);
  });

  it('publishes the in-memory model before source extraction commits, then saves its cache', async () => {
    const app = state(); let commit!: () => void;
    const barrier = new Promise<void>(resolve => { commit = resolve; });
    const port=new LoopbackPort();const build = beginEngineeringBuild(app, sourceFiles(), { createWorker: portFactory(port), beforeCacheWrite: barrier });
    await expect.poll(() => app.engineeringStatus).toBe('ready');
    expect(store.size).toBe(0);
    expect(port.commands).not.toContain('encode-cache');
    commit(); await build;
    expect(store.size).toBe(3);
    expect(app.engineeringCacheStatus).toBe('saved');
  });
});
