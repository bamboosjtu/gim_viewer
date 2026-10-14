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
installWebIfcStreamCompatibility();

export interface IfcConversionInput {
  bytes: Uint8Array<ArrayBuffer>;
  wasm: { path: string; absolute: boolean };
  webIfcSettings: LoaderSettings;
  openingPolicy?: IfcOpeningPolicy;
}
export type IfcConversionOutput =
  | { type: 'progress'; progress: number }
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
self.onmessage = async (event: MessageEvent<IfcConversionInput>) => {
  try {
    let regionalIndex: RegionalIndex | undefined;
    const coldPipeline: Record<string, number> = {};
    let removedOpeningRelations = 0;
    const sourceSha256 =
      event.data.openingPolicy === 'bim-lod'
        ? [
            ...new Uint8Array(
              await crypto.subtle.digest('SHA-256', event.data.bytes)
            ),
          ]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('')
        : undefined;
    if (event.data.openingPolicy === 'omit-rel-voids')
      removedOpeningRelations = omitIfcOpeningRelations(event.data.bytes);
    const importer = new IfcImporter();
    importer.wasm = event.data.wasm;
    importer.webIfcSettings = event.data.webIfcSettings;
    if (event.data.openingPolicy === 'bim-lod') {
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
        bytes: event.data.bytes,
        progressCallback: (progress) =>
          self.postMessage({
            type: 'progress',
            progress,
          } satisfies IfcConversionOutput),
      });
    let converted: Uint8Array;
    if (event.data.openingPolicy === 'bim-lod') {
      let stage = performance.now();
      const openingRelations: RegionalIndex['openingRelations'] = [];
      removedOpeningRelations = omitIfcOpeningRelations(
        event.data.bytes,
        () => false,
        (r) => openingRelations.push(r)
      );
      coldPipeline.preparationMs = performance.now() - stage;
      stage = performance.now();
      const api = new IfcAPI();
      api.SetWasmPath(event.data.wasm.path, event.data.wasm.absolute);
      await api.Init(undefined, true);
      coldPipeline.wasmInitMs = performance.now() - stage;
      stage = performance.now();
      try {
        const model = api.OpenModel(
          event.data.bytes,
          event.data.webIfcSettings
        );
        coldPipeline.openModelMs = performance.now() - stage;
        coldPipeline.parsedModels = 1;
        stage = performance.now();
        if (model < 0) throw Error('IFC derived model failed to open');
        const semantics = {
          ...readRegionalSemantics(api, model),
          openingRelations,
        };
        coldPipeline.semanticsMs = performance.now() - stage;
        stage = performance.now();
        const collector = new RegionalIndexCollector(
          api,
          model,
          event.data.webIfcSettings.COORDINATE_TO_ORIGIN !== false
        );
        converted = await withSharedIfcImport(
          api,
          model,
          event.data.bytes,
          event.data.webIfcSettings,
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
          event.data.openingPolicy === 'bim-lod' ? coldPipeline : undefined,
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
