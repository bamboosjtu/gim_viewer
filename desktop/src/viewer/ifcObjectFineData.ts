import type { IfcCoordinateFrame } from '@gim/gim-sdk/geometry';
import type { IfcAPI } from 'web-ifc';

export interface ObjectFinePart {
  geometryId?: number;
  vertices: Float32Array;
  indices: Uint32Array;
  matrix: number[];
  color: number[];
}
export interface ObjectFineResult {
  expressId: number;
  globalId: string;
  ifcType: string;
  /** Cached regional results from source-coordinate workers may omit the frame. */
  frame?: IfcCoordinateFrame;
  parts: ObjectFinePart[];
  geometryMs: number;
  wasmHeapBytes: number;
  coordinationMatrix: number[];
}
/** Exactly one source product; GetFlatMesh does not stream/convert the entire file. */
export function extractIfcObjectFine(
  api: IfcAPI,
  model: number,
  expressId: number,
  globalId: string,
  templates = new Map<number, { vertices: Float32Array; indices: Uint32Array }>(),
  placementSpace: IfcCoordinateFrame['kind'] = 'source',
): ObjectFineResult {
  const entity = api.GetLine(model, expressId, false) as
    { GlobalId?: { value?: string }; type: number } | undefined;
  if (!entity || String(entity.GlobalId?.value ?? '') !== globalId)
    throw new Error('IFC object identity mismatch');
  const started = performance.now(),
    flat = api.GetFlatMesh(model, expressId),
    parts: ObjectFinePart[] = [];
  try {
    for (let i = 0; i < flat.geometries.size(); i++) {
      const placed = flat.geometries.get(i);
      let template = templates.get(placed.geometryExpressID);
      if (!template) {
        const geometry = api.GetGeometry(model, placed.geometryExpressID);
        try {
          template = {
            vertices: new Float32Array(
              api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize()),
            ),
            indices: new Uint32Array(
              api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize()),
            ),
          };
          templates.set(placed.geometryExpressID, template);
        } finally {
          geometry.delete();
        }
      }
      parts.push({
        geometryId: placed.geometryExpressID,
        ...template,
        matrix: [...placed.flatTransformation],
        color: [placed.color.x, placed.color.y, placed.color.z, placed.color.w],
      });
    }
  } finally {
    // 0.0.77's declaration includes delete(), but its WASM FlatMesh is a
    // plain value object. Only delete actual embind owners, not the value.
    if (typeof flat.delete === 'function') flat.delete();
    else (flat.geometries as unknown as { delete?: () => void }).delete?.();
  }
  const coordinationMatrix = api.GetCoordinationMatrix(model);
  const frame: IfcCoordinateFrame =
    placementSpace === 'source'
      ? { kind: 'source' }
      : { kind: 'coordination-applied', coordinationMatrix };
  return {
    expressId,
    globalId,
    frame,
    ifcType: api.GetNameFromTypeCode(entity.type),
    parts,
    geometryMs: performance.now() - started,
    wasmHeapBytes: (api.wasmModule as { HEAPU8?: Uint8Array } | undefined)?.HEAPU8?.byteLength ?? 0,
    coordinationMatrix,
  };
}

/** Only for replies relinquishing ownership; regional retained templates use separate copies. */
export function fineTransferList(result: ObjectFineResult) {
  return [...new Set(result.parts.flatMap((p) => [p.vertices.buffer, p.indices.buffer]))];
}
