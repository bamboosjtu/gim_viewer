import { DESKTOP_COMMANDS } from '@desktop/contracts.js';
import type { EarlySemanticEligibility, JobSnapshot as JobStatus } from '@desktop/contracts.js';
export type { EarlySemanticEligibility } from '@desktop/contracts.js';
import { GimError, nativeError, hasErrorCode } from '@desktop/contracts.js';
import type { AppState, ProjectLoadSession } from '../../../app/state.js';
import type { ExtractedGimSource } from '../../../services/gimOpenCore.js';
import { invokeTimed } from '../../../infrastructure/native/invokeTimed.js';
import { decodeSubstationParseCopy } from '@desktop/substationParseCopy.js';
import { perfCurrentSession, perfMark } from '../../../utils/perfTimings.js';
import {
  setProjectSourcePreparation,
  type ProjectSourcePreparation,
} from '../../../services/projectSourcePreparation.js';

export async function inspectEarlySemanticEligibility(
  filePath: string,
  projectId: number,
  sourceSha256: string,
): Promise<EarlySemanticEligibility> {
  return invokeTimed(DESKTOP_COMMANDS.inspect_substation_early_eligibility, {
    filePath,
    projectId,
    sourceSha256,
  });
}
/** No catch here: safety/identity/decode errors must not select another decoder. */
export async function withEarlySemanticCapability<T>(
  capability: EarlySemanticEligibility,
  early: () => Promise<T>,
  fullNative: () => Promise<T>,
): Promise<T> {
  if (capability.eligible) return early();
  if (!['not-gs-7z', 'no-core-inputs', 'no-early-checkpoint-benefit'].includes(capability.reason)) {
    throw Error(`Unrecognized early capability result: ${capability.reason}`);
  }
  return fullNative();
}

interface ActiveJob extends ProjectSourcePreparation {
  id: string;
}
const jobs = new WeakMap<AppState, ActiveJob>();
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
export function cancelSubstationExtraction(state: AppState): void {
  const job = jobs.get(state);
  jobs.delete(state);
  setProjectSourcePreparation(state);
  if (job)
    void invokeTimed(DESKTOP_COMMANDS.cancel_substation_extraction, { jobId: job.id }).catch(
      () => {},
    );
}

