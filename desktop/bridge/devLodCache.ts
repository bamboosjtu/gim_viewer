/** Separate derived device domain. Each template/catalog row commits atomically;
 * no whole-project completion marker is written for an on-demand view.
 *
 * Reads return an explicit status instead of collapsing every failure into
 * `null` (cache miss).  A missing row, a corrupt row and an unavailable native
 * reader are different facts: only `miss` may trigger a cold compile, while
 * `read-error`/`invalid` must remain visible in diagnostics. */
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

export type DevArtifactReadStatus = 'hit' | 'miss' | 'read-error' | 'invalid' | 'deferred';
export interface DevArtifactRead<T> {
  status: DevArtifactReadStatus;
  value?: T;
  error?: string;
}
export interface DevArtifactWriteResult {
  ok: boolean;
  error?: string;
}

function decode<T>(key: string, bytes: Uint8Array | null | undefined): DevArtifactRead<T> {
  if (!bytes || bytes.length === 0) return { status: 'miss' };
  try {
    const value = unpackDevArtifact<T>(key, bytes);
    return value == null ? { status: 'miss' } : { status: 'hit', value };
  } catch (error) {
    return { status: 'invalid', error: String(error) };
  }
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

interface NativeRead { entry: string; key: string; resolve: (value: DevArtifactRead<unknown>) => void }
const queuedReads = new Map<string, { args: ReturnType<typeof nativeArgs> & {}; rows: NativeRead[] }>();

/** Read a bounded native batch, splitting on transport failure so one bad row
 * cannot turn every other valid template into a cache miss. */
async function readNativeBatchRaw<T>(
  args: { projectId: number; sourceGimSha256: string; entryPath: string },
  keys: string[],
  store: string,
  maxBytes?: number,
): Promise<Map<string, DevArtifactRead<T>>> {
  const out = new Map<string, DevArtifactRead<T>>();
  const fullPaths = keys.map((key) => `${store}/${key}`);
  const invokeChunk = async (chunk: string[]): Promise<Map<string, DevArtifactRead<T>>> => {
    const result = new Map<string, DevArtifactRead<T>>();
    try {
      const payload = await invokeTimed<ArrayBuffer>('read_device_lod_artifacts', {
        projectId: args.projectId,
        sourceGimSha256: args.sourceGimSha256,
        entryPaths: chunk,
        ...(maxBytes ? { maxBytes } : {}),
      });
      const found = new Map(parseBatchCachePayload(payload).items.map((item) => [item.entry_path, item.bytes]));
      for (const entry of chunk) {
        const key = entry.slice(store.length + 1);
        if (!found.has(entry)) {
          // The native reader omits rows that exceed the batch byte ceiling.
          result.set(key, { status: 'deferred' });
        } else {
          result.set(key, decode<T>(key, found.get(entry)));
        }
      }
    } catch (error) {
      if (chunk.length <= 1) {
        for (const entry of chunk) result.set(entry.slice(store.length + 1), { status: 'read-error', error: String(error) });
        return result;
      }
      const mid = Math.ceil(chunk.length / 2);
      const left = await invokeChunk(chunk.slice(0, mid));
      const right = await invokeChunk(chunk.slice(mid));
      for (const [key, value] of left) result.set(key, value);
      for (const [key, value] of right) result.set(key, value);
    }
    return result;
  };
  for (let start = 0; start < fullPaths.length; start += 16) {
    const chunk = fullPaths.slice(start, start + 16);
    const values = await invokeChunk(chunk);
    for (const [key, value] of values) out.set(key, value);
  }
  return out;
}

function readNativeArtifact<T>(args: NonNullable<ReturnType<typeof nativeArgs>>, key: string): Promise<DevArtifactRead<T>> {
  const groupKey = JSON.stringify([args.projectId, args.sourceGimSha256]);
  let group = queuedReads.get(groupKey);
  if (!group) {
    group = { args, rows: [] }; queuedReads.set(groupKey, group);
    setTimeout(() => { const batch = queuedReads.get(groupKey)!; queuedReads.delete(groupKey); void flushNativeReads(batch); }, 0);
  }
  const target = group;
  return new Promise((resolve) => target.rows.push({ entry: args.entryPath, key, resolve: resolve as (value: DevArtifactRead<unknown>) => void }));
}
async function flushNativeReads(group: { args: NonNullable<ReturnType<typeof nativeArgs>>; rows: NativeRead[] }): Promise<void> {
  for (let start = 0; start < group.rows.length; start += 16) {
    const rows = group.rows.slice(start, start + 16);
    const store = rows[0].entry.split('/', 1)[0];
    const keys = rows.map((row) => row.key);
    const values = await readNativeBatchRaw<unknown>(group.args, keys, store);
    for (const row of rows) row.resolve(values.get(row.key) ?? { status: 'read-error', error: 'missing batch row' });
  }
}

export async function readDevArtifactBatch<T>(
  store: 'templates' | 'catalog',
  keys: string[],
  context?: CacheContext,
  maxBytes?: number,
): Promise<Map<string, DevArtifactRead<T>>> {
  if (!keys.length) return new Map();
  if (isTauri()) {
    const first = nativeArgs(store, keys[0], context);
    if (!first) return new Map(keys.map((key) => [key, { status: 'read-error' as const, error: 'missing-cache-context' }]));
    return readNativeBatchRaw<T>({ projectId: first.projectId, sourceGimSha256: first.sourceGimSha256, entryPath: first.entryPath }, keys, store, maxBytes);
  }
  try {
    const db = await open();
    const values = await new Promise<Map<string, DevArtifactRead<T>>>((resolve, reject) => {
      const tx = db.transaction(store);
      const objectStore = tx.objectStore(store);
      const rows = new Map<string, DevArtifactRead<T>>();
      for (const key of keys) {
        const request = objectStore.get(key);
        request.onsuccess = () => {
          const value = request.result;
          rows.set(key, value == null ? { status: 'miss' } : { status: 'hit', value });
        };
        request.onerror = () => rows.set(key, { status: 'read-error', error: String(request.error) });
      }
      tx.oncomplete = () => resolve(rows);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    for (const key of keys) if (!values.has(key)) values.set(key, { status: 'read-error', error: 'missing idb row' });
    return values;
  } catch (error) {
    return new Map(keys.map((key) => [key, { status: 'read-error' as const, error: String(error) }]));
  }
}

/** Backward-compatible value-only view. New callers that need to distinguish
 * miss/read-error/invalid should use `readDevArtifactResult`. */
export async function readDevArtifact<T>(store: 'templates' | 'catalog', key: string, context?: CacheContext): Promise<T | null> {
  const result = await readDevArtifactResult<T>(store, key, context);
  return result.status === 'hit' ? result.value! : null;
}

export async function readDevArtifactResult<T>(store: 'templates' | 'catalog', key: string, context?: CacheContext): Promise<DevArtifactRead<T>> {
  if (isTauri()) {
    const args = nativeArgs(store, key, context);
    if (!args) return { status: 'read-error', error: 'missing-cache-context' };
    return readNativeArtifact<T>(args, key);
  }
  const values = await readDevArtifactBatch<T>(store, [key], context);
  return values.get(key) ?? { status: 'read-error', error: 'missing idb row' };
}

export async function writeDevArtifact(
  store: 'templates' | 'catalog',
  key: string,
  value: unknown,
  context?: CacheContext,
): Promise<boolean> {
  return (await writeDevArtifactDetailed(store, key, value, context)).ok;
}

export async function writeDevArtifactDetailed(
  store: 'templates' | 'catalog',
  key: string,
  value: unknown,
  context?: CacheContext,
): Promise<DevArtifactWriteResult> {
  if (isTauri()) {
    const args = nativeArgs(store, key, context);
    if (!args) return { ok: false, error: 'missing-cache-context' };
    try {
      await invokeTimed('write_device_lod_artifact', packBinaryCacheWrite(args.projectId, args.entryPath, packDevArtifact(key, value), args.sourceGimSha256));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function deleteDevArtifact(store: 'templates' | 'catalog', key: string, context?: CacheContext): Promise<void> {
  if (isTauri()) {
    const args = nativeArgs(store, key, context); if (!args) return;
    try { await invokeTimed('delete_device_lod_artifact', args); } catch { /* source rebuild */ } return;
  }
  try {
    const db = await open(); await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } catch { /* source rebuild */ }
}
