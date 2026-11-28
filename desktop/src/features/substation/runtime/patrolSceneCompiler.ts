import type { Vector3 } from 'three';
import type { PatrolSource } from '../../../viewer/patrol/navigationQueryPort.js';
import {
  UnsupportedPatrolSourceError,
  type PatrolAsset,
} from '../../../shared/patrolSpatialAsset.js';
import type { PatrolAssetBuilder } from '../../../infrastructure/workers/patrolAssetBuilder.js';
import {
  readPatrolCache,
  writePatrolCache,
  discardPatrolEntry,
} from '../../../infrastructure/cache/navigation/patrolCache.js';
import { usableAsset } from './patrolSceneCache.js';
import {
  beginDevGeometryWork,
  ifcGeometryBusy,
  onGeometryWorkAvailable,
} from '../../../viewer/geometryWorkGate.js';
function reserveBuild(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      unwatch();
      reject(new DOMException('巡视构建已取消', 'AbortError'));
    };
    const admit = () => {
      const release = beginDevGeometryWork(ifcGeometryBusy() ? 1 : 2);
      if (release) {
        unwatch();
        signal.removeEventListener('abort', cancel);
        resolve(release);
      }
    };
    const unwatch = onGeometryWorkAvailable(admit);
    signal.addEventListener('abort', cancel, { once: true });
    admit();
  });
}

// At most two source loads/builds are outstanding. The shared geometry gate controls Worker admission.
export async function compilePatrolAssets(
  sources: PatrolSource[],
  entrance: Vector3 | undefined,
  assets: Map<string, PatrolAsset>,
  unavailable: Set<string>,
  key: string,
  prefix: string,
  builder: PatrolAssetBuilder,
  metrics: { assetHits: number; assetBuilds: number },
  signal: AbortSignal,
  check: () => void,
  progress: (message: string, done?: number, total?: number) => void,
) {
  let needsRetry = false;
  let stored = true;
  const ordered = entrance
    ? [...sources].sort(
        (a, b) => a.bounds.distanceToPoint(entrance) - b.bounds.distanceToPoint(entrance),
      )
    : sources;
  const templates = new Map(ordered.map((row) => [row.assetKey, row]));
  const uses = new Map<string, number>();
  for (const row of ordered) uses.set(row.assetKey, (uses.get(row.assetKey) ?? 0) + 1);
  let done = 0,
    reported = 0;
  progress('正在编译巡视场景', 0, ordered.length);
  // The nearest template establishes model order. Finish its requests before allowing
  // another IFC to evict it. Independent DEV assets keep their distance order and concurrency.
  const groups = new Map<string | undefined, PatrolSource[]>();
  for (const row of templates.values()) {
    let group = groups.get(row.residentModel);
    if (!group) {
      group = [];
      groups.set(row.residentModel, group);
    }
    group.push(row);
  }
  async function compileNext(pending: IterableIterator<PatrolSource>) {
    for (const row of pending) {
      check();
      try {
        if (assets.has(row.assetKey) || unavailable.has(row.assetKey)) continue;
        const assetKey = key + '/' + row.assetKey;
        let asset = await readPatrolCache<PatrolAsset>('assets', assetKey);
        check();
        if (usableAsset(asset)) {
          metrics.assetHits++;
        } else {
          try {
            if (asset) await discardPatrolEntry('assets', assetKey, prefix);
            check();
            const parts = await row.load(signal);
            check();
            const release = await reserveBuild(signal);
            try {
              check();
              asset = await builder.build(parts);
            } finally {
              release();
            }
            check();
            metrics.assetBuilds++;
            if (!(await writePatrolCache('assets', assetKey, asset, prefix))) stored = false;
            check();
          } catch (error) {
            check();
            if (error instanceof UnsupportedPatrolSourceError) unavailable.add(row.assetKey);
            else needsRetry = true;
            continue;
          }
        }
        assets.set(row.assetKey, asset);
      } finally {
        done += uses.get(row.assetKey)!;
        if (!signal.aborted && (done === ordered.length || done - reported >= 10)) {
          reported = done;
          progress(`正在编译巡视场景 ${done}/${ordered.length}`, done, ordered.length);
        }
      }
    }
  }
  for (const group of groups.values()) {
    const pending = group.values();
    const results = await Promise.allSettled([compileNext(pending), compileNext(pending)]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  return { needsRetry, stored };
}
