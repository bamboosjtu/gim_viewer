import { afterEach, expect, it, vi } from 'vitest';
import { DevGeometryPreprocessor } from '../devGeometryWorkerClient.js';
import { beginIfcGeometryWork, beginDevGeometryWork, ifcGeometryBusy, resetGeometryWorkGateForTests } from '../../viewer/geometryWorkGate.js';
import {perfReset,perfTaskPhaseSnapshot} from '../../utils/perfTimings.js';

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  sent: any[] = [];
  terminate = vi.fn();
  constructor() { ControlledWorker.instances.push(this); }
  postMessage(data: any) { this.sent.push(data); }
  complete(error?: string, byteLength = 1, stages: Record<string, unknown> = {}) {
    const task = [...this.sent].reverse().find(data => data.kind === 'compile' || data.kind === 'bounds');
    this.onmessage?.({ data: { ...task, kind: 'result', error, result: { status: 'ready', bytes: {byteLength}, diagnostics: {} }, wallMs: 1, stages } });
  }
}
afterEach(() => { vi.unstubAllGlobals(); ControlledWorker.instances = []; resetGeometryWorkGateForTests(); });
it('upgrades immutable sources in active workers and replacement initialization without restarting healthy tasks or accepting stale work', async () => {
  vi.stubGlobal('Worker',ControlledWorker);vi.stubGlobal('navigator',{hardwareConcurrency:4,deviceMemory:8});
  let current=true;
  const files=new Map([['MOD/a.mod',{size:3,arrayBuffer:vi.fn()} as unknown as File]]);
  const client=new DevGeometryPreprocessor([],files,()=>current);
  try {
    const active=client.compile('DEV/a.dev',0,'a',1);
    const source=new File(['abc'],'a.mod'),prepared=new Map([['MOD/a.mod',source]]);
    const [first,second]=ControlledWorker.instances;
    client.installSources(prepared);
    expect(first.sent[first.sent.length-1]).toMatchObject({kind:'sources',files:[['MOD/a.mod',3,source]]});
    expect(first.terminate).not.toHaveBeenCalled();expect(client.schedulingSnapshot().active).toBe(1);
    second.onerror!({message:'idle crash'});
    expect(ControlledWorker.instances[2].sent[0].files).toEqual([['MOD/a.mod',3,source]]);
    first.complete();await active;client.acknowledge('a');
    const calls=first.sent.length;client.installSources(prepared);expect(first.sent).toHaveLength(calls);
    current=false;client.installSources(new Map([['MOD/a.mod',new File(['new'],'a.mod')]]));
    expect(first.sent).toHaveLength(calls);
  } finally {client.cancel();}
});
it('a crash plus a full shared gate drains queued work without retrying the failed source', async () => {
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', {hardwareConcurrency: 4, deviceMemory: 8});
  const external = beginDevGeometryWork()!;
  const client = new DevGeometryPreprocessor([], new Map(), () => true);
  try {
    const failed = client.compile('failed', 0, 'failed', 1);
    const rejection = expect(failed).rejects.toThrow('crash');
    const next = client.compile('next', 0, 'next', 1);
    const [broken, idle] = ControlledWorker.instances;
    expect(idle.sent.filter(row => row.kind === 'compile')).toHaveLength(0);
    broken.onerror!({message:'crash'});
    await rejection;
    expect(idle.sent[idle.sent.length-1]).toMatchObject({kind:'compile', path:'next'});
    expect(ControlledWorker.instances.flatMap(worker => worker.sent).filter(row => row.path === 'failed')).toHaveLength(1);
    idle.complete(); await next; client.acknowledge('next');
    expect(client.schedulingSnapshot()).toMatchObject({active:0, queued:0, results:{bytes:0,count:0}});
    expect(client.diagnostics.failedTasks).toBe(1);
  } finally { client.cancel(); external(); }
});

