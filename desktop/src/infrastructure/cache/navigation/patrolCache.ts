// A and B share project identity, but each record has its own atomic commit.
const databaseName = 'gim-patrol-v1';
let opening: Promise<IDBDatabase> | undefined;
async function database() {
  if (!opening)
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(databaseName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('assets');
        req.result.createObjectStore('coverage');
      };
      req.onerror = () => reject(req.error ?? new Error('巡视缓存事务失败'));
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close();
          opening = undefined;
        };
        resolve(req.result);
      };
    }).catch((error) => {
      opening = undefined;
      throw error;
    });
  return opening;
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
export async function writePatrolCache(
  domain: Domain,
  key: string,
  value: unknown,
): Promise<boolean> {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(domain, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('巡视缓存事务失败'));
      tx.onerror = () => reject(tx.error ?? new Error('巡视缓存事务失败'));
      tx.objectStore(domain).put(value, key);
    });
    return true;
  } catch {
    return false;
  }
}
