/** Shared limits for the incremental IFC connection preview protocol. */
export const IFC_CONNECTION_BATCH_MAX_OBJECTS = 128;
export const IFC_CONNECTION_BATCH_MAX_BYTES = 4 * 1024 * 1024;

import * as THREE from 'three';
import type { IfcAPI } from 'web-ifc';
import { isRegionalConnectionObject, CONNECTION_IFC_TYPES, type RegionalObject } from './ifcRegionalData.js';
import { validEndpointEvidence, type ConnectionEndpointEvidence } from '../gim/connectionEndpoints.js';

export interface ConnectionMeshChunk {
  object: RegionalObject;
  part: number;
  chunk: number;
  /** Interleaved source position/normal, triangle order unchanged. */
  vertices: Float32Array;
  matrix: number[];
  color: number[];
  objectComplete: boolean;
}
export interface ConnectionGeometryBatch {
  sequence: number;
  objects: RegionalObject[];
  chunks?: ConnectionMeshChunk[];
  bytes: number;
  final: boolean;
}
/** Conservative transport accounting includes UTF-16 metadata, matrices and
 * object overhead as well as the owned vertex buffer. */
export function connectionChunkBytes(chunk: ConnectionMeshChunk): number {
  return chunk.vertices.byteLength + 512 + 2 * (chunk.object.globalId.length
    + chunk.object.ifcType.length + chunk.object.name.length)
    + (chunk.object.connectionEndpoints ? 2 * JSON.stringify(chunk.object.connectionEndpoints).length : 0);
}
export const CONNECTION_GEOMETRY_VERSION = 'connection-mesh-v1';

/** OpenModel is still a prerequisite. Read source entity evidence first, then
 * extract conductors before the ordinary Fragments importer starts. Each
 * transferred chunk owns at most 256 KiB. Send the first chunk immediately,
 * then amortize consumption acknowledgements in bounded multi-chunk batches. */
export async function streamConnectionGeometry(api: IfcAPI, model: number, normalized: boolean,
  emit: (batch: ConnectionGeometryBatch) => Promise<void>, options: {
    onlyIds?: ReadonlySet<number>;
    skipIds?: ReadonlySet<number>;
    startSequence?: number;
    initialObjectCount?: number;
    connectionEndpoints?: ReadonlyMap<number, ConnectionEndpointEvidence[]>;
  } = {}): Promise<{ objectCount: number; sequence: number; failedObjects: number[] }> {
  const ids = new Set<number>();
  for (const type of [...CONNECTION_IFC_TYPES, 'IFCBUILDINGELEMENTPROXY']) {
    const code = api.GetTypeCodeFromName(type);
    if (!code) continue;
    const rows = api.GetLineIDsWithType(model, code);
    try { for (let i = 0; i < rows.size(); i++) ids.add(rows.get(i)); }
    finally { (rows as any).delete?.(); }
  }
  let sequence = options.startSequence ?? 0, objectCount = options.initialObjectCount ?? 0;
  let pendingChunks: ConnectionMeshChunk[] = [], pendingBytes = 0;
  let pendingObjects = new Map<number, RegionalObject>();
  const flush = async (): Promise<void> => {
    if (!pendingChunks.length) return;
    const batch = {sequence: sequence++, objects: [...pendingObjects.values()], chunks: pendingChunks,
      bytes: pendingBytes, final: false};
    pendingChunks = []; pendingBytes = 0; pendingObjects = new Map();
    await emit(batch);
  };
  const enqueue = async (chunk: ConnectionMeshChunk): Promise<void> => {
    const bytes = connectionChunkBytes(chunk);
    if (bytes > IFC_CONNECTION_BATCH_MAX_BYTES) throw Error(`Connection metadata exceeds batch quota: ${chunk.object.expressId}`);
    if (pendingBytes + bytes > IFC_CONNECTION_BATCH_MAX_BYTES
      || !pendingObjects.has(chunk.object.expressId) && pendingObjects.size === IFC_CONNECTION_BATCH_MAX_OBJECTS) await flush();
    pendingChunks.push(chunk); pendingBytes += bytes; pendingObjects.set(chunk.object.expressId, chunk.object);
    if (sequence === 0 || pendingBytes === IFC_CONNECTION_BATCH_MAX_BYTES) await flush();
  };
  const failedObjects: number[] = [];
  let inverse: THREE.Matrix4 | undefined;
  for (const id of [...ids].sort((a, b) => a - b)) {
    if (options.onlyIds && !options.onlyIds.has(id) || options.skipIds?.has(id)) continue;
    try {
    const entity = api.GetLine(model, id, false);
    const object: RegionalObject = { expressId: id, globalId: String(entity.GlobalId?.value ?? ''),
      ifcType: api.GetNameFromTypeCode(entity.type).toUpperCase(), name: String(entity.Name?.value ?? ''), bounds: [] };
    if (!object.globalId || !isRegionalConnectionObject(object)) continue;
    if (options.connectionEndpoints?.has(id)) object.connectionEndpoints = options.connectionEndpoints.get(id);
    const flat = api.GetFlatMesh(model, id);
    try {
      inverse ??= normalized ? new THREE.Matrix4().fromArray(api.GetCoordinationMatrix(model)).invert() : new THREE.Matrix4();
      let emitted = false;
      for (let part = 0; part < flat.geometries.size(); part++) {
        const placed = flat.geometries.get(part);
        const geometry = api.GetGeometry(model, placed.geometryExpressID);
        try {
          // Copy one bounded chunk before yielding: WASM views may detach on
          // a later allocation, and transferred arrays must not alias its heap.
          const count = geometry.GetIndexDataSize();
          const trianglesPerChunk = 3072;
          for (let start = 0, chunk = 0; start < count; start += trianglesPerChunk * 3, chunk++) {
            const source = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            const indices = api.GetIndexArray(geometry.GetIndexData(), count);
            const end = Math.min(count, start + trianglesPerChunk * 3);
            if ((end - start) % 3) throw Error(`Invalid connection triangles: ${id}`);
            const vertices = new Float32Array((end - start) * 6);
            for (let index = start; index < end; index++) {
              const offset = indices[index] * 6;
              if (offset + 6 > source.length) throw Error(`Invalid connection index: ${id}`);
              vertices.set(source.subarray(offset, offset + 6), (index - start) * 6);
            }
            if (!vertices.every(Number.isFinite)) throw Error(`Non-finite connection geometry: ${id}`);
            const matrix = inverse.clone().multiply(new THREE.Matrix4().fromArray(placed.flatTransformation)).toArray();
            const color = [placed.color.x, placed.color.y, placed.color.z, placed.color.w];
            const payload: ConnectionMeshChunk = { object, part, chunk, vertices, matrix, color,
              objectComplete: false };
            await enqueue(payload);
            emitted = true;
          }
        } finally { geometry.delete(); }
      }
      if (emitted) {
        await enqueue({ object, part: -1, chunk: 0,
          vertices: new Float32Array(), matrix: new THREE.Matrix4().toArray(), color: [1,1,1,1], objectComplete: true });
        objectCount++;
      }
    } finally { (flat as any).delete?.(); }
    } catch (error) { failedObjects.push(id); console.warn('[IFC connection source]', id, String(error)); }
  }
  await flush();
  await emit({ sequence: sequence++, objects: [], chunks: [], bytes: 0, final: true });
  return { objectCount: failedObjects.length ? -1 : objectCount, sequence, failedObjects };
}

