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
  progress: (message: string) => void,
) {
  let needsRetry = false;
  let stored = true;
  const ordered = entrance
    ? [...sources].sort(
        (a, b) => a.bounds.distanceToPoint(entrance) - b.bounds.distanceToPoint(entrance),
      )
    : sources;
  const templates = new Map(ordered.map((row) => [row.assetKey, row]));
  let preparedTemplates = 0;
  const pending = templates.values();
  async function compileNext() {
    for (const row of pending) {
      check();
      if (preparedTemplates % 10 === 0)
        progress(`正在编译巡视场景 ${preparedTemplates}/${templates.size}…`);
      preparedTemplates++;
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
    }
  }
  const results = await Promise.allSettled([compileNext(), compileNext()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return { needsRetry, stored };
}
