import { describe, it, expect, vi } from 'vitest';
import { Box3, Matrix4, Vector3 } from 'three';
import { PatrolNavigationRuntime } from '../patrolNavigationRuntime.js';
import type { AppState } from '../../../../app/state.js';
import type { ProjectLoadSession } from '../../../../shared/projectSession.js';
import type { PatrolPart, PatrolSource } from '../../../../viewer/patrol/navigationQueryPort.js';

const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../../../infrastructure/cache/navigation/patrolCache.js', () => ({
  readPatrolCache: async (domain: string, key: string) => records.get(domain + key),
  writePatrolCache: async (domain: string, key: string, value: unknown) => {
    records.set(domain + key, value);
    return true;
  },
}));
vi.mock('../../../../infrastructure/workers/patrolAssetBuilder.js', async () => {
  const { buildPatrolAsset } =
    await import('../../../../viewer/patrol/collision/patrolGeometry.js');
  return {
    PatrolAssetBuilder: class {
      async build(parts: PatrolPart[]) {
        return buildPatrolAsset(parts);
      }
      dispose() {}
    },
  };
});
const identity = new Matrix4();
function source(
  id: string,
  bounds: Box3,
  support: boolean,
  load: PatrolSource['load'],
): PatrolSource {
  return { id, assetKey: id, bounds, matrix: identity, support, load };
}
function fixture(
  id: string,
  sources: PatrolSource[],
  unknown: string[] = [],
  occurrences = [{ id: 'dev', name: '' }],
) {
  const session = { sourceSha256: id, geometryToken: 1 } as ProjectLoadSession;
  const state = {
    geometryLoadToken: 1,
    ifc: { regionalRuntimes: new Map() },
    currentIfcEntries: [],
    sourceGeometry: { catalog: { occurrences } },
    deviceLodRuntime: { patrolDirectory: async () => ({ sources, unknown }) },
    isCurrentSession: () => true,
  } as unknown as AppState;
  return new PatrolNavigationRuntime(state, session);
}
const p = (x: number, y: number, z = 0) => new Vector3(x, y, z);
const slab = () =>
  source('floor', new Box3(p(0, 0), p(8, 8)), true, async () => [
    {
      positions: new Float32Array([0, 0, 0, 8, 0, 0, 0, 8, 0, 8, 8, 0]),
      indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
      matrix: identity.toArray(),
    },
  ]);
describe('source coverage and navigation cache', () => {
  it('uses real ground on the gate approach and can use the inner side if the outside is unmodelled', async () => {
    const gate = source('gate', new Box3(p(0.5, 2, 3.5), p(0.8, 6, 3.8)), false, async () => [
      {
        positions: new Float32Array([0.5, 2, 3.5, 0.5, 6, 3.5, 0.5, 6, 3.8]),
        indices: new Uint32Array([0, 1, 2]),
        matrix: identity.toArray(),
      },
    ]);
    const nav = fixture('gate-inside', [slab(), gate], [], [{ id: 'gate', name: '站区大门' }]);
    try {
      const spawn = await nav.stationEntrance(new AbortController().signal);
      expect(spawn?.sourceId).toBe('floor');
      expect(spawn?.feet.x).toBeCloseTo(2.15);
      expect(spawn?.feet.z).toBeCloseTo(0);
      expect(spawn?.yaw).toBeCloseTo(Math.PI / 2);
    } finally {
      nav.dispose();
    }
  });
  it('falls back to user choice for an unlabelled or unsupported gate', async () => {
    const nav = fixture('no-gate', [slab()]);
    try {
      expect(await nav.stationEntrance(new AbortController().signal)).toBeUndefined();
    } finally {
      nav.dispose();
    }
  });

  it('stands on and climbs a tread narrower than the body diameter', async () => {
    const tread = source('next-tread', new Box3(p(1, 0, 0), p(1.32, 3, 0.167)), true, async () => [
      {
        matrix: identity.toArray(),
        positions: new Float32Array([
          1, 0, 0.167, 1.32, 0, 0.167, 1.32, 3, 0.167, 1, 3, 0.167, 1, 0, 0, 1, 3, 0,
        ]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 0, 3, 4, 3, 5]),
      },
    ]);
    const runtime = fixture('narrow-tread', [slab(), tread]);
    const start = p(0.8, 1);
    await runtime.prepare(start, new AbortController().signal);
    expect(runtime.step(start, start)).toMatchObject({ sourceId: 'floor' });
    const step = runtime.step(p(0.99, 1), p(1.01, 1));
    expect(step).toMatchObject({ sourceId: 'next-tread' });
    if ('feet' in step) expect(step.feet.z).toBeCloseTo(0.167);
    runtime.dispose();
  });
  it('blocks a swept volume intersecting a failed source, and permits disjoint floor in the same tile', async () => {
    const gap = source('failed-equipment', new Box3(p(3, 3), p(4, 4, 2)), false, async () => {
      throw Error('missing triangles');
    });
    const runtime = fixture('partial', [slab(), gap]),
      signal = new AbortController().signal;
    await runtime.prepare(p(1, 1), signal);
    expect(runtime.step(p(1, 1), p(1.2, 1))).toMatchObject({ sourceId: 'floor' });
    expect(runtime.step(p(2.5, 3.5), p(3.1, 3.5))).toMatchObject({
      reason: expect.stringContaining('缺失几何'),
    });
    expect(
      [...records.keys()].some((k) => k.startsWith('coveragepartial') && k.includes('/tile/')),
    ).toBe(false);
    runtime.dispose();
  });
  it('refuses unresolved source range; a verified warm block uses the same floor and no build', async () => {
    const signal = new AbortController().signal;
    const unknown = fixture('unknown', [slab()], ['ifc-without-bounds']);
    await expect(unknown.prepare(p(2, 2), signal)).rejects.toThrow('来源范围未知');
    unknown.dispose();
    const f = slab(),
      load = vi.spyOn(f, 'load');
    for (const hits of [0, 1]) {
      const rt = fixture('warm', [f]);
      await rt.prepare(p(2, 2), signal);
      expect(rt.metrics.blockHits).toBe(hits);
      expect(rt.metrics.assetBuilds).toBe(1 - hits);
      expect(rt.step(p(2, 2), p(2, 2))).toMatchObject({ sourceId: 'floor' });
      rt.dispose();
    }
    expect(load).toHaveBeenCalledTimes(1);
  });
});
