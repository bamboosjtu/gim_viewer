import { describe, expect, it } from 'vitest';
import { SubstationBackgroundCoordinator } from '../substationBackgroundRuntime.js';

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

describe('SubstationBackgroundCoordinator', () => {
  it('builds the light device catalog at the coordinate anchor while IFC remains pending', async () => {
    const order: string[] = [];
    const coordinator = new SubstationBackgroundCoordinator({ session: { id: 10 }, isCurrent: () => true });
    coordinator.registerRemainingIfc(); coordinator.startRemainingIfc();
    coordinator.enqueue({ task: 'devGeometry', priority: 2, heavy: false, startAfter: 'coordinateAnchorReady', run: () => { order.push('catalog'); } });
    coordinator.markInteractive(); await tick(); expect(order).toEqual([]);
    coordinator.markCoordinateAnchorReady(); await tick(); expect(order).toEqual(['catalog']);
  });
  it('cached DEV runs at an anchor while Preview stays pending; rebuild retains its tail gate and heavy lease',async()=>{
    let resolve!:()=>void;const held=new Promise<void>(r=>resolve=r),order:string[]=[];
    const coordinator=new SubstationBackgroundCoordinator({session:{id:9},isCurrent:()=>true});
    coordinator.registerRemainingIfc();coordinator.startRemainingIfc();
    coordinator.enqueue({task:'devGeometry',priority:2,heavy:true,startAfter:'coordinateAnchorReady',run:async()=>{order.push('dev');await held;}});
    coordinator.enqueue({task:'spatialSemanticRebuild',priority:1,heavy:true,startAfter:'allIfcPreviewsReady',run:()=>{order.push('rebuild');}});
    coordinator.markInteractive();await tick();expect(order).toEqual([]);
    coordinator.markCoordinateAnchorReady();await tick();expect(order).toEqual(['dev']);
    coordinator.markAllIfcPreviewsReady();await tick();expect(order).toEqual(['dev']);
    resolve();await tick();await tick();expect(order).toEqual(['dev','rebuild']);
  });

  it('serializes the heavy lane and keeps low-priority persistence behind geometry', async () => {
    let current = true;
    const order: string[] = [];
    const events: string[] = [];
    const coordinator = new SubstationBackgroundCoordinator({
      session: { id: 1 },
      isCurrent: () => current,
      onEvent: (event) => events.push(`${event.task}:${event.state}`),
    });
    coordinator.registerRemainingIfc();
    coordinator.startRemainingIfc();
    coordinator.enqueue({
      task: 'spatialSemanticCacheRestore',
      priority: 1,
      heavy: false,
      startAfter: 'interactive',
      blocksHeavy: true,
      run: async () => { order.push('cache-restore'); },
    });
    coordinator.enqueue({
      task: 'spatialSemanticRebuild',
      priority: 1,
      heavy: true,
      startAfter: 'allIfcReady',
      run: async () => { order.push('spatial-rebuild'); },
    });
    coordinator.enqueue({
      task: 'devGeometry',
      priority: 2,
      heavy: true,
      startAfter: 'allIfcReady',
      run: async () => { order.push('dev-geometry'); },
    });
    coordinator.enqueue({
      task: 'cachePersistence',
      priority: 10,
      heavy: false,
      startAfter: 'allIfcReady',
      run: async () => { order.push('persistence'); },
    });

    coordinator.markInteractive();
    await tick();
    expect(order).toEqual(['cache-restore']);

    coordinator.completeRemainingIfc();
    coordinator.markAllIfcReady();
    await tick();
    await tick();
    expect(order).toEqual(['cache-restore', 'spatial-rebuild', 'dev-geometry', 'persistence']);
    expect(events).toContain('spatialSemanticRebuild:running');
    expect(events).toContain('cachePersistence:completed');
    current = false;
  });

  it('cancels queued tasks after the session becomes stale and never runs them', async () => {
    let current = true;
    let ran = false;
    const states: string[] = [];
    const coordinator = new SubstationBackgroundCoordinator({
      session: { id: 2 },
      isCurrent: () => current,
      onEvent: (event) => states.push(`${event.task}:${event.state}`),
    });
    coordinator.enqueue({
      task: 'devGeometry',
      priority: 1,
      heavy: true,
      startAfter: 'allIfcReady',
      run: async () => { ran = true; },
    });
    current = false;
    coordinator.cancelPending();
    coordinator.markAllIfcReady();
    await tick();
    expect(ran).toBe(false);
    expect(states).toContain('devGeometry:cancelled');
  });

  it('keeps remainingIfc as a manual marker even if interactive is marked first', async () => {
    let current = true;
    const states: string[] = [];
    const coordinator = new SubstationBackgroundCoordinator({
      session: { id: 3 },
      isCurrent: () => current,
      onEvent: (event) => states.push(`${event.task}:${event.state}`),
    });
    coordinator.registerRemainingIfc();
    coordinator.markInteractive();
    await tick();
    expect(states).not.toContain('remainingIfc:running');

    coordinator.startRemainingIfc();
    expect(states).toContain('remainingIfc:running');
    coordinator.completeRemainingIfc();
    expect(states).toContain('remainingIfc:completed');
    current = false;
  });

  it('opens preview-gated work without claiming all IFC fine models are ready', async () => {
    let current = true;
    const order: string[] = [];
    const coordinator = new SubstationBackgroundCoordinator({
      session: { id: 4 }, isCurrent: () => current,
    });
    coordinator.enqueue({ task: 'devGeometry', priority: 2, heavy: true,
      startAfter: 'allIfcPreviewsReady', run: async () => { order.push('dev'); } });
    coordinator.enqueue({ task: 'spatialSemanticRebuild', priority: 1, heavy: true,
      startAfter: 'allIfcReady', run: async () => { order.push('fine-ready-only'); } });
    coordinator.markInteractive();
    coordinator.markAllIfcPreviewsReady();
    await tick(); await tick();
    expect(order).toEqual(['dev']);
    coordinator.markAllIfcReady();
    await tick(); await tick();
    expect(order).toEqual(['dev', 'fine-ready-only']);
    current = false;
  });

  it('deduplicates a selected fine request and lets it run before queued background work', async () => {
    let current = true;
    const order: string[] = [];
    const coordinator = new SubstationBackgroundCoordinator({ session: { id: 5 }, isCurrent: () => current });
    coordinator.enqueue({ task: 'devGeometry', priority: 0, heavy: true,
      startAfter: 'allIfcPreviewsReady', run: async () => { order.push('ordinary'); } });
    coordinator.markInteractive();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = coordinator.enqueueUserIfcFine('selected-A', async () => { order.push('selected'); await held; });
    const duplicate = coordinator.enqueueUserIfcFine('selected-A', async () => { order.push('duplicate'); });
    expect(duplicate.promise).toBe(first.promise);
    coordinator.markAllIfcPreviewsReady();
    await tick();
    expect(order).toEqual(['selected']);
    release();
    await first.promise;
    await tick(); await tick();
    expect(order).toEqual(['selected', 'ordinary']);
    current = false;
  });

  it('cancels a selected fine request only while it is queued', async () => {
    let current = true;
    const coordinator = new SubstationBackgroundCoordinator({ session: { id: 6 }, isCurrent: () => current });
    coordinator.markInteractive();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const active = coordinator.enqueueUserIfcFine('active', () => held);
    await tick();
    const queued = coordinator.enqueueUserIfcFine('queued', async () => { throw new Error('must not run'); });
    const observed = queued.promise.catch((error: Error) => error.name);
    expect(queued.cancel()).toBe(true);
    await expect(observed).resolves.toBe('AbortError');
    expect(active.cancel()).toBe(false);
    release(); await active.promise;
    current = false;
  });
});

