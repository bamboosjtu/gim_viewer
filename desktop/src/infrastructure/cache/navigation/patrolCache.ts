import type { PatrolAsset } from '../../../shared/patrolSpatialAsset.js';
// Scene manifests and mesh assets share project identity. Publish the manifest after its assets commit.
const databaseName = 'gim-patrol-v1';
let opening: Promise<IDBDatabase> | undefined;
async function database() {
  if (!opening) {
    const req = indexedDB.open(databaseName, 2);
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      // While an old window holds v1 open, callers can use the in-memory scene.
      // Keep this request until it upgrades, rather than queueing more opens behind it.
      req.onblocked = () => reject(new Error('旧巡视窗口占用缓存'));
      req.onupgradeneeded = () => {
        for (const domain of ['assets', 'coverage']) {
          if (req.result.objectStoreNames.contains(domain)) req.result.deleteObjectStore(domain);
          req.result.createObjectStore(domain);
        }
      };
      req.onerror = () => {
        opening = undefined;
        reject(req.error ?? new Error('巡视缓存事务失败'));
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        opening = Promise.resolve(db);
        resolve(db);
      };
    });
  }
  return opening;
}
// All rows for a single source/contract live under one range in both stores.
const ownersKey = '@patrol-projects';
const maxProjects = 4;
const maxAssetBytesPerProject = 512 * 1024 * 1024;
type Owner = { projectId: number | null; prefix: string; bytes: number };
export function patrolCachePrefix(sha: string, projectId: number | null, shapePolicy: string) {
  return [sha, projectId ?? 'local', shapePolicy].join('/') + '/';
}

async function updateOwners(projectId: number | null, prefix?: string) {
  if (typeof indexedDB === 'undefined') return;
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['assets', 'coverage'], 'readwrite');
    const store = tx.objectStore('coverage'),
      req = store.get(ownersKey);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? Error('巡视缓存清理失败'));
    req.onsuccess = () => {
      const old = (req.result as Owner[] | undefined) ?? [];
      const keep = old.filter(
        (x) => x.prefix !== prefix && (projectId === null || x.projectId !== projectId),
      );
      if (prefix)
        keep.unshift(old.find((o) => o.prefix === prefix) ?? { projectId, prefix, bytes: 0 });
      keep.splice(maxProjects);
      for (const x of old) {
        if (keep.some((o) => o.prefix === x.prefix)) continue;
        const range = IDBKeyRange.bound(x.prefix, x.prefix.slice(0, -1) + '0', false, true);
        for (const domain of ['assets', 'coverage']) tx.objectStore(domain).delete(range);
      }
      store.put(keep, ownersKey);
    };
  });
}
export async function enterPatrolCache(projectId: number | null, prefix: string) {
  try {
    await updateOwners(projectId, prefix);
  } catch {
    /* The cold in-memory path remains available. */
  }
}
export function removePatrolProject(projectId: number) {
  return updateOwners(projectId);
}
type Domain = 'assets' | 'coverage';
export async function readPatrolCache<T>(domain: Domain, key: string): Promise<T | undefined> {
  try {
    const db = await database();
    return await new Promise<T>((resolve, reject) => {
      const req = db.transaction(domain).objectStore(domain).get(key);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error('巡视缓存事务失败'));
    });
  } catch {
    return undefined;
  }
}
async function changeEntry(
  domain: Domain,
  key: string,
  prefix: string,
  value: unknown,
  remove: boolean,
) {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        domain === 'assets' ? ['coverage', 'assets'] : ['coverage'],
        'readwrite',
      );
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('巡视缓存事务中止'));
      const coverage = tx.objectStore('coverage'),
        request = coverage.get(ownersKey);
      const put = () =>
        remove ? tx.objectStore(domain).delete(key) : tx.objectStore(domain).put(value, key);
      request.onsuccess = () => {
        const owners = (request.result as Owner[] | undefined) ?? [],
          owner = owners.find((x) => x.prefix === prefix);
        if (!owner || !key.startsWith(prefix)) {
          tx.abort();
          return;
        }
        if (domain === 'coverage') {
          put();
          return;
        }
        const sizeKey = prefix + '@bytes/' + key.slice(prefix.length),
          previous = coverage.get(sizeKey);
        previous.onsuccess = () => {
          const a = value as PatrolAsset;
          const size = remove
            ? 0
            : a.vertices.byteLength + a.order.byteLength + a.nodes.length * 80;
          const total = owner.bytes + size - ((previous.result as number | undefined) ?? 0);
          if (!Number.isSafeInteger(total) || total < 0 || total > maxAssetBytesPerProject) {
            tx.abort();
            return;
          }
          owner.bytes = total;
          if (remove) coverage.delete(sizeKey);
          else coverage.put(size, sizeKey);
          coverage.put(owners, ownersKey);
          put();
        };
      };
    });
    return true;
  } catch {
    return false;
  }
}
export function writePatrolCache(domain: Domain, key: string, value: unknown, prefix: string) {
  return changeEntry(domain, key, prefix, value, false);
}
export function discardPatrolEntry(domain: Domain, key: string, prefix: string) {
  return changeEntry(domain, key, prefix, undefined, true);
}