/** All parser bytes come from the exact decoded entry, not a second semantic model. */
export async function startSubstationExtractionJob(
  state: AppState,
  session: ProjectLoadSession,
  filePath: string,
  projectId: number,
): Promise<ExtractedGimSource> {
  const perfSession = perfCurrentSession(),
    current = () => state.isCurrentSession(session);
  const start = await invokeTimed<JobStatus>(DESKTOP_COMMANDS.start_substation_extraction, {
    filePath,
    projectId,
    sourceSha256: session.sourceSha256,
  });
  if (!current()) {
    await invokeTimed(DESKTOP_COMMANDS.cancel_substation_extraction, { jobId: start.jobId });
    throw new GimError('CANCELLED', 'extraction session cancelled');
  }
  const active: ActiveJob = { id: start.jobId, current, complete: false };
  jobs.set(state, active);
  setProjectSourcePreparation(state, active);
  let latest = start;
  let resolveSemantic!: (value: JobStatus) => void, rejectSemantic!: (reason: unknown) => void;
  const semantic = new Promise<JobStatus>((resolve, reject) => {
    resolveSemantic = resolve;
    rejectSemantic = reject;
  });
  const cachePaths = new Map<string, string>();
  const files = new Map<string, File>();
  const completion = (async () => {
    try {
      while (current()) {
        latest = await invokeTimed<JobStatus>(DESKTOP_COMMANDS.substation_extraction_status, {
          jobId: start.jobId,
        });
        if (!current()) break;
        if (latest.sourceSha256 !== session.sourceSha256 || latest.projectId !== projectId)
          throw new GimError('SOURCE_CHANGED', 'extraction identity mismatch');
        if (latest.status === 'failed' || latest.status === 'cancelled')
          throw latest.error
            ? nativeError(latest.error)
            : new GimError(
                latest.status === 'cancelled' ? 'CANCELLED' : 'OPERATION_FAILED',
                'source extraction failed',
              );
        if (latest.semanticCopy || latest.status === 'complete') resolveSemantic(latest);
        if (latest.status === 'complete') {
          if (!latest.cacheRoot) throw Error('materialized source root missing');
          for (const [path] of start.entries) cachePaths.set(path, `${latest.cacheRoot}/${path}`);
          active.complete = true;
          const details = await invokeTimed<JobStatus>(
            DESKTOP_COMMANDS.substation_extraction_status,
            { jobId: start.jobId, details: true },
          );
          if (!current()) break;
          perfMark(
            'sourceMaterializationComplete',
            {
              jobId: start.jobId,
              nativeAtMs: latest.materializationCompleteAtMs,
              files: start.entries.length,
              extraction: details.profile,
              entryTrace: details.trace,
            },
            perfSession,
          );
          // Materialized PHM/MOD sources now use the existing bounded batch path;
          // avoid a new per-file IPC tail when the unchanged index builder reads them.
          for (const file of files.values()) {
            if ('__gimExtractionJobFile' in file) Object.assign(file, { __gimDiskBacked: true });
          }
          const endHydration = (await import('../../../utils/perfTimings.js')).perfBegin(
            'source completion · reference hydration',
            undefined,
            perfSession,
          );
          const hydrated = await (
            await import('../../../services/nativeSmallFileHydration.js')
          ).hydrateNativeSmallFiles(files, projectId, { isCurrent: current });
          if (hydrated.cancelled || !current())
            throw new GimError('CANCELLED', 'extraction session cancelled');
          for (const [path, file] of hydrated.files) files.set(path, file);
          endHydration(undefined, {
            requested: hydrated.requested,
            hydrated: hydrated.hydrated,
            bytes: hydrated.bytes,
            batches: hydrated.batches,
          });
          return;
        }
        await pause();
      }
      throw new GimError('CANCELLED', 'extraction session cancelled');
    } catch (error) {
      active.error = String(error);
      if (current())
        perfMark(
          'sourceMaterializationFailed',
          { jobId: start.jobId, error: active.error },
          perfSession,
        );
      rejectSemantic(error);
      throw error;
    }
  })();
  // Reads and resource completion may outlive the UI selection; session still fences publication.
  void completion.catch(() => {});
  const read = async (path: string): Promise<ArrayBuffer> => {
    while (current()) {
      try {
        const bytes = await invokeTimed<ArrayBuffer>(
          DESKTOP_COMMANDS.read_substation_extraction_source,
          { jobId: start.jobId, entryPath: path },
        );
        if (!current()) throw new GimError('CANCELLED', 'extraction session cancelled');
        return bytes;
      } catch (error) {
        if (!hasErrorCode(error, 'SOURCE_MATERIALIZING')) throw error;
        await pause();
      }
    }
    throw new GimError('CANCELLED', 'extraction session cancelled');
  };
  for (const [path, size] of start.entries) {
    files.set(path, {
      __gimExtractionJobFile: true,
      name: path.split('/').pop()!,
      size,
      type: 'application/octet-stream',
      lastModified: 0,
      arrayBuffer: () => read(path),
      text: async () => new TextDecoder().decode(await read(path)),
    } as unknown as File);
  }
  const ready = await semantic;
  const bytes = ready.semanticCopy
    ? await decodeSubstationParseCopy(
        await invokeTimed<ArrayBuffer>(DESKTOP_COMMANDS.read_substation_extraction_source, {
          jobId: start.jobId,
        }),
        ready.semanticCopy,
        files,
      )
    : new Map<string, Uint8Array>();
  if (!current()) throw new GimError('CANCELLED', 'extraction session cancelled');
  for (const [path, data] of bytes)
    files.set(path, new File([data.slice().buffer], path.split('/').pop()!));
  if (ready.semanticCopy) {
    perfMark(
      'earlySemanticReady',
      {
        jobId: start.jobId,
        nativeAtMs: ready.semanticReadyAtMs,
        inputs: bytes.size,
        bytes: [...bytes.values()].reduce((n, b) => n + b.byteLength, 0),
      },
      perfSession,
    );
  } else {
    await completion;
  } // Optional-copy failure: one decode, then original batch hydration.
  return {
    magic: 'GIMPKGS',
    files,
    cachePaths,
    sourceMaterialization: completion,
    earlySemantic: ready.semanticCopy != null,
    cacheProjectId: ready.semanticCopy ? undefined : projectId,
  };
}
