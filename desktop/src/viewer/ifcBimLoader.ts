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
export async function loadBimIfc(
  ctx: ViewerContext,
  state: AppState,
  session: ProjectLoadSession,
  runtimeId: string,
  logicalId: string,
  path: string,
  readBytes: () => Promise<Uint8Array | null>,
  onProgress?: (p: number) => void,
  options: { sourceIdentity?: string; initialBytes?: Uint8Array } = {}
) {
  const current = () => state.isCurrentSession(session);
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
  let artifact = await readIfcLodArtifact<FarArtifact>(key),
    model: any,
    hit = false;
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
    } catch {
      try { await ctx.fragments.core.disposeModel(runtimeId); }
      catch { /* A rejected load may not have registered a model. */ }
      await deleteIfcLodArtifact(key);
      artifact = null;
    }
  }
  if (!model) {
    artifact = null;
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
    await writeIfcLodArtifact(key, artifact);
  }
  if (!current()) {
    ctx.fragments.core.disposeModel(runtimeId);
    return;
  }
  model.object.userData.ifcOpeningPolicy = 'bim-lod';
  model.object.userData.ifcLodCacheHit = hit;
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
