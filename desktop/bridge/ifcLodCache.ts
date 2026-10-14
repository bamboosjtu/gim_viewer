/** Independent derived cache: source SHA + entry + installed deps + LOD policy.
 * IndexedDB works offline in both the desktop WebView and browser. */
const databaseName = 'gim-ifc-lod-v1';
let database: Promise<IDBDatabase> | null = null;
let warnedUnavailable = false;
function open(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('artifacts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }); // Storage absence is stable within this page; source fallback must not repeatedly reopen it.
  return database!;
}
export async function readIfcLodArtifact<T>(key: string): Promise<T | null> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction('artifacts')
        .objectStore('artifacts')
        .get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}
export async function writeIfcLodArtifact(
  key: string,
  value: unknown
): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('artifacts', 'readwrite');
      tx.objectStore('artifacts').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    if (!warnedUnavailable) { warnedUnavailable = true; console.warn('[IFC LOD] cache write unavailable', error); }
  }
}
export async function deleteIfcLodArtifact(key: string): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('artifacts', 'readwrite');
      tx.objectStore('artifacts').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* fallback to source */
  }
}
