import type { AppState, ProjectLoadSession } from '../app/state.js';
import type { ExtractedGimSource } from './gimOpenCore.js';
import { invokeTimed } from '@desktop/invokeTimed.js';
import { decodeSubstationParseCopy, type ParseCopyReceipt } from '@desktop/substationParseCopy.js';
import { perfCurrentSession, perfMark } from '../utils/perfTimings.js';

export const EARLY_SEMANTIC_KEY = 'gim-debug-substation-early-semantic';
export interface EarlySemanticEligibility {
  eligible: boolean; reason: string; archiveFormat: string; folderCount: number;
  coreEntryCount: number; coreBytes: number; streamCoreEntries: number; emptyCoreEntries: number;
  coreOnlyFolders: number[]; semanticPhysicalOrder: number; checkpointDecodedBytes: number; totalDecodedBytes: number;
}
export async function inspectEarlySemanticEligibility(filePath: string, projectId: number, sourceSha256: string): Promise<EarlySemanticEligibility> {
  return invokeTimed('inspect_substation_early_eligibility', { filePath, projectId, sourceSha256 });
}
/** No catch here: safety/identity/decode errors must not select another decoder. */
export async function withEarlySemanticCapability<T>(capability: EarlySemanticEligibility, early: () => Promise<T>, fullNative: () => Promise<T>): Promise<T> {
  if (capability.eligible) return early();
  if (!['not-gs-7z','no-core-inputs','no-early-checkpoint-benefit'].includes(capability.reason)) {
    throw Error(`Unrecognized early capability result: ${capability.reason}`);
  }
  return fullNative();
}
interface JobStatus {
  jobId: string; projectId: number; sourceSha256: string; status: string; entries: [string, number][];
  semanticCopy: ParseCopyReceipt | null; semanticReadyAtMs: number | null;
  materializationCompleteAtMs: number | null; cacheRoot: string | null; error: string | null;
  trace: import('@desktop/gimExtract.js').NativeExtractionEntryTiming[];
  profile: import('@desktop/gimExtract.js').NativeExtractionProfile | null;
}
interface ActiveJob { id: string; current: () => boolean; complete: boolean; error?: string }
const jobs = new WeakMap<AppState, ActiveJob>();
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 200));
export function isSubstationSourceMaterializing(state: AppState): boolean {
  const job = jobs.get(state); return !!job && job.current() && !job.complete;
}
export function substationSourcePreparationMessage(state: AppState): string {
  return jobs.get(state)?.error
    ? '源几何准备失败。已读取的属性和来源信息仍可查看。'
    : '源几何仍在后台准备。当前对象的属性和来源信息可以查看。';
}
export function cancelSubstationExtraction(state: AppState): void {
  const job = jobs.get(state); jobs.delete(state);
  if (job) void invokeTimed('cancel_substation_extraction', { jobId: job.id }).catch(() => {});
}

