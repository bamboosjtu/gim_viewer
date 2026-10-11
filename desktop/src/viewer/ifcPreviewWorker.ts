import { IfcAPI } from 'web-ifc';
import { inspectIfcPreview } from './ifcPreviewData.js';

const api = new IfcAPI();
let model: number | null = null;
/** Worker owns a metadata-only model until fine geometry is ready or the project closes. */
self.onmessage = async (event: MessageEvent) => {
  const input = event.data;
  try {
    if (input.type === 'open') {
      api.SetWasmPath(input.wasm.path, input.wasm.absolute);
      await api.Init(undefined, true);
      const started = performance.now();
      model = api.OpenModel(input.bytes, { COORDINATE_TO_ORIGIN: false });
      if (model < 0) throw new Error('IFC metadata open failed');
      const openMs = performance.now() - started;
      const data = inspectIfcPreview(api, model, input.modelId, input.sourcePath);
      data.wasmHeapBytes = api.wasmModule?.HEAPU8?.byteLength ?? 0;
      self.postMessage({ id: input.id, data, openMs, inspectMs: performance.now()-started-openMs });
    } else if (input.type === 'properties-once') {
      api.SetWasmPath(input.wasm.path, input.wasm.absolute);
      await api.Init(undefined, true);
      const oneShotModel = api.OpenModel(input.bytes, { COORDINATE_TO_ORIGIN: false });
      if (oneShotModel < 0) throw new Error('IFC property model open failed');
      try {
        const attributes = api.GetLine(oneShotModel, input.expressId, false);
        const propertySets = await api.properties.getPropertySets(oneShotModel, input.expressId, true);
        const data = JSON.parse(JSON.stringify({attributes,propertySets}, (_key,value) =>
          value && typeof value === 'object' && '_representationValue' in value ? {value:value.value} : value));
        self.postMessage({id:input.id,data,wasmHeapBytes:api.wasmModule?.HEAPU8?.byteLength??0});
      } finally { api.CloseModel(oneShotModel); }
    } else if (input.type === 'properties') {
      if (model == null) throw new Error('Preview metadata released');
      const attributes = api.GetLine(model, input.expressId, false);
      const propertySets = await api.properties.getPropertySets(model, input.expressId, true);
      // NumberHandle.value is a getter; structured clone would otherwise lose it.
      const data = JSON.parse(JSON.stringify({attributes,propertySets}, (_key,value) =>
        value && typeof value === 'object' && '_representationValue' in value ? {value:value.value} : value));
      self.postMessage({id:input.id,data});
    }
  } catch(error) {
    self.postMessage({id:input.id,error:error instanceof Error?error.message:String(error)});
  }
};