function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};}
it.each(['success','failure','cancel','switch'] as const)('DEV checkpoint resumes safely after user Fine %s',async(mode)=>{
  let current=true,active=0,maxActive=0;
  const order:string[]=[],a=gate(),started=gate(),fineStarted=gate(),fineEnd=gate(),devEnd=gate();
  const c=new SubstationBackgroundCoordinator({session:{id:20},isCurrent:()=>current});
  c.markInteractive();c.markAllIfcPreviewsReady();
  c.enqueue({task:'devGeometry',priority:1,heavy:true,startAfter:'allIfcPreviewsReady',run:async()=>{
    active++;maxActive=Math.max(maxActive,active);order.push('A');started.resolve();await a.promise;
    active--;await c.servicePendingUserFineAtCheckpoint({phase:'cold-dev',path:'DEV/A.dev',durationMs:1});
    if(current){active++;maxActive=Math.max(maxActive,active);order.push('B');active--;}
    devEnd.resolve();
  }});await started.promise;
  const f=c.enqueueUserIfcFine('fine',async()=>{active++;maxActive=Math.max(maxActive,active);order.push('fine');fineStarted.resolve();
    try{await fineEnd.promise;if(mode==='failure')throw Error('conversion failed');}finally{active--;}
  });const observed=f.promise.catch(e=>e.message);
  if(mode==='cancel')expect(f.cancel()).toBe(true);
  a.resolve();
  if(mode!=='cancel'){await fineStarted.promise;expect(order).toEqual(['A','fine']);if(mode==='switch'){current=false;c.cancelPending();}fineEnd.resolve();}
  await observed;await devEnd.promise;
  expect(order).toEqual(mode==='cancel'?['A','B']:mode==='switch'?['A','fine']:['A','fine','B']);
  expect(maxActive).toBe(1);expect(active).toBe(0);
});
it('each checkpoint services only one queued request and gives the next DEV unit a turn',async()=>{
  const order:string[]=[],started=gate(),a=gate(),done=gate();
  const c=new SubstationBackgroundCoordinator({session:{id:21},isCurrent:()=>true});c.markInteractive();c.markAllIfcPreviewsReady();
  c.enqueue({task:'devGeometry',priority:1,heavy:true,startAfter:'allIfcPreviewsReady',run:async()=>{
    order.push('A');started.resolve();await a.promise;
    await c.servicePendingUserFineAtCheckpoint({phase:'cold-dev',path:'A',durationMs:1});order.push('B');
    await c.servicePendingUserFineAtCheckpoint({phase:'cold-dev',path:'B',durationMs:1});order.push('C');done.resolve();
  }});await started.promise;
  const f1=c.enqueueUserIfcFine('one',async()=>{order.push('one');}),f2=c.enqueueUserIfcFine('two',async()=>{order.push('two');});
  a.resolve();await Promise.all([f1.promise,f2.promise,done.promise]);expect(order).toEqual(['A','one','B','two','C']);
});

it('an unexpected DEV task exit releases the lane and runs pending Fine before the next heavy task',async()=>{
  const order:string[]=[],started=gate(),exit=gate(),next=gate();
  const c=new SubstationBackgroundCoordinator({session:{id:22},isCurrent:()=>true});c.markInteractive();c.markAllIfcPreviewsReady();
  c.enqueue({task:'devGeometry',priority:1,heavy:true,startAfter:'allIfcPreviewsReady',run:async()=>{order.push('A');started.resolve();await exit.promise;throw Error('unexpected DEV exit');}});
  c.enqueue({task:'spatialSemanticRebuild',priority:2,heavy:true,startAfter:'allIfcPreviewsReady',run:async()=>{order.push('next heavy');next.resolve();}});
  await started.promise;const fine=c.enqueueUserIfcFine('small',async()=>{order.push('Fine');});exit.resolve();await fine.promise;await next.promise;
  expect(order).toEqual(['A','Fine','next heavy']);expect(c.snapshot().find(x=>x.task==='devGeometry')?.state).toBe('failed');
});
