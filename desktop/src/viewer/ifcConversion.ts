import measuredWorkerAsset from './ifcConversionWorker.ts?worker&url';
import { createMeasuredWorker, measurementWorkerUrl } from '../measurement/hostWorker.js';
import { reserveIfcGeometryWork } from './geometryWorkGate.js';
import type { ViewerContext } from './viewerEngine.js';
import type { ViewerState as AppState } from '../shared/viewerState.js';
import type { ProjectLoadSession } from '../shared/projectSession.js';
import type { IfcConversionInput, IfcConversionOutput } from './ifcConversionWorker.js';
import { perfBegin, perfRecordExternalSpan } from '../utils/perfTimings.js';
import type { IfcOpeningPolicy } from '../config/features.js';
import type { RegionalIndex } from './ifcRegionalData.js';
export {
  IFC_CONNECTION_BATCH_MAX_OBJECTS,
  IFC_CONNECTION_BATCH_MAX_BYTES,
} from './ifcConnectionBatches.js';

/** A bounded, ordered batch of source-evidenced connection objects. */
export type IfcRegionalConnectionBatch =
  import('./ifcConnectionBatches.js').ConnectionGeometryBatch;

const activeConversions = new Set<() => void>();

/** Release old-project WASM and reject pending conversion without a main-thread retry. */
export function cancelIfcConversions(): void {
  for (const cancel of [...activeConversions]) cancel();
}

/** Preserve the used OBC IfcLoader settings and main-thread model registration;
 * isolate only its IfcImporter.process step. A deferred source read can overlap
 * booting the Worker reserved by the single IFC gate. */