it('bounds drain under output pressure and a full gate, then consumption resumes compiles without retrying failed work', async () => {
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', {hardwareConcurrency:4, deviceMemory:8});
  const client = new DevGeometryPreprocessor([], new Map(), () => true);
  let external: (()=>void) | undefined;
  try {
    const a = client.compile('a',0,'a',1), b = client.compile('b',0,'b',1);
    const [first, second] = ControlledWorker.instances;
    first.complete(undefined,64*1024*1024); await a;
    external = beginDevGeometryWork()!;
    const next = client.compile('next',0,'next',1);
    const bounds = client.bounds('bounds');
    expect(first.sent[first.sent.length-1]).toMatchObject({kind:'bounds',path:'bounds'});
    first.complete(); await bounds;
    second.complete('source failed',0); await expect(b).rejects.toThrow('source failed');
    expect(client.schedulingSnapshot()).toMatchObject({active:0,queued:1});
    client.acknowledge('a');
    expect(first.sent[first.sent.length-1]).toMatchObject({kind:'compile',path:'next'});
    first.complete(); await next; client.acknowledge('next');
    expect(client.schedulingSnapshot()).toMatchObject({active:0,queued:0,results:{bytes:0,count:0}});
  } finally {client.cancel(); external?.();}
});
it('links worker phases to the caller task without treating a measured read as a failed phase', async () => {
  perfReset({generation:7});
  vi.stubGlobal('Worker',ControlledWorker);vi.stubGlobal('navigator',{hardwareConcurrency:4,deviceMemory:8});
  const client=new DevGeometryPreprocessor([],new Map(),()=>true);
  try {
    const task=client.compile('DEV/a.dev',1,'a',0,'template-request-17');
    const failure=expect(task).rejects.toThrow('geometry failed');
    ControlledWorker.instances[0].complete('geometry failed',0,{readRpcMs:500,primitiveMs:600});
    await failure;
    const phases=perfTaskPhaseSnapshot();
    expect(phases.totals['dev:compile:workerWall'].failed).toBe(1);
    expect(phases.totals['dev:compile:worker.readRpcMs'].failed).toBe(0);
    expect(phases.slowSamples.find(row=>row.phase==='worker.readRpcMs')).toMatchObject({
      taskId:'template-request-17',sourcePath:'DEV/a.dev',lod:1,priority:0,generation:7,workerTaskId:1,
    });
  } finally {client.cancel();}
});
it('selection preempts queued work while old background base requests cannot starve behind fresh visible detail', async () => {
  vi.stubGlobal('Worker', ControlledWorker); vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8 });
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const client = new DevGeometryPreprocessor([], new Map(), () => true);
  try {
    const a = client.compile('DEV/a.dev', 0, 'a', 1), b = client.compile('DEV/b.dev', 0, 'b', 1);
    const background = client.compile('DEV/bg.dev', 0, 'bg', 4);
    now = 60000;
    const detail = client.compile('DEV/detail.dev', 2, 'detail', 2);
    const selected = client.compile('DEV/selected.dev', 2, 'selected', 0);
    const [first, second] = ControlledWorker.instances;
    first.complete(); await a; client.acknowledge('a');
    expect(first.sent[first.sent.length - 1]).toMatchObject({ key: 'selected' });
    first.complete(); await selected; client.acknowledge('selected');
    expect(first.sent[first.sent.length - 1]).toMatchObject({ key: 'bg' });
    first.complete(); await background; client.acknowledge('bg');
    expect(first.sent[first.sent.length - 1]).toMatchObject({ key: 'detail' });
    first.complete(); second.complete(); await Promise.all([detail, b]);
    client.acknowledge('detail'); client.acknowledge('b');
  } finally { client.cancel(); clock.mockRestore(); }
});
it('compiles alongside IFC, deduplicates templates, prioritizes queued selection and releases computation slots before downstream parsing', async () => {
  vi.stubGlobal('Worker', ControlledWorker); vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8 });
  // 固定为 2 个 Worker，保持用例针对双 Worker 调度的既有断言。
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'gim-dev-workers' ? '2' : null, setItem() {}, removeItem() {} });
  const releaseIfc = await beginIfcGeometryWork();
  const source = new File(['<Device/>'], 'a.mod');
  const client = new DevGeometryPreprocessor([], new Map([['MOD/a.mod', source]]), () => true);
  try {
    const a = client.compile('DEV/a.dev', 0, 'a', 3), b = client.compile('DEV/b.dev', 0, 'b', 3);
    expect(client.compile('DEV/b.dev', 0, 'b', 3)).toBe(b);
    const selected = client.compile('DEV/c.dev', 2, 'c', 0);
    const [first, second] = ControlledWorker.instances;
    expect(first.sent[0].files).toEqual([['MOD/a.mod', source.size, source]]);
    expect(ifcGeometryBusy()).toBe(true); expect(client.workerCount).toBe(2);
    expect(first.sent.filter(data => data.kind === 'compile')).toHaveLength(1);
    first.complete(); await a;
    expect(first.sent.filter(data => data.kind === 'compile')).toHaveLength(2);
    client.acknowledge('a');
    expect(first.sent[first.sent.length - 1]).toMatchObject({ kind: 'compile', key: 'c', lod: 2 });
    first.complete(); second.complete(); await Promise.all([selected, b]);
    client.acknowledge('c'); client.acknowledge('b');
    expect(client.activePaths).toEqual([]);
  } finally { client.cancel(); releaseIfc(); }
});
it('a low-memory device caps worker pool and a stale session terminates every worker without another request', async () => {
  vi.stubGlobal('Worker', ControlledWorker); vi.stubGlobal('navigator', { hardwareConcurrency: 16, deviceMemory: 2 });
  let current = true;
  const client = new DevGeometryPreprocessor([], new Map(), () => current);
  const task = client.compile('DEV/a.dev', 0, 'a', 3), rejected = expect(task).rejects.toThrow('cancelled');
  expect(client.workerCount).toBe(2); current = false;
  ControlledWorker.instances[0].complete(); await rejected;
  expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledOnce();
});

