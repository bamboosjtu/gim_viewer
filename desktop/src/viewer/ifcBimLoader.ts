import { reportBackgroundError } from '../utils/backgroundErrors.js';
import { logger } from '../utils/logger.js';
import type { ViewerContext } from './viewerEngine.js';
import type { ViewerState as AppState } from '../shared/viewerState.js';
import type { ProjectLoadSession } from '../shared/projectSession.js';
import { loadRawIfc } from './ifcConversion.js';
import { IFC_LOD_CACHE_VERSION } from '../config/features.js';
import {
  readIfcLodArtifact,
  writeIfcLodArtifact,
  deleteIfcLodArtifact,
} from '@desktop/ifcLodCache.js';
import { IfcRegionalRuntime } from './ifcRegionalRuntime.js';
import type { RegionalIndex } from './ifcRegionalData.js';
import type { IfcRegionalConnectionBatch } from './ifcConversion.js';
import { removeModHighlightGroup } from './highlight.js';
import { syncIfcRepresentationHighlight } from './ifcRepresentationHighlight.js';
import { readIfcCoordinateAnchor } from './ifcCoordinateAnchor.js';
interface FarArtifact {
  bytes: ArrayBuffer;
  index: RegionalIndex;
}
export type IfcLoadStage =
  | 'checking-cache'
  | 'lod-cache-hit'
  | 'cold-convert'
  | 'far-ready'
  | 'cache-write-start'
  | 'cache-written'
  | 'cache-write-failed';
export interface IfcFileProfile {
  path: string;
  bytes: number;
  source: 'lod-cache' | 'ifc';
  cacheHit: boolean;
  cacheReadMs: number;
  loadMs: number;
  cacheWriteMs: number | null;
  cacheWriteOk: boolean | null;
}

interface BimIfcLoadOptions {
  standaloneSource?: boolean;
  signal?: AbortSignal;
  onStage?: (stage: IfcLoadStage, meta?: Record<string, unknown>) => void;
  onProfile?: (profile: IfcFileProfile) => void;
  onRegionalBatch?: (batch: IfcRegionalConnectionBatch) => void;
  onRegionalComplete?: (meta: { objectCount: number; sequence: number }) => void;
}

function scheduleFarArtifactWrite(
  key: string,
  cached: FarArtifact,
  path: string,
  timing: { startedAt: number; cacheReadMs: number; writeStarted: number },
  current: () => boolean,
  options: BimIfcLoadOptions,
): void {
  const { startedAt, cacheReadMs, writeStarted } = timing;
  let cacheWriteMs: number | null = null;
  let cacheWriteOk: boolean | null = null;
  // An admitted, source-keyed write may finish after the session changes.
  // Only the originating session receives its status and profile.
  void Promise.resolve(writeIfcLodArtifact(key, cached))
    .then((result) => {
      if (!current()) return;
      const ok = (result as { ok?: boolean } | undefined)?.ok !== false;
      cacheWriteOk = ok;
      cacheWriteMs = performance.now() - writeStarted;
      options.onStage?.(ok ? 'cache-written' : 'cache-write-failed', {
        path,
        ms: Math.round(cacheWriteMs),
        ...(ok
          ? {}
          : { error: (result as { error?: string } | undefined)?.error ?? 'cache write failed' }),
      });
    })
    .catch((error) => {
      if (!current()) return;
      cacheWriteOk = false;
      cacheWriteMs = performance.now() - writeStarted;
      options.onStage?.('cache-write-failed', {
        path,
        error: String(error),
        ms: Math.round(cacheWriteMs),
      });
    })
    .finally(() => {
      if (!current()) return;
      options.onProfile?.({
        path,
        bytes: cached.bytes.byteLength,
        source: 'ifc',
        cacheHit: false,
        cacheReadMs: Math.round(cacheReadMs),
        loadMs: Math.round(performance.now() - startedAt),
        cacheWriteMs: cacheWriteMs == null ? null : Math.round(cacheWriteMs),
        cacheWriteOk,
      });
    })
    .catch(reportBackgroundError);
}