export async function loadRawIfc(
  ctx: ViewerContext,
  state: AppState,
  session: ProjectLoadSession,
  source: Uint8Array | (() => Promise<Uint8Array | null>),
  runtimeModelId: string,
  entryPath: string,
  onProgress?: (progress: number) => void,
  perfSessionId?: number,
  options: {
    transferInput?: boolean;
    openingPolicy?: IfcOpeningPolicy;
    /** Digest of this exact IFC buffer when already computed for its cache key. */
    sourceSha256?: string;
    onConversionStage?: (stage: string) => void;
    onFarArtifact?: (bytes: Uint8Array<ArrayBuffer>, index: RegionalIndex) => void;
    onRegionalBatch?: (batch: IfcRegionalConnectionBatch) => void;
    onRegionalComplete?: (meta: { objectCount: number; sequence: number }) => void;
  } = {},
) {
  const isCurrent = () => state.isCurrentSession(session);
  if (!isCurrent()) return;
  const geometry = await reserveIfcGeometryWork();
  try {
    if (!isCurrent()) return;
    const diagnosticSession = perfSessionId === undefined ? undefined : { id: perfSessionId };
    let endConversion: ReturnType<typeof perfBegin> | undefined;
    let failed = false;
    let removedOpeningRelations = 0;
    let coldPipeline: Record<string, number> | undefined;
    let converted: Uint8Array<ArrayBuffer> | undefined;
    try {
      converted = await new Promise<Uint8Array<ArrayBuffer> | undefined>((resolve, reject) => {
        let worker: Worker;
        try {
          worker = createMeasuredWorker(
            'ifc-conversion',
            (identity) =>
              new Worker(measurementWorkerUrl(measuredWorkerAsset, identity), {
                type: 'module',
                ...(identity ? { name: identity } : {}),
              }),
            entryPath,
          );
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        let finished = false;
        let watchdog: ReturnType<typeof setInterval> | null = null;
        const finish = (error?: Error, bytes?: Uint8Array<ArrayBuffer>) => {
          if (finished) return;
          finished = true;
          activeConversions.delete(cancel);
          if (watchdog) {
            clearInterval(watchdog);
            watchdog = null;
          }
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
          worker.terminate();
          if (error) reject(error);
          else resolve(bytes);
        };
        const fail = (error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error)));
        const cancel = () =>
          finish(new DOMException('IFC conversion belongs to an obsolete project', 'AbortError'));
        activeConversions.add(cancel);
        // web-ifc 对个别文件可能长时间停在某个进度（实测 76% 超过 10 分钟）。
        // 以“无进度”而非总时长判定停滞：持续有进度的大文件仍允许后台长转换。
        let lastProgressAt = 0;
        worker.onmessage = (event: MessageEvent<IfcConversionOutput>) => {
          if (finished) return;
          if (!isCurrent()) {
            cancel();
            return;
          }
          try {
            const response = event.data;
            if (response.type === 'stage') {
              lastProgressAt = performance.now();
              options.onConversionStage?.(response.stage);
              perfRecordExternalSpan(
                `IFC ${response.stage} · ${entryPath}`,
                response.elapsedMs,
                { entryPath, phase: response.stage, ...response.meta },
                perfSessionId,
              );
              return;
            }
            if (response.type === 'progress') {
              lastProgressAt = performance.now();
              onProgress?.(response.progress);
              return;
            }
            if (response.type === 'regional-batch') {
              lastProgressAt = performance.now();
              options.onRegionalBatch?.({
                sequence: response.sequence,
                objects: response.objects,
                chunks: response.chunks,
                bytes: response.bytes,
                final: response.final,
              });
              // Acknowledge after the bounded scene operation has yielded a turn.
              setTimeout(() => {
                if (finished || !isCurrent()) return;
                try {
                  worker.postMessage({ type: 'connection-consumed', sequence: response.sequence });
                } catch (error) {
                  finish(error instanceof Error ? error : Error(String(error)));
                }
              }, 0);
              return;
            }
            if (response.type === 'regional-complete') {
              lastProgressAt = performance.now();
              options.onRegionalComplete?.({
                objectCount: response.objectCount,
                sequence: response.sequence,
              });
              return;
            }
            if (response.type === 'error') {
              const error = new Error(response.message);
              error.stack = response.stack ?? error.stack;
              finish(error);
            } else {
              removedOpeningRelations = response.removedOpeningRelations ?? 0;
              coldPipeline = response.coldPipeline;
              if (response.regionalIndex)
                options.onFarArtifact?.(response.bytes, response.regionalIndex);
              finish(undefined, response.bytes);
            }
          } catch (error) {
            // Consumer callbacks are part of this task. A failed progress,
            // preview or artifact consumer must release its Worker and gate
            // immediately rather than leaving the next IFC behind a watchdog.
            fail(error);
          }
        };
        worker.onerror = (event) =>
          finish(new Error(event.message || 'IFC conversion worker failed'));
        worker.onmessageerror = () =>
          finish(new Error('IFC conversion worker returned unreadable data'));
        const send = (buffer: Uint8Array | null): void => {
          if (finished) return;
          if (!isCurrent()) {
            cancel();
            return;
          }
          if (!buffer) {
            finish();
            return;
          }
          geometry.start();
          // Keep native read time separate from the worker conversion span.
          endConversion = perfBegin(
            `变电 IFC worker conversion · ${entryPath}`,
            { entryPath, phase: 'ifc.worker conversion', source: 'ifc' },
            diagnosticSession,
          );
          const endPrepare = perfBegin(
            `变电 IFC worker input preparation · ${entryPath}`,
            { entryPath, phase: 'ifc.worker input preparation', bytes: buffer.byteLength },
            diagnosticSession,
          );
          // A caller can transfer its one-shot source buffer to the conversion
          // Worker. The caller must re-read the IFC after a failed
          // attempt because a transferred ArrayBuffer is detached.
          const exactBuffer =
            buffer.buffer instanceof ArrayBuffer &&
            buffer.byteOffset === 0 &&
            buffer.byteLength === buffer.buffer.byteLength;
          const owned = (
            options.transferInput && exactBuffer ? buffer : new Uint8Array(buffer)
          ) as Uint8Array<ArrayBuffer>;
          const input: IfcConversionInput = {
            bytes: owned,
            wasm: { ...ctx.ifcLoader.settings.wasm },
            webIfcSettings: { ...ctx.ifcLoader.settings.webIfc },
            openingPolicy: options.openingPolicy ?? 'full',
            sourceSha256: options.sourceSha256,
          };
          input.earlyConnections =
            state.substationMemoryPressure !== 'high' &&
            state.substationMemoryPressure !== 'critical';
          try {
            input.earlyConnections &&= localStorage.getItem('gim-connection-early') !== '0';
          } catch {
            /* defaults apply */
          }
          endPrepare(undefined, {
            entryPath,
            phase: 'ifc.worker input preparation',
            sourceBytes: buffer.byteLength,
            workerBytes: owned.byteLength,
            transferredInput: options.transferInput === true && exactBuffer,
          });
          lastProgressAt = performance.now();
          watchdog = setInterval(() => {
            if (performance.now() - lastProgressAt < 180000) return;
            finish(new Error('IFC 转换超过 180 秒无进度，已中止；可重试或在设置中跳过超大文件'));
          }, 15000);
          worker.postMessage(input, [owned.buffer]);
        };
        try {
          if (typeof source === 'function') void source().then(send).catch(fail);
          else send(source);
        } catch (error) {
          fail(error);
        }
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      endConversion?.(undefined, {
        entryPath,
        phase: 'ifc.worker conversion',
        failed,
        openingPolicy: options.openingPolicy ?? 'full',
        removedOpeningRelations,
      });
    }
    if (!converted || !isCurrent()) return;
    // Same coordinate flag, runtime identity and lifecycle events as OBC load().
    ctx.fragments.core.settings.autoCoordinate = true;
    const endLoad = perfBegin(
      `变电 IFC fragments core.load · ${entryPath}`,
      { entryPath, phase: 'fragments.core.load', source: 'ifc', bytes: converted.byteLength },
      diagnosticSession,
    );
    let loadFailed = false;
    try {
      const model = await ctx.fragments.core.load(converted.buffer, { modelId: runtimeModelId });
      model.object.userData.ifcOpeningPolicy = options.openingPolicy ?? 'full';
      model.object.userData.removedOpeningRelations = removedOpeningRelations;
      model.object.userData.ifcColdPipeline = coldPipeline;
      return model;
    } catch (error) {
      loadFailed = true;
      throw error;
    } finally {
      endLoad(undefined, {
        entryPath,
        phase: 'fragments.core.load',
        source: 'ifc',
        failed: loadFailed,
      });
    }
  } finally {
    geometry.release();
  }
}