it('exported bytes apply backpressure until consumed, while completed templates remain deduplicated', async () => {
  vi.stubGlobal('Worker',ControlledWorker);vi.stubGlobal('navigator',{hardwareConcurrency:8,deviceMemory:8});
  const client=new DevGeometryPreprocessor([],new Map(),()=>true);
  try {
    const a=client.compile('a',0,'a',1), b=client.compile('b',0,'b',1), c=client.compile('c',0,'c',1);
    const [first,second]=ControlledWorker.instances;
    first.complete(undefined,64*1024*1024);await a;
    expect(client.compile('a',0,'a',0)).toBe(a);
    expect(first.sent.filter(row=>row.kind==='compile')).toHaveLength(1);
    expect(client.resultPressure.bytes).toBe(64*1024*1024);
    client.acknowledge('a');expect(first.sent[first.sent.length-1].key).toBe('c');
    first.complete();second.complete();await Promise.all([b,c]);
    client.acknowledge('b');client.acknowledge('c');expect(client.resultPressure.bytes).toBe(0);
  } finally {client.cancel();}
});

it('a crashed worker fails its task, preserves the healthy worker and bounds pool replacement attempts',async()=>{
  vi.stubGlobal('Worker',ControlledWorker);vi.stubGlobal('navigator',{hardwareConcurrency:8,deviceMemory:8});
  vi.stubGlobal('localStorage',{getItem:(key:string)=>key==='gim-dev-workers'?'2':null,setItem(){},removeItem(){}});
  const client=new DevGeometryPreprocessor([],new Map(),()=>true);
  try {
    const a=client.compile('a',0,'a',1),b=client.compile('b',0,'b',1),c=client.compile('c',0,'c',1);
    const rejected=expect(a).rejects.toThrow('crash');const [broken,healthy]=ControlledWorker.instances;
    broken.onerror!({message:'crash'});await rejected;
    expect(healthy.terminate).not.toHaveBeenCalled();expect(client.workerCount).toBe(2);
    const replacement=ControlledWorker.instances[2];replacement.complete();healthy.complete();await Promise.all([b,c]);
    client.acknowledge('b');client.acknowledge('c');
    // Only one replacement is permitted; repeated idle crashes exhaust the pool.
    replacement.onerror!({message:'crash again'});
    healthy.onerror!({message:'pool unavailable'});expect(client.workerCount).toBe(0);
    await expect(client.compile('d',0,'d',1)).rejects.toThrow('pool unavailable');
    expect(ControlledWorker.instances).toHaveLength(3);
  }finally{client.cancel();}
});