async function waitForCoordinateBase(ctx: ViewerContext, current: () => boolean) {
  let baseModel = ctx.fragments.list.get(ctx.fragments.baseCoordinationModel);
  for (let frame = 0; !baseModel && frame < 60 && current(); frame++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    baseModel = ctx.fragments.list.get(ctx.fragments.baseCoordinationModel);
  }
  return baseModel;
}

export async function loadBimIfc(
  ctx: ViewerContext,
  state: AppState,
  session: ProjectLoadSession,
  runtimeId: string,
  logicalId: string,
  path: string,
  readBytes: () => Promise<Uint8Array | null>,
  onProgress?: (p: number) => void,
  options: BimIfcLoadOptions = {},
) {
  const current = () => !options.signal?.aborted && state.isCurrentSession(session);
  if (!current()) return;
  const discardModel = async (): Promise<void> => {
    try {
      await ctx.fragments.core.disposeModel(runtimeId);
    } catch {
      /* Already disposed by session cleanup. */
    }
  };
  const startedAt = performance.now();
  let cacheReadMs = 0;
  options.onStage?.('checking-cache', { path });
  if (!current()) return;
  let input: Uint8Array | null = null;
  let sourceSha256: string | undefined;
  let identity = options.standaloneSource ? null : session.sourceSha256;
  if (!identity) {
    input = await readBytes();
    if (!input || !current()) return;
    // The reread provider is checked separately by the regional Worker. Only
    // carry this digest forward with the same privately owned initial bytes.
    const bytes =
      input.buffer instanceof ArrayBuffer
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : (input = new Uint8Array(input));
    sourceSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
    identity = sourceSha256;
    if (!current()) return;
  }
  const key = `${IFC_LOD_CACHE_VERSION}|${identity}|${path.toLowerCase()}`;
  const cacheStarted = performance.now();
  let artifact = await readIfcLodArtifact<FarArtifact>(key);
  let model: Awaited<ReturnType<ViewerContext['fragments']['core']['load']>> | null | undefined;
  let hit = false;
  let restoredBytes = 0;
  let cacheRestoreFailed = artifact != null;
  cacheReadMs = performance.now() - cacheStarted;
  if (!current()) return;
  if (
    artifact?.bytes instanceof ArrayBuffer &&
    artifact.bytes.byteLength &&
    artifact.index &&
    Array.isArray(artifact.index.objects)
  ) {
    try {
      ctx.fragments.core.settings.autoCoordinate = true;
      // IndexedDB returns an owned clone. Fragments may transfer it to its
      // Worker; only the index and original byte count are needed afterward.
      restoredBytes = artifact.bytes.byteLength;
      model = await ctx.fragments.core.load(artifact.bytes, {
        modelId: runtimeId,
      });
      if (!current()) {
        await discardModel();
        return;
      }
      // The authoritative model is loaded. Connection previews are only useful
      // while conversion is in progress, so there is no mesh replay on a hit.
      hit = true;
      cacheRestoreFailed = false;
    } catch {
      await discardModel();
      if (!current()) return;
      await deleteIfcLodArtifact(key);
      if (!current()) return;
      artifact = null;
      model = null;
    }
  }
  if (hit)
    options.onStage?.('lod-cache-hit', {
      path,
      bytes: restoredBytes,
      readMs: Math.round(cacheReadMs),
    });
  if (!model) {
    artifact = null;
    options.onStage?.('cold-convert', { path });
    model = await loadRawIfc(
      ctx,
      state,
      session,
      input ?? readBytes,
      runtimeId,
      path,
      onProgress,
      undefined,
      {
        transferInput: true,
        openingPolicy: 'bim-lod',
        signal: options.signal,
        conversionPath: cacheRestoreFailed ? 'cache-restore-failed' : 'cache-miss',
        sourceSha256,
        onConversionStage: (stage) =>
          options.onStage?.('cold-convert', {
            path,
            phase:
              (
                {
                  'source-hash': '校验来源',
                  'early-connection': '连接预览已提交',
                  'wasm-init': '读取模型',
                  'source-open': '生成浏览表示',
                } as Record<string, string>
              )[stage] ?? '生成浏览表示',
          }),
        onFarArtifact: (bytes, index) => {
          artifact = { bytes: bytes.slice().buffer, index };
        },
        onRegionalBatch: options.onRegionalBatch,
        onRegionalComplete: options.onRegionalComplete,
      },
    );
    if (!model || !artifact || !current()) {
      if (model)
        void Promise.resolve(ctx.fragments.core.disposeModel(runtimeId)).catch(
          reportBackgroundError,
        );
      return;
    }
    // Return the usable far model immediately. Persisting the derived far
    // artifact is a cache concern; it must not become part of first-usable.
    const cached = artifact as FarArtifact;
    const writeStarted = performance.now();
    options.onStage?.('cache-write-start', { path, bytes: cached.bytes.byteLength });
    if (!current()) {
      await discardModel();
      return;
    }
    scheduleFarArtifactWrite(
      key,
      cached,
      path,
      { startedAt, cacheReadMs, writeStarted },
      current,
      options,
    );
  }
  if (!current()) {
    void Promise.resolve(ctx.fragments.core.disposeModel(runtimeId)).catch(reportBackgroundError);
    return;
  }
  model.object.userData.ifcOpeningPolicy = 'bim-lod';
  model.object.userData.ifcLodCacheHit = hit;
  options.onStage?.('far-ready', { path, source: hit ? 'lod-cache' : 'ifc' });
  if (hit) {
    options.onProfile?.({
      path,
      bytes: restoredBytes,
      source: 'lod-cache',
      cacheHit: true,
      cacheReadMs: Math.round(cacheReadMs),
      loadMs: Math.round(performance.now() - startedAt),
      cacheWriteMs: null,
      cacheWriteOk: null,
    });
  }
  const baseModel = await waitForCoordinateBase(ctx, current);
  if (!baseModel || !current()) {
    if (!current())
      void Promise.resolve(ctx.fragments.core.disposeModel(runtimeId)).catch(reportBackgroundError);
    else throw Error('IFC coordinate anchor unavailable');
    return;
  }
  const base = await readIfcCoordinateAnchor(baseModel);
  if (!current()) {
    void Promise.resolve(ctx.fragments.core.disposeModel(runtimeId)).catch(reportBackgroundError);
    return;
  }
  state.ifc.regionalRuntimes.get(logicalId)?.release();
  const runtime = new IfcRegionalRuntime(logicalId, path, artifact!.index, {
    ctx,
    model,
    readBytes,
    cacheKey: key,
    isCurrent: current,
    sourceToViewer: base.clone(),
    fineQueue: state.substationFineQueue,
    visibility: state.selection.selectionVisibility?.registerModel(logicalId, model),
    onBeforeDisposeGroup: (group) => removeModHighlightGroup(state, group),
    onRepresentationChanged: (object, group, localId, isCurrent, prepareHighlight) =>
      syncIfcRepresentationHighlight(
        ctx,
        state,
        runtimeId,
        logicalId,
        object,
        group,
        localId,
        isCurrent,
        prepareHighlight,
      ),
  });
  runtime.setMemoryPressure?.(state.substationMemoryPressure);
  runtime.setOnlySelected?.(state.selection.onlySelected);
  state.ifc.regionalRuntimes.set(logicalId, runtime);
  state.engineeringGeometryEvidenceChanged?.();
  void Promise.resolve(
    state.selection.selectionVisibility
      ?.sync()
      .catch((error) => logger.warn('[Selection visibility]', error)),
  ).catch(reportBackgroundError);
  return model;
}
