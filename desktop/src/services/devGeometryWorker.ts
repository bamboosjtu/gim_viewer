import { serializeDevToGlbDetailed } from './glbCacheService.js';
import { parseWorkerXmlMod } from '../gim/geometry/xmlModWorkerParser.js';
const workerScope = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void };

const pending = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>();
let readId = 0;
const files = new Map<string, File>();
let running = false;
const read = (path: string): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
  const id = ++readId;
  pending.set(id, { resolve, reject });
  self.postMessage({ kind: 'read', id, path });
});

self.onmessage = async ({ data }) => {
  if (data.kind === 'read-result') {
    const task = pending.get(data.id); pending.delete(data.id);
    if (data.error) task?.reject(new Error(data.error)); else task?.resolve(data.bytes);
    return;
  }
  if (data.kind === 'init') {
    for (const [path, size] of data.files as [string, number][]) {
      files.set(path, { name: path.split('/').pop()!, size,
        arrayBuffer: () => read(path), text: async () => new TextDecoder().decode(await read(path)) } as File);
    }
    return;
  }
  if (data.kind !== 'compile' || running) return;
  running = true;
  const started = performance.now();
  try {
    const result = await serializeDevToGlbDetailed(data.path, files, { parseXml: parseWorkerXmlMod });
    workerScope.postMessage({ kind: 'result', path: data.path, result, durationMs: performance.now() - started },
      result.bytes ? [result.bytes.buffer as ArrayBuffer] : []);
  } catch (error) {
    self.postMessage({ kind: 'result', path: data.path,
      error: error instanceof Error ? error.message : String(error),
      sourceEvidence: (error as { sourceEvidence?: string })?.sourceEvidence,
      durationMs: performance.now() - started });
  } finally { running = false; }
};