it('wakes queued compilation when another owner releases the shared gate', async () => {
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 4, deviceMemory: 8 });
  const first = beginDevGeometryWork()!, second = beginDevGeometryWork()!;
  const client = new DevGeometryPreprocessor([], new Map(), () => true);
  try {
    const task = client.compile('a', 0, 'a', 1);
    expect(client.schedulingSnapshot().queued).toBe(1);
    first(); await Promise.resolve();
    expect(client.schedulingSnapshot().active).toBe(1);
    ControlledWorker.instances[0].complete(); await task; client.acknowledge('a');
  } finally { first(); second(); client.cancel(); }
});

it('aggregates execution phases separately from queue time and rejects invalid timing samples', async () => {
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 4, deviceMemory: 8 });
  const client = new DevGeometryPreprocessor([], new Map(), () => true);
  try {
    const a = client.compile('a', 0, 'a', 1);
    ControlledWorker.instances[0].complete(undefined, 1, { exportWallMs: 3, decodeMs: 2, reads: 1, badMs: -1, invalidMs: NaN });
    await a; client.acknowledge('a');
    const b = client.compile('b', 0, 'b', 1);
    ControlledWorker.instances[0].complete(undefined, 1, { exportWallMs: 5 });
    await b; client.acknowledge('b');
    expect(client.diagnostics.stages.exportWallMs).toEqual({ count: 2, totalMs: 8, maxMs: 5 });
    expect(client.diagnostics.stages.reads).toBeUndefined();
    expect(client.diagnostics.stages.badMs).toBeUndefined();
    expect(client.diagnostics.stages.invalidMs).toBeUndefined();
  } finally { client.cancel(); }
});

it('keeps successive LODs of one source on a reusable worker when it is idle', async () => {
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 4, deviceMemory: 8 });
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'gim-dev-workers' ? '2' : null, setItem() {}, removeItem() {} });
  const client = new DevGeometryPreprocessor([], new Map(), () => true);
  try {
    const base = client.compile('DEV/shared.dev', 0, 'base', 1);
    const fine = client.compile('DEV/shared.dev', 2, 'fine', 2);
    const [first] = ControlledWorker.instances;
    first.complete(); await base; client.acknowledge('base');
    expect(first.sent[first.sent.length - 1]).toMatchObject({ key: 'fine', path: 'DEV/shared.dev', lod: 2 });
    first.complete(); await fine; client.acknowledge('fine');
    expect(client.diagnostics.sourceAffinityHits).toBe(1);
  } finally { client.cancel(); }
});

it('pausing background refinement still dispatches L0 and bounds work', async () => {
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 4, deviceMemory: 8 });
  const client = new DevGeometryPreprocessor([], new Map(), () => true);
  try {
    client.setPaused(true);
    const fine = client.compile('fine', 1, 'fine', 2);
    const base = client.compile('base', 0, 'base', 1);
    expect(ControlledWorker.instances[0].sent.filter(row => row.kind === 'compile')).toHaveLength(1);
    expect(ControlledWorker.instances[0].sent[ControlledWorker.instances[0].sent.length - 1]).toMatchObject({ key: 'base', lod: 0 });
    ControlledWorker.instances[0].complete(); await base; client.acknowledge('base');
    expect(ControlledWorker.instances[0].sent.filter(row => row.key === 'fine')).toHaveLength(0);
    client.setPaused(false);
    expect(ControlledWorker.instances[0].sent[ControlledWorker.instances[0].sent.length - 1]).toMatchObject({ key: 'fine', lod: 1 });
    ControlledWorker.instances[0].complete(); await fine; client.acknowledge('fine');
  } finally { client.cancel(); }
});