/** All parser bytes come from the exact decoded entry, not a second semantic model. */
export async function startSubstationExtractionJob(
  state: AppState, session: ProjectLoadSession, filePath: string, projectId: number,
): Promise<ExtractedGimSource> {
  const perfSession = perfCurrentSession(), current = () => state.isCurrentSession(session);
  const start = await invokeTimed<JobStatus>('start_substation_extraction', {
    filePath, projectId, sourceSha256: session.sourceSha256,
  });
  if (!current()) {
    await invokeTimed('cancel_substation_extraction', { jobId: start.jobId });
    throw Error('extraction session cancelled');
  }
  const active: ActiveJob = { id: start.jobId, current, complete: false }; jobs.set(state, active);
  let latest = start;
  let resolveSemantic!: (value: JobStatus) => void, rejectSemantic!: (reason: unknown) => void;
  const semantic = new Promise<JobStatus>((resolve, reject) => { resolveSemantic = resolve; rejectSemantic = reject; });
  const cachePaths = new Map<string, string>();
  const files = new Map<string, File>();
  const completion = (async () => {
    try {
      while (current()) {
        latest = await invokeTimed<JobStatus>('substation_extraction_status', { jobId: start.jobId });
        if (!current()) break;
        if (latest.sourceSha256 !== session.sourceSha256 || latest.projectId !== projectId) throw Error('extraction identity mismatch');
        if (latest.status === 'failed' || latest.status === 'cancelled') throw Error(latest.error || 'source extraction failed');
        if (latest.semanticCopy || latest.status === 'complete') resolveSemantic(latest);
        if (latest.status === 'complete') {
          if (!latest.cacheRoot) throw Error('materialized source root missing');
          for (const [path] of start.entries) cachePaths.set(path, `${latest.cacheRoot}/${path}`);
          active.complete = true;
          const details = await invokeTimed<JobStatus>('substation_extraction_status', { jobId: start.jobId, details: true });
          if (!current()) break;
          perfMark('sourceMaterializationComplete', { jobId: start.jobId, nativeAtMs: latest.materializationCompleteAtMs,
            files: start.entries.length, extraction: details.profile, entryTrace: details.trace }, perfSession);
          // Materialized PHM/MOD sources now use the existing bounded batch path;
          // avoid a new per-file IPC tail when the unchanged index builder reads them.
          for (const file of files.values()) {
            if ('__gimExtractionJobFile' in file) Object.assign(file, { __gimDiskBacked: true });
          }
          const endHydration = (await import('../utils/perfTimings.js')).perfBegin('source completion · reference hydration', undefined, perfSession);
          const hydrated = await (await import('./nativeSmallFileHydration.js')).hydrateNativeSmallFiles(files, projectId, { isCurrent: current });
          if (hydrated.cancelled || !current()) throw Error('extraction session cancelled');
          for (const [path, file] of hydrated.files) files.set(path, file);
          endHydration(undefined, { requested: hydrated.requested, hydrated: hydrated.hydrated, bytes: hydrated.bytes, batches: hydrated.batches });
          return;
        }
        await pause();
      }
      throw Error('extraction session cancelled');
    } catch (error) {
      active.error = String(error);
      if (current()) perfMark('sourceMaterializationFailed', { jobId: start.jobId, error: active.error }, perfSession);
      rejectSemantic(error); throw error;
    }
  })();
  // Reads and resource completion may outlive the UI selection; session still fences publication.
  void completion.catch(() => {});
  const read = async (path: string): Promise<ArrayBuffer> => {
    while (current()) {
      try { const bytes = await invokeTimed<ArrayBuffer>('read_substation_extraction_source', { jobId: start.jobId, entryPath: path }); if (!current()) throw Error('extraction session cancelled'); return bytes; }
      catch (error) {
        if (!String(error).includes('source materializing')) throw error;
        await pause();
      }
    }
    throw Error('extraction session cancelled');
  };
  for (const [path, size] of start.entries) {
    files.set(path, { __gimExtractionJobFile: true, name: path.split('/').pop()!, size, type: 'application/octet-stream', lastModified: 0,
      arrayBuffer: () => read(path), text: async () => new TextDecoder().decode(await read(path)),
    } as unknown as File);
  }
  const ready = await semantic;
  const bytes = ready.semanticCopy
    ? await decodeSubstationParseCopy(await invokeTimed<ArrayBuffer>('read_substation_extraction_source', { jobId: start.jobId }), ready.semanticCopy, files)
    : new Map<string, Uint8Array>();
  if (!current()) throw Error('extraction session cancelled');
  for (const [path, data] of bytes) files.set(path, new File([data.slice().buffer], path.split('/').pop()!));
  if (ready.semanticCopy) {
    perfMark('earlySemanticReady', { jobId: start.jobId, nativeAtMs: ready.semanticReadyAtMs,
      inputs: bytes.size, bytes: [...bytes.values()].reduce((n, b) => n + b.byteLength, 0) }, perfSession);
  } else { await completion; } // Optional-copy failure: one decode, then original batch hydration.
  return { magic: 'GIMPKGS', files, cachePaths, sourceMaterialization: completion,
    earlySemantic: ready.semanticCopy != null, cacheProjectId: ready.semanticCopy ? undefined : projectId };
}
