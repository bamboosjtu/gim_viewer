import { IfcImporter } from '@thatopen/fragments';
import type { LoaderSettings } from 'web-ifc';

export interface IfcConversionInput {
  bytes: Uint8Array<ArrayBuffer>;
  wasm: { path: string; absolute: boolean };
  webIfcSettings: LoaderSettings;
}
export type IfcConversionOutput =
  | { type: 'progress'; progress: number }
  | { type: 'complete'; bytes: Uint8Array<ArrayBuffer>; conversionMs: number }
  | { type: 'error'; message: string; stack?: string };

// IfcImporter.process contains synchronous web-ifc calls even though it returns
// a Promise. The existing Fragments worker does not isolate this conversion.
self.onmessage = async (event: MessageEvent<IfcConversionInput>) => {
  try {
    const importer = new IfcImporter();
    importer.wasm = event.data.wasm;
    importer.webIfcSettings = event.data.webIfcSettings;
    const started = performance.now();
    const converted = await importer.process({
      bytes: event.data.bytes,
      progressCallback: (progress) => self.postMessage({ type: 'progress', progress } satisfies IfcConversionOutput),
    });
    // The builder may return a view into a larger allocation. Transfer only the
    // final fragment bytes; the caller terminates this file's WASM worker.
    const bytes = new Uint8Array(converted);
    self.postMessage({ type: 'complete', bytes, conversionMs: performance.now() - started } satisfies IfcConversionOutput,
      { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined } satisfies IfcConversionOutput);
  }
};
