import type { ViewerContext } from './viewerEngine.js';
import type { AppState, ProjectLoadSession } from '../app/state.js';
import { loadRawIfc } from './ifcConversion.js';
import { IFC_LOD_CACHE_VERSION } from '../config/features.js';
import {
  readIfcLodArtifact,
  writeIfcLodArtifact,
  deleteIfcLodArtifact,
} from '@desktop/ifcLodCache.js';
import { IfcRegionalRuntime } from './ifcRegionalRuntime.js';
import type { RegionalIndex } from './ifcRegionalData.js';
import { resetModHighlight } from './highlight.js';
import { readIfcCoordinateAnchor } from './ifcCoordinateAnchor.js';
interface FarArtifact {
  bytes: ArrayBuffer;
  index: RegionalIndex;
}
export type IfcLoadStage = 'checking-cache' | 'lod-cache-hit' | 'cold-convert' | 'far-ready' | 'cache-write-start' | 'cache-written' | 'cache-write-failed';
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
export async function loadBimIfc(
  ctx: ViewerContext,
  state: AppState,
  session: ProjectLoadSession,
  runtimeId: string,
  logicalId: string,
  path: string,
  readBytes: () => Promise<Uint8Array | null>,
  onProgress?: (p: number) => void,
  options: { sourceIdentity?: string; initialBytes?: Uint8Array; onStage?: (stage: IfcLoadStage, meta?: Record<string, unknown>) => void; onProfile?: (profile: IfcFileProfile) => void } = {}
) {
  const current = () => state.isCurrentSession(session);
  const startedAt = performance.now();
  let cacheReadMs = 0;
  let cacheWriteMs: number | null = null;
  let cacheWriteOk: boolean | null = null;
  options.onStage?.('checking-cache', { path });
  let input: Uint8Array | null = options.initialBytes ?? null;
  let identity = options.sourceIdentity ?? session.sourceSha256;
  if (!identity) {
    input = await readBytes();
    if (!input || !current()) return;
    identity = [
      ...new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(input))
      ),
    ]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  }
  const key = `${IFC_LOD_CACHE_VERSION}|${identity}|${path.toLowerCase()}`;
  const cacheStarted = performance.now();
  let artifact = await readIfcLodArtifact<FarArtifact>(key),
    model: any,
    hit = false;
  cacheReadMs = performance.now() - cacheStarted;
  if (!current()) return;
  if (
    artifact?.bytes instanceof ArrayBuffer &&
    artifact.bytes.byteLength &&
    artifact.index?.objects?.length
  ) {
    try {
      ctx.fragments.core.settings.autoCoordinate = true;
      model = await ctx.fragments.core.load(artifact.bytes.slice(0), {
        modelId: runtimeId,
      });
      hit = true;
      options.onStage?.('lod-cache-hit', { path, bytes: artifact.bytes.byteLength, readMs: Math.round(cacheReadMs) });
    } catch {
      try { await ctx.fragments.core.disposeModel(runtimeId); }
      catch { /* A rejected load may not have registered a model. */ }
      await deleteIfcLodArtifact(key);
      artifact = null;
    }
  }
  if (!model) {
    artifact = null;
    options.onStage?.('cold-convert', { path });
    input ??= await readBytes();
    if (!input || !current()) return;
    model = await loadRawIfc(
      ctx,
      state,
      session,
      input,
      runtimeId,
      path,
      onProgress,
      undefined,
      {
        transferInput: true,
        openingPolicy: 'bim-lod',
        onFarArtifact: (bytes, index) => {
          artifact = { bytes: bytes.slice().buffer, index };
        },
      }
    );
    if (!model || !artifact || !current()) {
      if (model) ctx.fragments.core.disposeModel(runtimeId);
      return;
    }
    // Return the usable far model immediately. Persisting the derived far
    // artifact is a cache concern; it must not become part of first-usable.
    const cached = artifact as FarArtifact;
    const writeStarted = performance.now();
    options.onStage?.('cache-write-start', { path, bytes: cached.bytes.byteLength });
    void Promise.resolve(writeIfcLodArtifact(key, cached)).then((result) => {
      const ok = (result as { ok?: boolean } | undefined)?.ok !== false;
      cacheWriteOk = ok;
      cacheWriteMs = performance.now() - writeStarted;
      options.onStage?.(ok ? 'cache-written' : 'cache-write-failed', {
        path, ms: Math.round(cacheWriteMs),
        ...(ok ? {} : { error: (result as { error?: string } | undefined)?.error ?? 'cache write failed' }),
      });
    }).catch((error) => {
      cacheWriteOk = false;
      cacheWriteMs = performance.now() - writeStarted;
      options.onStage?.('cache-write-failed', { path, error: String(error), ms: Math.round(cacheWriteMs) });
    }).finally(() => {
      options.onProfile?.({
        path, bytes: cached.bytes.byteLength, source: 'ifc', cacheHit: false,
        cacheReadMs: Math.round(cacheReadMs), loadMs: Math.round(performance.now() - startedAt),
        cacheWriteMs: cacheWriteMs == null ? null : Math.round(cacheWriteMs), cacheWriteOk,
      });
    });
  }
  if (!current()) {
    ctx.fragments.core.disposeModel(runtimeId);
    return;
  }
  model.object.userData.ifcOpeningPolicy = 'bim-lod';
  model.object.userData.ifcLodCacheHit = hit;
  options.onStage?.('far-ready', { path, source: hit ? 'lod-cache' : 'ifc' });
  if (hit) {
    options.onProfile?.({
      path, bytes: artifact?.bytes.byteLength ?? 0, source: 'lod-cache', cacheHit: true,
      cacheReadMs: Math.round(cacheReadMs), loadMs: Math.round(performance.now() - startedAt),
      cacheWriteMs: null, cacheWriteOk: null,
    });
  }
  let baseModel = ctx.fragments.list.get(ctx.fragments.baseCoordinationModel);
  for (let frame = 0; !baseModel && frame < 60 && current(); frame++) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );
    baseModel = ctx.fragments.list.get(ctx.fragments.baseCoordinationModel);
  }
  if (!baseModel || !current()) {
    if (!current()) ctx.fragments.core.disposeModel(runtimeId);
    else throw Error('IFC coordinate anchor unavailable');
    return;
  }
  const base = await readIfcCoordinateAnchor(baseModel);
  if (!current()) {
    ctx.fragments.core.disposeModel(runtimeId);
    return;
  }
  state.ifcRegionalRuntimes.get(logicalId)?.release();
  const runtime = new IfcRegionalRuntime(logicalId, path, artifact!.index, {
    ctx,
    model,
    readBytes,
    cacheKey: key,
    isCurrent: current,
    sourceToViewer: base.clone(),
    onBeforeDisposeGroup:group=>{if(state.highlightedModState?.groups.includes(group))resetModHighlight(state);},
  });
  state.ifcRegionalRuntimes.set(logicalId, runtime);
  return model;
}