export interface ConnectionGeometryArtifact {
  version: typeof CONNECTION_GEOMETRY_VERSION;
  batches: ConnectionGeometryBatch[];
  complete: { objectCount: number; sequence: number };
}
/** A receipt is published only for contiguous, final, complete source objects. */
export function validConnectionArtifact(value: ConnectionGeometryArtifact | null): value is ConnectionGeometryArtifact {
  if (!value || value.version !== CONNECTION_GEOMETRY_VERSION || !Array.isArray(value.batches) || !value.batches.length) return false;
  const ids = new Set<number>(), complete = new Set<number>(), chunks = new Set<string>();
  for (let index = 0; index < value.batches.length; index++) {
    const batch = value.batches[index];
    if (!batch || batch.sequence !== index || batch.final !== (index === value.batches.length - 1)
      || !Array.isArray(batch.chunks) || !Array.isArray(batch.objects) || batch.objects.length > IFC_CONNECTION_BATCH_MAX_OBJECTS) return false;
    let bytes = 0;
    for (const chunk of batch.chunks) {
      if (!chunk || !chunk.object || !Number.isInteger(chunk.object.expressId)
        || typeof chunk.object.globalId !== 'string' || typeof chunk.object.ifcType !== 'string' || typeof chunk.object.name !== 'string'
        || chunk.object.connectionEndpoints !== undefined && !validEndpointEvidence(chunk.object.connectionEndpoints)
        || !(chunk.vertices instanceof Float32Array) || chunk.vertices.length % 18 || !chunk.vertices.every(Number.isFinite)
        || !Array.isArray(chunk.matrix) || chunk.matrix.length !== 16 || !chunk.matrix.every(Number.isFinite)
        || !Array.isArray(chunk.color) || chunk.color.length !== 4 || !chunk.color.every(Number.isFinite)) return false;
      const key = `${chunk.object.expressId}:${chunk.part}:${chunk.chunk}`;
      if (chunks.has(key) || !chunk.object.globalId) return false;
      chunks.add(key);
      if (chunk.vertices.length) ids.add(chunk.object.expressId);
      if (chunk.objectComplete) {
        if (!ids.has(chunk.object.expressId)) return false;
        complete.add(chunk.object.expressId);
      }
      bytes += connectionChunkBytes(chunk);
    }
    if (bytes !== batch.bytes || bytes > IFC_CONNECTION_BATCH_MAX_BYTES) return false;
  }
  return value.complete?.sequence === value.batches.length && value.complete.objectCount === ids.size && ids.size === complete.size;
}
