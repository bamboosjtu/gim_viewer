import { IfcAPI } from 'web-ifc';
import { omitIfcOpeningRelations } from './ifcOpeningPolicy.js';
import { extractIfcObjectFine } from './ifcObjectFineData.js';
import {
  classifyRegionalOpenings,
  type RegionalIndex,
} from './ifcRegionalData.js';
const api = new IfcAPI();
let model: number | null = null,
  bytes: Uint8Array<ArrayBuffer>,
  index: RegionalIndex;
const small = new Set<number>(),
  classified = new Set<number>();
const templates = new Map<
  number,
  { vertices: Float32Array; indices: Uint32Array }
>();
let objectTypes = new Map<number, string>();
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'open') {
      bytes = data.bytes;
      index = data.index;
      objectTypes = new Map(
        index.objects.map((row) => [row.expressId, row.ifcType])
      );
      self.postMessage({ stage: 'source-check' });
      const sha = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      ]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
      if (sha !== index.sourceSha256)
        throw Error('IFC source identity changed');
      self.postMessage({ stage: 'wasm-init' });
      api.SetWasmPath(data.wasm.path, data.wasm.absolute);
      await api.Init(undefined, true);
      self.postMessage({ stage: 'source-open' });
      model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
      self.postMessage({ id: data.id, data: { opened: true } });
    } else if (data.type === 'prepare-region') {
      if (model === null) throw Error('Regional source unavailable');
      const hosts = new Set<number>(
          (data.objects as number[]).filter((id) => !classified.has(id))
        ),
        result = classifyRegionalOpenings(api, model, index, hosts);
      for (const id of hosts) classified.add(id);
      for (const id of result.small) small.add(id);
      if (result.small.length) {
        templates.clear();
        api.CloseModel(model);
        omitIfcOpeningRelations(bytes, (id) => !small.has(id));
        model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
      }
      self.postMessage({
        id: data.id,
        data: { ...result, classifiedHosts: hosts.size },
      });
    } else if (data.type === 'region') {
      if (model === null) throw Error('Regional source unavailable');
      const results = [];
      for (const object of data.objects as {
        expressId: number;
        globalId: string;
      }[]) {
        try {
          results.push(
            extractIfcObjectFine(
              api,
              model,
              object.expressId,
              object.globalId,
              /^(IFCMECHANICALFASTENER|IFCFASTENER)$/i.test(
                objectTypes.get(object.expressId) ?? ''
              )
                ? templates
                : undefined
            )
          );
        } catch (error) {
          console.warn(
            '[IFC regional] object unavailable',
            object.expressId,
            error
          );
        }
      }
      // Retain worker templates across batches, but transfer each reply copy
      // only once even when hundreds of placements share its buffers.
      const replyTemplates = new Map<
        number,
        { vertices: Float32Array; indices: Uint32Array }
      >();
      for (const result of results)
        for (const part of result.parts)
          if (part.geometryId !== undefined && templates.has(part.geometryId)) {
            let copy = replyTemplates.get(part.geometryId);
            if (!copy) {
              copy = {
                vertices: part.vertices.slice(),
                indices: part.indices.slice(),
              };
              replyTemplates.set(part.geometryId, copy);
            }
            part.vertices = copy.vertices;
            part.indices = copy.indices;
          }
      self.postMessage(
        { id: data.id, data: results },
        {
          transfer: [
            ...new Set(
              results.flatMap((r: any) =>
                r.parts.flatMap((p: any) => [
                  p.vertices.buffer,
                  p.indices.buffer,
                ])
              )
            ),
          ],
        }
      );
    } else if (data.type === 'properties') {
      if (model === null) throw Error('Regional source unavailable');
      const attributes = await api.properties.getItemProperties(
          model,
          data.expressId,
          false
        ),
        propertySets = await api.properties.getPropertySets(
          model,
          data.expressId,
          true
        );
      const typeProperties = await api.properties.getTypeProperties(
        model,
        data.expressId,
        true
      );
      const materials = await api.properties.getMaterialsProperties(
        model,
        data.expressId,
        true,
        true
      );
      self.postMessage({
        id: data.id,
        data: JSON.parse(
          JSON.stringify(
            { attributes, propertySets, typeProperties, materials },
            (_k, v) =>
              v?.constructor?.name === 'NumberHandle'
                ? { type: v.type, value: v.value }
                : v
          )
        ),
      });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
