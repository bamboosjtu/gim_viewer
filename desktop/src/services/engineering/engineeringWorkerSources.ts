import { decodeGimText } from '../../shared/textDecode.js';
import { NOOP_TASK, type WorkerTaskProbe } from '../../measurement/workerProbe.js';
import { SourceDocuments } from '../../gim/engineering/sourceDocuments.js';
import { createEntryIndex, type EntryIndex } from '../../gim/entryResolver.js';
import {
  ENGINEERING_SOURCE_BATCH_FILES,
  type EngineeringSourceInput,
  type EngineeringWorkerCommand,
} from '../../infrastructure/workers/engineeringWorkerProtocol.js';
import { EngineeringSourceBatches } from './engineeringSourceBatches.js';

/** Owns source carriers, shared document reads and the two-lane input queue. */
export function createEngineeringWorkerSources(
  loadSources?: (paths: string[]) => Promise<EngineeringSourceInput>,
) {
  const files = new Map<string, Blob | Uint8Array>();
  const batches = new EngineeringSourceBatches();
  const sourceErrors = new Map<string, string>();
  const pendingSources = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const sourceQueue: string[] = [];
  let sourceReads = 0,
    sourceScheduled = false;
  let inventoryRevision = 0;
  const requireInventory = (revision: number): void => {
    if (revision !== inventoryRevision)
      throw new DOMException('Engineering source inventory changed', 'AbortError');
  };
  const installSources = async (
    input: EngineeringSourceInput,
    wanted: readonly string[],
    revision: number,
  ) => {
    for (const batch of input.batches) {
      batches.add(batch);
      for (const entry of batch.entries) sourceErrors.delete(entry.path);
    }
    for (const file of input.files) {
      files.set(file.path, file.blob);
      sourceErrors.delete(file.path);
    }
    for (const error of input.errors) sourceErrors.set(error.path, error.message);
    // Wake current consumers before awaiting their shared document promises.
    for (const path of wanted) pendingSources.get(path)?.resolve();
    // Decode each received carrier once into the shared document cache. CBM
    // siblings expose their DEV pointers as a batch instead of one round trip
    // per occurrence. Do not expand speculative DEV trees or read FAM/IFC here.
    const paths = wanted.filter((path) => /\.(cbm|dev)$/i.test(path) && !sourceErrors.has(path));
    lastSourceYield = performance.now();
    const parsed = await Promise.allSettled(paths.map((path) => documents.read(path)));
    if (revision !== inventoryRevision) return;
    const pointers: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i],
        result = parsed[i];
      if (result.status !== 'fulfilled') continue;
      const doc = result.value;
      if (!/\.cbm$/i.test(path) || !entryIndex) continue;
      for (const field of doc.fields)
        if (/^OBJECTMODELPOINTER$/i.test(field.keys[0]) && /\.dev$/i.test(field.value)) {
          const target = entryIndex.resolve(field.value, path);
          if (target && !documents.has(target)) pointers.push(target);
        }
    }
    const room = ENGINEERING_SOURCE_BATCH_FILES * 2 - sourceQueue.length;
    if (room > 0 && pointers.length)
      void ensureSources(pointers.slice(0, room)).catch(() => {
        /* Demand reads retain the failure evidence. */
      });
  };
  const drainSources = () => {
    while (loadSources && sourceReads < 2 && sourceQueue.length) {
      const wanted = sourceQueue.splice(0, ENGINEERING_SOURCE_BATCH_FILES);
      const revision = inventoryRevision;
      sourceReads++;
      void loadSources(wanted)
        .then((input) => {
          if (revision === inventoryRevision) return installSources(input, wanted, revision);
        })
        .catch((error) => {
          if (revision === inventoryRevision)
            for (const path of wanted) sourceErrors.set(path, String(error));
        })
        .finally(() => {
          if (revision === inventoryRevision)
            for (const path of wanted) {
              pendingSources.get(path)?.resolve();
              pendingSources.delete(path);
            }
          sourceReads--;
          drainSources();
        });
    }
  };
  const ensureSources = async (wanted: readonly string[], foreground = false) => {
    const waiting: Promise<void>[] = [];
    for (const path of wanted) {
      if (files.has(path) || batches.has(path) || sourceErrors.has(path)) continue;
      let pending = pendingSources.get(path);
      if (!pending) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        pending = { promise, resolve };
        pendingSources.set(path, pending);
        if (foreground) sourceQueue.unshift(path);
        else sourceQueue.push(path);
      } else if (foreground) {
        const at = sourceQueue.indexOf(path);
        if (at > 0) {
          sourceQueue.splice(at, 1);
          sourceQueue.unshift(path);
        }
      }
      waiting.push(pending.promise);
    }
    if (!sourceScheduled) {
      sourceScheduled = true;
      const revision = inventoryRevision;
      queueMicrotask(() => {
        if (revision !== inventoryRevision) return;
        sourceScheduled = false;
        drainSources();
      });
    }
    await Promise.all(waiting);
  };
  let entryIndex: EntryIndex | undefined;
  let sourceTrace: WorkerTaskProbe = NOOP_TASK;
  let lastSourceYield = 0;
  const documents = new SourceDocuments(async (path) => {
    if (performance.now() - lastSourceYield >= 8) {
      const revision = inventoryRevision;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      requireInventory(revision);
      lastSourceYield = performance.now();
    }
    return readFamily(path, sourceTrace);
  });

  async function readFamily(path: string, trace: WorkerTaskProbe = NOOP_TASK): Promise<string> {
    const revision = inventoryRevision;
    if (loadSources && !batches.has(path) && !files.has(path) && /\.(cbm|dev)$/i.test(path))
      await trace.measureObserved('engineering.source-request', () => ensureSources([path], true));
    requireInventory(revision);
    if (sourceErrors.has(path)) throw Error(sourceErrors.get(path));
    if (batches.has(path)) {
      const text = await batches.read(path, trace);
      requireInventory(revision);
      return text;
    }
    const source = files.get(path);
    if (!source) throw Error('Raw source unavailable: ' + path);
    const bytes =
      source instanceof Uint8Array
        ? source
        : await trace.measureObserved('engineering.source-read', () => source.arrayBuffer());
    requireInventory(revision);
    files.delete(path);
    return decodeGimText(bytes).text;
  }
  async function readRaw(path: string): Promise<Uint8Array> {
    const revision = inventoryRevision;
    const file = files.get(path);
    if (!file) throw Error('Raw source unavailable: ' + path);
    const bytes =
      file instanceof Uint8Array ? file.slice() : new Uint8Array(await file.arrayBuffer());
    requireInventory(revision);
    files.delete(path);
    return bytes;
  }

  function resetInventory(): void {
    inventoryRevision++;
    for (const request of pendingSources.values()) request.resolve();
    pendingSources.clear();
    sourceQueue.length = 0;
    sourceScheduled = false;
    documents.clear();
    entryIndex = undefined;
    files.clear();
    batches.clear();
  }

  return {
    documents,
    readFamily,
    readRaw,
    useTrace(trace: WorkerTaskProbe): void {
      sourceTrace = trace;
    },
    resolveIndex(paths: readonly string[]): EntryIndex {
      return (entryIndex ??= createEntryIndex([...paths].sort()));
    },
    prefetchGraph: loadSources
      ? (wanted: readonly string[]) => {
          const room = ENGINEERING_SOURCE_BATCH_FILES * 2 - sourceQueue.length;
          if (room > 0)
            void ensureSources(wanted.filter((path) => !documents.has(path)).slice(0, room)).catch(
              () => {},
            );
        }
      : undefined,
    prefetchPhysical: loadSources
      ? (wanted: readonly string[]) => {
          if (sourceQueue.length < ENGINEERING_SOURCE_BATCH_FILES * 2)
            void ensureSources(wanted.filter((path) => !documents.has(path))).catch(() => {
              /* Demand reads report per-entry failures. */
            });
        }
      : undefined,
    retainFamilies(needed: Set<string>): void {
      documents.clear();
      entryIndex = undefined;
      for (const path of files.keys()) if (!needed.has(path)) files.delete(path);
      batches.retain(needed);
    },
    discardCarriers(): void {
      files.clear();
      batches.clear();
    },
    resetForCacheRestore: resetInventory,
    resetForInit(): void {
      resetInventory();
      sourceErrors.clear();
    },
    addBatch(batch: EngineeringSourceInput['batches'][number]): void {
      batches.add(batch);
      for (const entry of batch.entries) sourceErrors.delete(entry.path);
    },
    addFiles(request: Extract<EngineeringWorkerCommand, { type: 'files' }>): void {
      for (const source of request.files) {
        if (!source.blob && !source.bytes)
          throw Error(`Engineering source bytes missing: ${source.path}`);
        files.set(source.path, source.blob ?? source.bytes!);
        sourceErrors.delete(source.path);
      }
      for (const error of request.errors ?? []) sourceErrors.set(error.path, error.message);
    },
  };
}
