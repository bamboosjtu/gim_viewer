import { IfcImporter } from '@thatopen/fragments';
import type { LoaderSettings } from 'web-ifc';
import { omitIfcOpeningRelations } from './ifcOpeningPolicy.js';
import type { IfcOpeningPolicy } from '../config/features.js';
import {
  IfcAPI,
  IFCMECHANICALFASTENER,
  IFCFASTENER,
  IFCPROJECT,
  IFCSITE,
  IFCBUILDING,
  IFCBUILDINGSTOREY,
  IFCSPACE,
  IFCRELAGGREGATES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
} from 'web-ifc';
import {
  RegionalIndexCollector,
  readRegionalSemantics,
  type RegionalIndex,
} from './ifcRegionalData.js';
import { installWebIfcStreamCompatibility } from './webIfcCompatibility.js';
import { withSharedIfcImport } from './ifcSharedImport.js';
import { streamConnectionGeometry, type ConnectionGeometryBatch } from './ifcConnectionBatches.js';
import { streamEarlyConnection } from './ifcEarlyConnection.js';
import { omitIndexedOpenings } from '../gim/ifcConnectionSubset.js';
import { readConnectionEndpointEvidence } from './ifcConnectionEndpoints.js';
installWebIfcStreamCompatibility();

export interface IfcConversionInput {
  bytes: Uint8Array<ArrayBuffer>;
  wasm: { path: string; absolute: boolean };
  webIfcSettings: LoaderSettings;
  openingPolicy?: IfcOpeningPolicy;
  earlyConnections?: boolean;
}
export type IfcConversionOutput =
  | { type: 'progress'; progress: number }
  | { type: 'stage'; stage: string; elapsedMs: number; meta?: Record<string, number | string> }
  | ({ type: 'regional-batch' } & ConnectionGeometryBatch)
  | {
      type: 'regional-complete';
      objectCount: number;
      sequence: number;
    }
  | {
      type: 'complete';
      bytes: Uint8Array<ArrayBuffer>;
      conversionMs: number;
      removedOpeningRelations?: number;
      regionalIndex?: RegionalIndex;
      coldPipeline?: Record<string, number>;
    }
  | { type: 'error'; message: string; stack?: string };

