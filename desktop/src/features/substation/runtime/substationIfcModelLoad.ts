import type { AppState, ProjectLoadSession } from '../../../app/state.js';
import type { IfcEntry } from '../../../gim/types.js';
import { showLoading } from '../../../services/gimOpenCore.js';
import { projectPresentation } from '../../../services/projectPresentationPort.js';
import { reportBackgroundError } from '../../../utils/backgroundErrors.js';
import { logger } from '../../../utils/logger.js';
import {
  perfBegin,
  perfMarkProductMoment,
  perfRecordIfcLoadProfile,
  type PerfSession,
} from '../../../utils/perfTimings.js';
import type { loadIfcEntry, IfcLoadSource } from '../../../viewer/ifcEntryLoader.js';
import type { ViewerContext } from '../../../viewer/viewerEngine.js';
import type { SubstationIfcLoadProgress } from './substationIfcLoadProgress.js';
import { getIfcBufferForEntry } from './substationIfcSource.js';
import { setSubstationViewerInteractive } from './substationLoadingState.js';

type EntryOptions = NonNullable<Parameters<typeof loadIfcEntry>[5]>;

interface SubstationIfcModelRequest {
  state: AppState;
  entry: IfcEntry;
  ctx: ViewerContext;
  session: ProjectLoadSession;
  perfSession: PerfSession;
  loadEntry: typeof loadIfcEntry;
  progress: SubstationIfcLoadProgress;
  index: number;
  queueSize: number;
  sourceSize: number;
  isInteractive(): boolean;
  onRegionalBatch: NonNullable<EntryOptions['onRegionalBatch']>;
  onRegionalComplete: NonNullable<EntryOptions['onRegionalComplete']>;
  onModelReady(): void;
  onModelFailed(): void;
  onUsableModel(source: IfcLoadSource | 'unknown'): Promise<void>;
}

/** Own the source read, loader callbacks, terminal profiling and cleanup for one IFC entry. */
export async function loadSubstationIfcModel(request: SubstationIfcModelRequest): Promise<void> {
  const { state, entry, ctx, session, perfSession, progress } = request;
  const scope = state.sessionScope(session);
  const isCurrent = scope.isCurrent;
  if (!isCurrent()) return;
  const status = progress.begin(entry, request.index, request.queueSize, request.sourceSize);
  const stopProgress = scope.own(status.dispose);
  try {
    // Keep the center loader off once the viewport has its first usable model.
    if (!request.isInteractive()) showLoading(`正在加载 ${entry.name}...`);

    let readEnded = false;
    let readProfiled = false;
    let readByteLength = 0;
    let loadEnded = false;
    const loadSource: { value: IfcLoadSource | 'unknown' } = { value: 'unknown' };
    const endRead = perfBegin(`变电 IFC read · ${entry.path}`, undefined, perfSession);
    const endLoad = perfBegin(
      `变电 web-ifc / Fragments load · ${entry.path}`,
      undefined,
      perfSession,
    );

    const readBytes = async (): Promise<Uint8Array | null> => {
      const bytes = await getIfcBufferForEntry(entry, state, session);
      if (!isCurrent()) return null;
      readByteLength = bytes?.byteLength ?? 0;
      if (!readProfiled) {
        endRead(undefined, {
          bytes: readByteLength,
          source: state.currentFiles ? 'extracted' : 'disk-cache',
          found: bytes != null,
        });
        readProfiled = true;
      }
      readEnded = true;
      return bytes;
    };

    try {
      if (request.index === 0)
        perfMarkProductMoment(
          'firstIfcLoadStart',
          { name: entry.name, path: entry.path },
          perfSession,
        );
      await request
        .loadEntry(
          ctx,
          state,
          entry,
          readBytes,
          (amount) => {
            if (!progress.acceptsProgress()) return;
            const percentage = `${Math.round(amount * 100)}%`;
            status.publish(percentage);
            if (!request.isInteractive()) showLoading(`${entry.name}: ${percentage}`);
          },
          {
            session,
            perfSessionId: perfSession.id,
            openingPolicy: 'bim-lod',
            transferInput: true,
            onLoadSource: (source) => {
              if (!progress.acceptsProgress()) return;
              setSubstationViewerInteractive(true);
              loadSource.value = source;
              status.recordSource(source);
            },
            onStage: (stage, meta) => status.stage(stage, meta),
            onProfile: (profile) => {
              if (isCurrent()) perfRecordIfcLoadProfile(profile, perfSession);
            },
            onRegionalBatch: request.onRegionalBatch,
            onRegionalComplete: request.onRegionalComplete,
          },
        )
        .catch((error: unknown) => {
          readEnded = false;
          throw error;
        });
      if (!isCurrent()) return;

      request.onModelReady();
      if (!readEnded) {
        // A far-LOD cache hit never calls the source reader.
        if (!readProfiled) endRead(undefined, { bytes: 0, source: 'not-read', found: false });
        readEnded = true;
      }
      endLoad(undefined, {
        bytes: readByteLength,
        source: loadSource.value,
        cacheHit: loadSource.value === 'lod-cache',
      });
      loadEnded = true;
      status.loaded(loadSource.value);
      const runtimeModelId = state.ifc.runtimeModelIds.get(entry.modelId) ?? entry.modelId;
      if (state.ifc.loadedModels.has(entry.modelId) && ctx.fragments.list.has(runtimeModelId))
        await request.onUsableModel(loadSource.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!readEnded) endRead('（失败）', { source: loadSource.value, error: message });
      if (!loadEnded)
        endLoad('（失败）', {
          source: loadSource.value,
          cacheHit: loadSource.value === 'lod-cache',
          error: message,
        });
      logger.error('[GIM] IFC 加载失败:', entry, error);
      if (!isCurrent()) return;

      request.onModelFailed();
      status.failed(message);
      try {
        const { modelId } = entry;
        const runtimeModelId = state.ifc.runtimeModelIds.get(modelId) ?? modelId;
        if (ctx.fragments.list.has(runtimeModelId))
          void Promise.resolve(ctx.fragments.core.disposeModel(runtimeModelId)).catch(
            reportBackgroundError,
          );
        state.ifc.loadedModels.delete(modelId);
        projectPresentation().removeModelRows([modelId, runtimeModelId]);
      } catch (cleanupError) {
        logger.warn('[GIM] cleanup failed model after load error', entry, cleanupError);
      }
    }
  } finally {
    stopProgress();
  }
}