it('does not pause an explicit user L2 request', async () => {
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 4, deviceMemory: 8 });
  const client = new DevGeometryPreprocessor([], new Map(), () => true);
  try {
    client.setPaused(true);
    const fine = client.compile('fine', 2, 'fine', 0);
    const last = ControlledWorker.instances[0].sent[ControlledWorker.instances[0].sent.length - 1];
    expect(last).toMatchObject({ key: 'fine', lod: 2 });
    ControlledWorker.instances[0].complete();
    await fine;
    client.acknowledge('fine');
  } finally { client.cancel(); }
});

it('reports a stalled task and terminates its worker after the fixed deadline without retrying the source', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 4, deviceMemory: 8 });
  const client = new DevGeometryPreprocessor([], new Map(), () => true);
  try {
    const task = client.compile('slow', 0, 'slow', 1);
    const rejected = expect(task).rejects.toThrow('timed out');
    const healthy = client.compile('healthy', 0, 'healthy', 1);
    ControlledWorker.instances[1].complete(); await healthy; client.acknowledge('healthy');
    await vi.advanceTimersByTimeAsync(120_000); await rejected;
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(ControlledWorker.instances[1].terminate).not.toHaveBeenCalled();
    expect(client.diagnostics.timedOutTasks).toBe(1);
    expect(client.diagnostics.stallSnapshots).toBeGreaterThan(0);
    expect(client.schedulingSnapshot().queued).toBe(0);
    expect(client.schedulingSnapshot().active).toBe(0);
    expect(ControlledWorker.instances.flatMap(worker => worker.sent).filter(row => row.path === 'slow')).toHaveLength(1);
  } finally { client.cancel(); vi.useRealTimers(); }
});

it('uses up to eight workers on a many-core machine and honors the debug override',()=>{
  vi.stubGlobal('Worker',ControlledWorker);vi.stubGlobal('navigator',{hardwareConcurrency:16,deviceMemory:8});
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem(){},removeItem(){}});
  const auto=new DevGeometryPreprocessor([],new Map(),()=>true);
  expect(auto.workerCount).toBe(8);auto.cancel();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>key==='gim-dev-workers'?'3':null,setItem(){},removeItem(){}});
  const overridden=new DevGeometryPreprocessor([],new Map(),()=>true);
  expect(overridden.workerCount).toBe(3);overridden.cancel();
});

it('cancels an exclusive active fine task without interrupting a healthy base task', async () => {
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 4, deviceMemory: 8 });
  const client = new DevGeometryPreprocessor([], new Map(), () => true);
  try {
    const fine = client.compile('fine', 2, 'fine', 0);
    const rejected = expect(fine).rejects.toMatchObject({ name: 'AbortError' });
    const base = client.compile('base', 0, 'base', 1);
    const [old, healthy] = ControlledWorker.instances;
    client.cancelTask('fine');
    await rejected;
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(healthy.terminate).not.toHaveBeenCalled();
    old.complete(); // late result cannot settle a replacement request
    healthy.complete(); await base;
    expect(client.diagnostics.failedTasks).toBe(0);
    expect(client.schedulingSnapshot().active).toBe(0);
  } finally { client.cancel(); }
});

it('critical pressure reclaims idle workers, preserves active base work and restores capacity only on new demand', async () => {
  vi.stubGlobal('Worker',ControlledWorker);vi.stubGlobal('navigator',{hardwareConcurrency:8,deviceMemory:8});
  vi.stubGlobal('localStorage',{getItem:()=> '4'});
  const client=new DevGeometryPreprocessor([],new Map(),()=>true);
  try {
    const base=client.compile('base',0,'base',1);const first=ControlledWorker.instances[0];
    client.setMemoryPressure('critical');
    expect(client.workerCount).toBe(1);expect(first.terminate).not.toHaveBeenCalled();
    expect(client.diagnostics.idleWorkerReclaims).toBe(3);
    first.complete();await base;client.acknowledge('base');
    client.setMemoryPressure('normal');expect(client.workerCount).toBe(1);
    const next=client.compile('next',0,'next',1);expect(client.workerCount).toBe(4);
    first.complete();await next;
  }finally{client.cancel();}
});
