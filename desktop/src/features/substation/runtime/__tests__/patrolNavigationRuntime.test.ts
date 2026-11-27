import { describe, it, expect, vi } from 'vitest';
import { Box3, Matrix4, Vector3 } from 'three';
import { PatrolNavigationRuntime } from '../patrolNavigationRuntime.js';
import { DEV_SHAPE_POLICY } from '../../../../infrastructure/cache/devLodIdentity.js';
import type { AppState } from '../../../../app/state.js';
import type { ProjectLoadSession } from '../../../../shared/projectSession.js';
import type { PatrolPart, PatrolSource } from '../../../../viewer/patrol/navigationQueryPort.js';

const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../../../infrastructure/cache/navigation/patrolCache.js', async (actual) => ({
  ...await actual<typeof import('../../../../infrastructure/cache/navigation/patrolCache.js')>(),
  enterPatrolCache: async () => {},
  discardPatrolEntry: async (domain:string,key:string) => {records.delete(domain+key);},
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

  it('publishes only after all placements have finished and walks across tiles without loading', async () => {
    const floor = slab();
    floor.matrix = new Matrix4().makeScale(2, 1, 1);
    floor.bounds.max.x = 16;
    let finish!: () => void;
    const load = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw Error('no triangles');
    });
    const wall = source('wall', new Box3(p(8.01, 5, 0), p(8.12, 6, 2)), false, load);
    const rt = fixture('whole-scene', [floor, wall]);
    const signal = new AbortController().signal;
    const from = p(7.72, 5.1),
      to = p(7.76, 5.1);
    try {
      const preparing = rt.prepareScene(signal);
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      expect(rt.step(from, to)).not.toHaveProperty('feet');
      finish();
      await preparing;
      expect(rt.step(from, to)).toMatchObject({ reason: '附近缺失碰撞几何' });
      expect(rt.metrics.unavailableSources).toBe(1);
      expect(rt.step(p(8.01, 4), p(8.04, 4))).toHaveProperty('feet');
      expect(load).toHaveBeenCalledOnce();
    } finally {
      rt.dispose();
    }
  });
  it('prepares obstacles across tiles before movement and retains real collisions', async () => {
    const floor = slab();
    floor.matrix = new Matrix4().makeScale(2, 1, 1);
    floor.bounds.max.x = 16;
    const distant = source(
      'distant',
      new Box3(p(12, 7), p(13, 7.5, 1)),
      false,
      vi.fn(async () => {
        throw Error('missing');
      }),
    );
    const wall = source(
      'wall',
      new Box3(p(8.1, 3), p(8.1, 5, 2)),
      false,
      vi.fn(async () => [
        {
          matrix: identity.toArray(),
          positions: new Float32Array([8.1, 3, 0, 8.1, 5, 0, 8.1, 4, 2]),
          indices: new Uint32Array([0, 1, 2]),
        },
      ]),
    );
    const rt = fixture('whole-collision', [floor, wall, distant]),
      signal = new AbortController().signal;
    try {
      await rt.prepareScene(signal);
      expect(wall.load).toHaveBeenCalledTimes(1);
      expect(distant.load).toHaveBeenCalledOnce();
      expect(rt.step(p(7.82, 4), p(7.86, 4))).toMatchObject({
        reason: expect.stringContaining('受阻'),
      });
      expect(rt.step(p(8, 2), p(8.05, 2))).toHaveProperty('feet');
    } finally {
      rt.dispose();
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
    await runtime.prepareScene(new AbortController().signal);
    expect(runtime.step(start, start)).toMatchObject({ sourceId: 'floor' });
    const step = runtime.step(p(0.99, 1), p(1.01, 1));
    expect(step).toMatchObject({ sourceId: 'next-tread' });
    if ('feet' in step) expect(step.feet.z).toBeCloseTo(0.167);
    runtime.dispose();
  });
  it('allows a solid tread with an attached nosing but rejects a detached underside', async () => {
    for (const connected of [true, false]) {
      const part = source('tread', new Box3(p(1, 0, 0.15), p(1.32, 3, 0.17)), true, async () => [
        {
          matrix: identity.toArray(),
          positions: new Float32Array([
            1, 0, 0.17, 1.32, 0, 0.17, 1.32, 3, 0.17, 1, 3, 0.17, 1, 0, 0.15, 1.32, 0, 0.15, 1.32,
            3, 0.15, 1, 3, 0.15,
          ]),
          indices: new Uint32Array([
            0,
            1,
            2,
            0,
            2,
            3,
            4,
            7,
            5,
            5,
            7,
            6,
            ...(connected ? [0, 3, 4, 4, 3, 7, 1, 5, 2, 2, 5, 6] : []),
          ]),
        },
      ]);
      const rt = fixture('nosing-' + connected, [slab(), part]);
      try {
        const foot = p(0.82, 1);
        await rt.prepareScene(new AbortController().signal);
        expect(rt.step(foot, foot)).toHaveProperty(connected ? 'feet' : 'reason');
      } finally {
        rt.dispose();
      }
    }
  });
  it('blocks an unrelated low fin in the same mesh as a reachable tread', async () => {
    const step = source('stairs-with-fin', new Box3(p(0.7, 0), p(1.4, 3, 0.2)), true, async () => [
      {
        matrix: identity.toArray(),
        positions: new Float32Array([
          1, 0, 0.2, 1.4, 0, 0.2, 1.4, 3, 0.2, 1, 3, 0.2, 0.82, 0.9, 0, 0.82, 1.1, 0, 0.82, 1, 0.12,
        ]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6]),
      },
    ]);
    const rt = fixture('low-fin', [slab(), step]);
    try {
      await rt.prepareScene(new AbortController().signal);
      expect(rt.step(p(0.75, 1), p(0.8, 1))).toHaveProperty('reason');
      expect(rt.step(p(0.99, 1), p(1.01, 1))).toHaveProperty('reason');
      expect(rt.step(p(1.01, 1, 0.2), p(0.99, 1, 0.2))).toHaveProperty('reason');
      expect(rt.step(p(0.99, 2), p(1.01, 2))).toHaveProperty('feet');
    } finally {
      rt.dispose();
    }
  });
  it.each([true, false])(
    'retains estimated coverage on cold and warm entry (support %s)',
    async (support) => {
      const member = source('steel', new Box3(p(3, 3), p(4, 4, 0.1)), support, async () => [
        {
          matrix: identity.toArray(),
          positions: new Float32Array([3, 3, 0, 4, 3, 0, 3, 4, 0]),
          indices: new Uint32Array([0, 1, 2]),
        },
      ]);
      if (support) member.estimatedSteelSections = 1;
      else { member.approximate = true; member.estimatedGeometryCount = 1; member.approximationReasons = { 'MOD/1.mod': ['Wire / preview-only'] }; }
      const key = 'estimated-' + support;
      for (const hits of [0, 1]) {
        const rt = fixture(key, [slab(), member]);
        try {
          await rt.prepareScene(new AbortController().signal);
          expect(rt.metrics.fromCache).toBe(Boolean(hits));
          expect(rt.metrics.persisted).toBe(true);
          expect(rt.step(p(3, 3), p(3, 3))).toMatchObject({ estimated: true, sourceId: 'floor' });
          expect(rt.step(p(1, 1), p(1, 1))).not.toHaveProperty('estimated', true);
        } finally {
          rt.dispose();
        }
      }
    },
  );
  it('uses actual support in a partially represented scene', async () => {
    const gap = source('failed-equipment', new Box3(p(3, 3), p(4, 4, 2)), false, async () => {
      throw Error('missing triangles');
    });
    const runtime = fixture('partial', [slab(), gap]),
      signal = new AbortController().signal;
    await runtime.prepareScene(signal);
    expect(runtime.step(p(1, 1), p(1.2, 1))).toMatchObject({ sourceId: 'floor' });
    expect(runtime.step(p(2.5, 3.5), p(3.1, 3.5))).toMatchObject({ reason: '附近缺失碰撞几何' });
    expect(runtime.step(p(7.99, 8.4), p(7.99, 8.4))).toMatchObject({ reason: '无连续落脚面' });
    const manifest = [...records].find(
      ([key]) => key.startsWith('coveragepartial') && key.endsWith('/scene-v1'),
    );
    expect(manifest?.[1]).toMatchObject({ unavailable: ['failed-equipment'] });
    runtime.dispose();
  });
  it('finds the gate even when some baked assets are unavailable', async () => {
    const gate = source('gate', new Box3(p(0.5, 2, 3.5), p(0.8, 6, 3.8)), false, async () => [
      {
        positions: new Float32Array([0.5, 2, 3.5, 0.5, 6, 3.5, 0.5, 6, 3.8]),
        indices: new Uint32Array([0, 1, 2]),
        matrix: identity.toArray(),
      },
    ]);
    const load = vi.fn(async () => {
      throw Error('irrelevant geometry');
    });
    const remote = source('equipment', new Box3(p(5, 6), p(7, 7, 2)), false, load);
    const rt = fixture(
      'gate-local',
      [slab(), gate, remote],
      ['unlocated-cabinet'],
      [{ id: 'gate', name: '站区大门' }],
    );
    try {
      const spawn = await rt.stationEntrance(new AbortController().signal);
      expect(spawn).toMatchObject({ sourceId: 'floor' });
      expect(rt.unknownSourceCount).toBe(1);
      expect(rt.step(spawn!.feet, spawn!.feet.clone().add(p(0.03, 0)))).toMatchObject({
        sourceId: 'floor',
      });
      expect(load).toHaveBeenCalledOnce();
      expect(rt.step(p(7.99, 8.4), p(7.99, 8.4))).toMatchObject({ reason: '无连续落脚面' });
    } finally {
      rt.dispose();
    }
  });

  it('retains an actual preview-only template on both entrances when the directory has no estimate',async()=>{
    const floor=slab();
    const load=floor.load;
    floor.load=async signal=>(await load(signal)).map(p=>({...p,previewShapes:['CurveCable:preview-only']}));
    for(const cached of [false,true]){
      const rt=fixture('mesh-quality',cached?[]:[floor]);
      await rt.prepareScene(new AbortController().signal);
      expect(rt.metrics.fromCache).toBe(cached);
      expect(rt.step(p(2,2),p(2,2))).toMatchObject({estimated:true,sourceId:'floor'});rt.dispose();
    }
  });
  it('uses the Z-up IFC hinge with web-ifc Y-up vertices on cold and cached entry',async()=>{
    const leaf=source('ifc#1',new Box3(p(2,3,0),p(2,3.9,2)),false,async()=>[{
      matrix:identity.toArray(),positions:new Float32Array([2,0,-3,2,0,-3.9,2,2,-3.9]),indices:new Uint32Array([0,1,2])
    }]);
    leaf.matrix=new Matrix4().makeRotationX(Math.PI/2);
    leaf.door={sourceId:'1',leafRepresentationId:'7',hingePosition:[2,3,0],hingeAxis:[0,0,1],closedTip:[2,3.9,0],radius:.9,openAngle:Math.PI/2,closedAngle:0,evidence:['IFCDOOR']};
    leaf.doorAddress={path:'example.ifc',expressId:1};
    for (const warm of [false,true]) {
      const rt=fixture('door-space',warm?[]:[slab(),leaf]);await rt.prepareScene(new AbortController().signal);
      expect(rt.metrics.fromCache).toBe(warm);expect(rt.canOperate(leaf.id)).toBe(true);
      rt.dispose();
    }
  });
  it('rebuilds invalid cached bounds and invalid BVH children from their owning sources',async()=>{
    const floor=slab(),signal=new AbortController().signal;
    const id='cache-repair', cold=fixture(id,[floor]); await cold.prepareScene(signal);cold.dispose();
    const manifest=[...records].find(([key])=>key.startsWith('coverage'+id) && key.endsWith('/scene-v1'))![1] as {sources:{bounds:number[]}[]};
    manifest.sources[0].bounds=[NaN];
    const asset=[...records].find(([key])=>key.startsWith('assets'+id))![1] as {nodes:{left?:number}[]};
    asset.nodes[0].left=0;
    const repair=fixture(id,[floor]);
    await repair.prepareScene(signal);
    expect(repair.metrics.fromCache).toBe(false);
    expect(repair.metrics.assetBuilds).toBe(1);
    expect(repair.step(p(2,2),p(2,2))).toMatchObject({sourceId:'floor'});
    repair.dispose();
  });
  it('loads a warm scene without consulting the source directory or rebuilding the mesh', async () => {
    const signal = new AbortController().signal;
    const f = slab(),
      load = vi.spyOn(f, 'load');
    for (const [pass, hits] of [0, 0, 1].entries()) {
      const rt = fixture('warm', hits ? [] : [f]);
      await rt.prepareScene(signal);
      expect(rt.metrics.fromCache).toBe(Boolean(hits));
      expect(rt.metrics.assetBuilds).toBe(1 - hits);
      expect(rt.step(p(2, 2), p(2, 2))).toMatchObject({ sourceId: 'floor' });
      rt.dispose();
      if (pass === 0) {
        const current = [...records].filter(([key]) => key.includes('warm/') && key.includes(DEV_SHAPE_POLICY));
        expect(current.length).toBeGreaterThan(0);
        for (const [key,value] of current) {
          records.set(key.replace(DEV_SHAPE_POLICY,'open-steel-section-v1+sdk-box-cylinder-project-column-major-v1'), value);
          records.delete(key);
        }
      }
    }
    expect(load).toHaveBeenCalledTimes(2);
  });
});