// IfcImporter.process contains synchronous web-ifc calls even though it returns
// a Promise. The existing Fragments worker does not isolate this conversion.
const consumed = new Map<number, () => void>();
self.onmessage = async (event: MessageEvent<IfcConversionInput | { type: 'connection-consumed'; sequence: number }>) => {
  if ('type' in event.data && event.data.type === 'connection-consumed') {
    consumed.get(event.data.sequence)?.(); consumed.delete(event.data.sequence); return;
  }
  const input = event.data as IfcConversionInput;
  try {
    let regionalIndex: RegionalIndex | undefined;
    const coldPipeline: Record<string, number> = {};
    let removedOpeningRelations = 0;
    const hashStarted = performance.now();
    const sourceSha256 =
      input.openingPolicy === 'bim-lod'
        ? [
            ...new Uint8Array(
              await crypto.subtle.digest('SHA-256', input.bytes)
            ),
          ]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('')
        : undefined;
    if (input.openingPolicy === 'bim-lod') {
      coldPipeline.sourceHashMs = performance.now() - hashStarted;
      self.postMessage({type:'stage',stage:'source-hash',elapsedMs:coldPipeline.sourceHashMs} satisfies IfcConversionOutput);
    }
    if (input.openingPolicy === 'omit-rel-voids')
      removedOpeningRelations = omitIfcOpeningRelations(input.bytes);
    const importer = new IfcImporter();
    importer.wasm = input.wasm;
    importer.webIfcSettings = input.webIfcSettings;
    if (input.openingPolicy === 'bim-lod') {
      importer.classes.elements.delete(IFCMECHANICALFASTENER);
      importer.classes.elements.delete(IFCFASTENER);
      importer.classes.abstract.clear();
      for (const type of [
        IFCPROJECT,
        IFCSITE,
        IFCBUILDING,
        IFCBUILDINGSTOREY,
        IFCSPACE,
      ])
        importer.classes.abstract.add(type);
      for (const type of [...importer.relations.keys()])
        if (
          type !== IFCRELAGGREGATES &&
          type !== IFCRELCONTAINEDINSPATIALSTRUCTURE
        )
          importer.relations.delete(type);
    }
    const started = performance.now();
    const process = () =>
      importer.process({
        bytes: input.bytes,
        progressCallback: (progress) =>
          self.postMessage({
            type: 'progress',
            progress,
          } satisfies IfcConversionOutput),
      });
    let converted: Uint8Array;
    if (input.openingPolicy === 'bim-lod') {
      const openingRelations: RegionalIndex['openingRelations'] = [];
      const emit = async (batch: ConnectionGeometryBatch): Promise<void> => {
        const ack = new Promise<void>(resolve => consumed.set(batch.sequence, resolve));
        self.postMessage({ type: 'regional-batch', ...batch } satisfies IfcConversionOutput,
          { transfer: (batch.chunks ?? []).map(chunk => chunk.vertices.buffer as ArrayBuffer) });
        await ack;
      };
      const createApi = async (): Promise<IfcAPI> => {
        const api = new IfcAPI();
        api.SetWasmPath(input.wasm.path, input.wasm.absolute);
        try { await api.Init(undefined, true); return api; }
        catch (error) { try { api.Dispose(); } catch { /* Preserve initialization failure. */ } throw error; }
      };
      // The optional prefix owns and disposes its API. A fresh full-source API
      // must open model 0, as required by the installed Fragments importer.
      const early = input.earlyConnections !== false
        ? await streamEarlyConnection(createApi, input.bytes, input.webIfcSettings, emit)
        : {skipIds: new Set<number>(), sequence: 0, objectCount: 0, profile: {}, openings: undefined, fallback: undefined};
      Object.assign(coldPipeline, early.profile);
      self.postMessage({type:'stage',stage:'early-connection',elapsedMs:Number(early.profile.earlyPreparationMs)||0,
        meta:{objects:early.objectCount,...(early.fallback?{fallback:early.fallback}:{})}} satisfies IfcConversionOutput);
      let stage = performance.now();
      const api = await createApi();
      coldPipeline.wasmInitMs = performance.now() - stage;
      self.postMessage({type:'stage',stage:'wasm-init',elapsedMs:coldPipeline.wasmInitMs} satisfies IfcConversionOutput);
      try {
        stage = performance.now();
        if (early.openings) {
          openingRelations.push(...early.openings.map(({id,host,opening})=>({id,host,opening})));
          omitIndexedOpenings(input.bytes, early.openings);
          removedOpeningRelations = early.openings.length;
        } else removedOpeningRelations = omitIfcOpeningRelations(input.bytes, () => false, r => openingRelations.push(r));
        coldPipeline.preparationMs = performance.now() - stage;
        stage = performance.now();
        const model = api.OpenModel(
          input.bytes,
          input.webIfcSettings
        );
        coldPipeline.openModelMs = performance.now() - stage;
        self.postMessage({type:'stage',stage:'source-open',elapsedMs:coldPipeline.openModelMs} satisfies IfcConversionOutput);
        coldPipeline.parsedModels = 1 + (early.profile.earlyParsedModels || 0);
        stage = performance.now();
        if (model < 0) throw Error('IFC derived model failed to open');
        const semantics = {
          ...readRegionalSemantics(api, model),
          openingRelations,
        };
        coldPipeline.semanticsMs = performance.now() - stage;
        stage = performance.now();
        let endpointEvidence: ReturnType<typeof readConnectionEndpointEvidence> | undefined;
        try { endpointEvidence = readConnectionEndpointEvidence(api,model); }
        catch (error) {
          coldPipeline.connectionEvidenceUnavailable = 1;
          self.postMessage({type:'stage',stage:'connection-evidence-unavailable',elapsedMs:performance.now()-stage,
            meta:{reason:String(error).slice(0,256)}} satisfies IfcConversionOutput);
        }
        coldPipeline.connectionEvidenceMs = performance.now() - stage;
        stage = performance.now();
        const connectionStarted = performance.now();
        const connection = await streamConnectionGeometry(api, model,
          input.webIfcSettings.COORDINATE_TO_ORIGIN !== false, emit,
          {skipIds:early.skipIds,startSequence:early.sequence,initialObjectCount:early.objectCount,connectionEndpoints:endpointEvidence});
        coldPipeline.connectionGeometryMs = performance.now() - connectionStarted;
        coldPipeline.connectionFailedObjects = connection.failedObjects.length;
        self.postMessage({ type: 'regional-complete', ...connection } satisfies IfcConversionOutput);
        const collector = new RegionalIndexCollector(api, model,
          input.webIfcSettings.COORDINATE_TO_ORIGIN !== false,undefined,endpointEvidence);
        stage = performance.now();
        converted = await withSharedIfcImport(
          api,
          model,
          input.bytes,
          input.webIfcSettings,
          collector.observe,
          process
        );
        coldPipeline.importWithBoundsMs = performance.now() - stage;
        stage = performance.now();
        regionalIndex = collector.finish(semantics);
        regionalIndex.sourceSha256 = sourceSha256;
        coldPipeline.remainingIndexMs = performance.now() - stage;

      } finally {
        api.Dispose();
      }
    } else converted = await process();
    // The builder may return a view into a larger allocation. Transfer only the
    // final fragment bytes; the caller terminates this file's WASM worker.
    const bytes = new Uint8Array(converted);
    self.postMessage(
      {
        type: 'complete',
        bytes,
        conversionMs: performance.now() - started,
        removedOpeningRelations,
        regionalIndex,
        coldPipeline:
          input.openingPolicy === 'bim-lod' ? coldPipeline : undefined,
      } satisfies IfcConversionOutput,
      { transfer: [bytes.buffer] }
    );
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    } satisfies IfcConversionOutput);
  }
};
