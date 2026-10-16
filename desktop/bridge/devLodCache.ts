/** Separate derived device domain. Each template/catalog row commits atomically;
 * no whole-project completion marker is written for an on-demand view. */
import { isTauri } from './runtime.js';
import { invokeTimed } from './invokeTimed.js';
import { packBinaryCacheWrite, parseBatchCachePayload } from './database.js';
interface CacheContext { projectId: number | null; sourceSha256: string | null }
function nativeArgs(store: string, key: string, context?: CacheContext) {
  if (context?.projectId == null || !context.sourceSha256) return null;
  return { projectId: context.projectId, sourceGimSha256: context.sourceSha256, entryPath: `${store}/${key}` };
}
/** Metadata stays JSON; GLB bytes stay binary, without a JSON numeric array. */
export function packDevArtifact(key: string, value: any): Uint8Array {
  const data: Uint8Array | null = value?.result?.bytes ?? null;
  const json = new TextEncoder().encode(JSON.stringify({ key, value: data ? { ...value, result: { ...value.result, bytes: null } } : value }));
  const out = new Uint8Array(4 + json.length + (data?.length ?? 0));
  new DataView(out.buffer).setUint32(0, json.length, true); out.set(json, 4); if (data) out.set(data, 4 + json.length); return out;
}
export function unpackDevArtifact<T>(key: string, bytes: Uint8Array): T | null {
  if (!bytes.length) return null;
  if (bytes.length < 4) throw Error('DEV artifact header truncated');
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (len > 1024 * 1024 || len + 4 > bytes.length) throw Error('DEV artifact metadata invalid');
  const record = JSON.parse(new TextDecoder().decode(bytes.subarray(4, len + 4)));
  if (record.key !== key) throw Error('DEV artifact key mismatch');
  if (record.value?.result && bytes.length > len + 4) record.value.result.bytes = bytes.slice(len + 4);
  else if (bytes.length > len + 4) throw Error('DEV artifact unexpected binary body');
  return record.value;
}
const name = 'gim-dev-lod-v1';
let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('templates'); req.result.createObjectStore('catalog'); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  }); // A failed storage open stays failed for this page; do not retry for every DEV.
  return opening;
}
interface NativeRead { entry: string; key: string; resolve: (value: unknown) => void }
const queuedReads = new Map<string,{args:ReturnType<typeof nativeArgs> & {};rows:NativeRead[]}>();
function readNativeArtifact<T>(args: NonNullable<ReturnType<typeof nativeArgs>>, key: string): Promise<T|null> {
  const groupKey=JSON.stringify([args.projectId,args.sourceGimSha256]);
  let group=queuedReads.get(groupKey);
  if (!group) {
    group={args,rows:[]}; queuedReads.set(groupKey,group);
    setTimeout(() => { const batch=queuedReads.get(groupKey)!;queuedReads.delete(groupKey);void flushNativeReads(batch); },0);
  }
  const target=group;
  return new Promise(resolve=>target.rows.push({entry:args.entryPath,key,resolve:resolve as (value:unknown)=>void}));
}
async function flushNativeReads(group: {args:NonNullable<ReturnType<typeof nativeArgs>>;rows:NativeRead[]}): Promise<void> {
  for (let start=0;start<group.rows.length;start+=16) {
    const rows=group.rows.slice(start,start+16);
    try {
      const payload=await invokeTimed<ArrayBuffer>('read_device_lod_artifacts',{projectId:group.args.projectId,
        sourceGimSha256:group.args.sourceGimSha256,entryPaths:rows.map(row=>row.entry)});
      const found=new Map(parseBatchCachePayload(payload).items.map(item=>[item.entry_path,item.bytes]));
      for (const row of rows) { try { const bytes=found.get(row.entry);row.resolve(bytes ? unpackDevArtifact(row.key,bytes) : null); } catch { row.resolve(null); } }
    } catch { for (const row of rows) row.resolve(null); }
  }
}
export async function readDevArtifact<T>(store: 'templates' | 'catalog', key: string, context?: CacheContext): Promise<T | null> {
  if (isTauri()) {
    const args = nativeArgs(store, key, context); if (!args) return null;
    return readNativeArtifact<T>(args,key);
  }
  try { const db = await open(); return await new Promise<T | null>((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null); req.onerror = () => reject(req.error);
  }); } catch { return null; }
}
export async function writeDevArtifact(store: 'templates' | 'catalog', key: string, value: unknown, context?: CacheContext): Promise<boolean> {
  if (isTauri()) {
    const args = nativeArgs(store, key, context); if (!args) return false;
    try { await invokeTimed('write_device_lod_artifact', packBinaryCacheWrite(args.projectId, args.entryPath, packDevArtifact(key, value), args.sourceGimSha256)); return true; }
    catch (error) { console.warn('[DEV LOD] native cache unavailable', error); return false; }
  }
  try { const db = await open(); await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); return true; } catch (error) { console.warn('[DEV LOD] cache unavailable', error); return false; }
}
export async function deleteDevArtifact(store: 'templates' | 'catalog', key: string, context?: CacheContext): Promise<void> {
  if (isTauri()) {
    const args = nativeArgs(store, key, context); if (!args) return;
    try { await invokeTimed('delete_device_lod_artifact', args); } catch { /* source rebuild */ } return;
  }
  try { const db = await open(); await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  }); } catch { /* source rebuild */ }
}
