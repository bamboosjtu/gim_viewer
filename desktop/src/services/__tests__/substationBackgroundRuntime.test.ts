import { describe, expect, it } from 'vitest';
import { SubstationBackgroundCoordinator } from '../substationBackgroundRuntime.js';

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

describe('SubstationBackgroundCoordinator', () => {
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
