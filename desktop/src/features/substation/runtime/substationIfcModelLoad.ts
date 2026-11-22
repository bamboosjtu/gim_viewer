import type { AppState } from '../../../app/state.js';
import type { SessionScope } from '../../../shared/sessionScope.js';
import type { Object3D } from 'three';
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
import { getIfcBufferForEntry } from '../../../services/ifcGeometrySource.js';

type EntryOptions = NonNullable<Parameters<typeof loadIfcEntry>[5]>;

interface SubstationIfcModelRequest {
  state: AppState;
  entry: IfcEntry;
  ctx: ViewerContext;
  scope: SessionScope;
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
}

export interface SubstationIfcUsableModel {
  source: IfcLoadSource | 'unknown';
  object: Object3D;
}

/** Hand back the registered authoritative object to the queue for presentation. */
export async function loadSubstationIfcModel(
  request: SubstationIfcModelRequest,
): Promise<SubstationIfcUsableModel | undefined> {
  const { state, entry, ctx, scope, perfSession, progress } = request;
  const { session, isCurrent } = scope;
  if (!isCurrent()) return;
  const status = progress.begin(entry, request.index, request.queueSize, request.sourceSize);
  const stopProgress = scope.own(status.dispose);
  let loading = true;
  const acceptsModelCallback = () => loading && isCurrent();
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
      if (!isCurrent()) return null;
      const bytes = await getIfcBufferForEntry(entry, state, session);
      if (!isCurrent()) return null;
      // Regional runtime may reuse this reader after the base load has settled.
      if (!loading) return bytes;
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
            if (!acceptsModelCallback()) return;
            const percentage = `${Math.round(amount * 100)}%`;
            status.publish(percentage);
            if (!request.isInteractive()) showLoading(`${entry.name}: ${percentage}`);
          },
          {
            session,
            signal: scope.signal,
            perfSessionId: perfSession.id,
            openingPolicy: 'bim-lod',
            transferInput: true,
            onLoadSource: (source) => {
              if (!acceptsModelCallback()) return;
              loadSource.value = source;
              status.recordSource(source);
            },
            onStage: (stage, meta) => {
              if (loading || stage === 'cache-written' || stage === 'cache-write-failed')
                status.stage(stage, meta);
            },
            onProfile: (profile) => {
              if (isCurrent()) perfRecordIfcLoadProfile(profile, perfSession);
            },
            onRegionalBatch: (batch) => {
              if (acceptsModelCallback()) request.onRegionalBatch(batch);
            },
            onRegionalComplete: (meta) => {
              if (acceptsModelCallback()) request.onRegionalComplete(meta);
            },
          },
        )
        .catch((error: unknown) => {
          readEnded = false;
          throw error;
        });
      loading = false;
      if (!isCurrent()) return;

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
      const runtimeModelId = state.ifc.loadedModels.get(entry.modelId)?.runtimeModelId;
      const object =
        runtimeModelId && state.ifc.isCurrentRuntimeModel(runtimeModelId)
          ? ctx.fragments.list.get(runtimeModelId)?.object
          : undefined;
      if (object) {
        request.onModelReady();
        return { source: loadSource.value, object };
      }
    } catch (error) {
      loading = false;
      const message = error instanceof Error ? error.message : String(error);
      if (!readEnded) endRead('（失败）', { source: loadSource.value, error: message });
      if (!loadEnded)
        endLoad('（失败）', {
          source: loadSource.value,
          cacheHit: loadSource.value === 'lod-cache',
          error: message,
        });
      if (!isCurrent()) return;

      logger.error('[GIM] IFC 加载失败:', entry, error);
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
    loading = false;
    stopProgress();
  }
}
