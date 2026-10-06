import type { ViewerContext } from './viewerEngine.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { IfcConversionInput, IfcConversionOutput } from './ifcConversionWorker.js';
import { perfBegin } from '../utils/perfTimings.js';

const activeConversions = new Set<() => void>();

/** Release old-project WASM and reject pending conversion without a main-thread retry. */
export function cancelIfcConversions(): void {
  for (const cancel of [...activeConversions]) cancel();
}

/** Preserve the used OBC IfcLoader settings and main-thread model registration;
 * isolate only its IfcImporter.process step. Input remains owned by its caller. */
export async function loadRawIfc(
  ctx: ViewerContext, state: AppState, session: ProjectLoadSession,
  buffer: Uint8Array, runtimeModelId: string, entryPath: string,
  onProgress?: (progress: number) => void, perfSessionId?: number,
) {
  const isCurrent = () => state.isCurrentSession(session);
  if (!isCurrent()) return;
  const diagnosticSession = perfSessionId === undefined ? undefined : { id: perfSessionId };
  const endConversion = perfBegin(`变电 IFC worker conversion · ${entryPath}`,
    { entryPath, phase: 'ifc.worker conversion', source: 'ifc' }, diagnosticSession);
  let failed = false;
  let converted: Uint8Array<ArrayBuffer>;
  try {
    converted = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      let worker: Worker;
      try { worker = new Worker(new URL('./ifcConversionWorker.ts', import.meta.url), { type: 'module' }); }
      catch (error) { reject(error); return; }
      const finish = (error?: Error, bytes?: Uint8Array<ArrayBuffer>) => {
        activeConversions.delete(cancel);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        worker.terminate();
        if (error) reject(error); else resolve(bytes!);
      };
      const cancel = () => finish(new DOMException('IFC conversion belongs to an obsolete project', 'AbortError'));
      activeConversions.add(cancel);
      worker.onmessage = (event: MessageEvent<IfcConversionOutput>) => {
        if (!isCurrent()) { cancel(); return; }
        const response = event.data;
        if (response.type === 'progress') { onProgress?.(response.progress); return; }
        if (response.type === 'error') {
          const error = new Error(response.message); error.stack = response.stack ?? error.stack;
          finish(error);
        } else finish(undefined, response.bytes);
      };
      worker.onerror = (event) => finish(new Error(event.message || 'IFC conversion worker failed'));
      worker.onmessageerror = () => finish(new Error('IFC conversion worker returned unreadable data'));
      try {
        const endPrepare = perfBegin(`变电 IFC worker input preparation · ${entryPath}`,
          { entryPath, phase: 'ifc.worker input preparation', bytes: buffer.byteLength }, diagnosticSession);
        const owned = new Uint8Array(buffer);
        endPrepare();
        const input: IfcConversionInput = { bytes: owned, wasm: { ...ctx.ifcLoader.settings.wasm },
          webIfcSettings: { ...ctx.ifcLoader.settings.webIfc } };
        worker.postMessage(input, [owned.buffer]);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  } catch (error) { failed = true; throw error; }
  finally { endConversion(undefined, { entryPath, phase: 'ifc.worker conversion', failed }); }
  if (!isCurrent()) return;
  // Same coordinate flag, runtime identity and lifecycle events as OBC load().
  ctx.fragments.core.settings.autoCoordinate = true;
  const endLoad = perfBegin(`变电 IFC fragments core.load · ${entryPath}`,
    { entryPath, phase: 'fragments.core.load', source: 'ifc', bytes: converted.byteLength }, diagnosticSession);
  let loadFailed = false;
  try { return await ctx.fragments.core.load(converted, { modelId: runtimeModelId }); }
  catch (error) { loadFailed = true; throw error; }
  finally { endLoad(undefined, { entryPath, phase: 'fragments.core.load', source: 'ifc', failed: loadFailed }); }
}
