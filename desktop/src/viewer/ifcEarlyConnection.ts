import type { IfcAPI, LoaderSettings } from 'web-ifc';
import { buildEarlyConnectionInput, type IndexedOpening } from '../gim/ifcConnectionSubset.js';
import { CONNECTION_IFC_TYPES, isRegionalConnectionObject } from './ifcRegionalData.js';
import { CONNECTION_GEOMETRY_VERSION, streamConnectionGeometry, validConnectionArtifact,
  type ConnectionGeometryBatch } from './ifcConnectionBatches.js';

export interface EarlyConnectionResult {
  openings?: IndexedOpening[];
  skipIds: Set<number>;
  sequence: number;
  objectCount: number;
  profile: Record<string, number>;
  fallback?: string;
}
/** Emit only a completely validated, bounded first object before opening the
 * full source. The ordinary source evaluator owns all remaining objects. */
export async function streamEarlyConnection(createApi: () => Promise<IfcAPI>, bytes: Uint8Array, settings: LoaderSettings,
  emit: (batch: ConnectionGeometryBatch) => Promise<void>): Promise<EarlyConnectionResult> {
  const result: EarlyConnectionResult = {skipIds: new Set(), sequence: 0, objectCount: 0, profile: {}};
  const began = performance.now();
  let prepared;
  try {
    prepared = buildEarlyConnectionInput(bytes, CONNECTION_IFC_TYPES,
      (ifcType, name) => isRegionalConnectionObject({expressId: 0, globalId: '', ifcType, name, bounds: []}));
  } catch (error) { result.fallback = String(error); }
  result.profile.earlyPreparationMs = performance.now() - began;
  if (!prepared) return result;
  result.openings = prepared.openings;
  Object.assign(result.profile, {earlyIndexMs: prepared.indexingMs, earlyClosureMs: prepared.buildMs,
    earlyIndexBytes: prepared.indexBytes, earlySubsetBytes: prepared.bytes.byteLength,
    earlyIndexedRecords: prepared.indexedRecords, earlySubsetRecords: prepared.subsetRecords});
  let api: IfcAPI | undefined;
  const batches: ConnectionGeometryBatch[] = [];
  let retained = 0;
  try {
    const started = performance.now();
    api = await createApi();
    result.profile.earlyWasmInitMs = performance.now() - started;
    // Source placement and unit tokens are unchanged. Use absolute Y-up metres
    // so a private first-object origin never becomes the project anchor.
    const openStarted = performance.now();
    const model = api.OpenModel(prepared.bytes, {...settings, COORDINATE_TO_ORIGIN: false});
    result.profile.earlyOpenModelMs = performance.now() - openStarted;
    if (model < 0) throw Error('IFC early subset could not open');
    result.profile.earlyParsedModels = 1;
    const complete = await streamConnectionGeometry(api, model, false, async batch => {
      retained += batch.bytes;
      if (retained > 4 * 1024 * 1024) throw Error('IFC early mesh exceeds 4 MiB');
      batches.push(batch);
    }, {onlyIds: new Set([prepared.expressId])});
    if (complete.objectCount !== 1 || complete.failedObjects.length
      || !validConnectionArtifact({version: CONNECTION_GEOMETRY_VERSION, batches, complete}))
      throw Error('IFC early object is incomplete');
    batches.pop(); // Full-source stream alone publishes its final receipt.
    result.sequence = complete.sequence - 1;
    result.objectCount = 1;
    result.skipIds.add(prepared.expressId);
    result.profile.earlyMeshBytes = retained;
  } catch (error) {
    result.fallback = String(error); batches.length = 0;
    result.sequence = 0; result.objectCount = 0; result.skipIds.clear();
  } finally { api?.Dispose(); }
  // Consumer/cancellation errors propagate. Never retry an already emitted
  // sequence or turn a failed scene consumer into an optional-source fallback.
  for (const batch of batches) await emit(batch);
  return result;
}
