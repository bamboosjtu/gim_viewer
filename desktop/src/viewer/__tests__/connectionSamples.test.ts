// @vitest-environment node
import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { CONNECTION_GEOMETRY_VERSION, streamConnectionGeometry, validConnectionArtifact,
  type ConnectionGeometryBatch } from '../ifcConnectionBatches.js';

const source = resolve('../demo/demo-substation/DEV/一次设备0402其他.ifc');
// Explicit fixture identity only. Production classification never uses this filename.
it.skipIf(!existsSync(source))('substation01 source mesh chunks retain geometry and normalized/un-normalized coordinates', async () => {
  const bytes = readFileSync(source);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('1f4c0c5f093f524a3b2056d776928f4b80462800ce7d95264e79652366a21673');
  const { IfcAPI } = createRequire(import.meta.url)('web-ifc');
  const positions: number[][] = [], identities: string[][] = [];
  for (const normalized of [false, true]) {
    const api = new IfcAPI();
    api.SetWasmPath(resolve('node_modules/web-ifc') + '/', true);
    await api.Init();
    try {
      const model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: normalized });
      const batches: ConnectionGeometryBatch[] = [], points: number[] = [], ids = new Set<string>();
      const point = new THREE.Vector3();
      const complete = await streamConnectionGeometry(api, model, normalized, async batch => {
        batches.push(batch);
        for (const chunk of batch.chunks ?? []) {
          ids.add(chunk.object.globalId);
          const matrix = new THREE.Matrix4().fromArray(chunk.matrix);
          for (let i = 0; i < chunk.vertices.length; i += 6) {
            point.set(chunk.vertices[i], chunk.vertices[i+1], chunk.vertices[i+2]).applyMatrix4(matrix);
            points.push(...point.toArray());
          }
        }
      });
      expect(complete.failedObjects).toEqual([]);
      expect(complete.objectCount).toBe(299);
      expect(batches.length).toBeLessThan(50);
      console.log(JSON.stringify({normalized,objects:complete.objectCount,batches:batches.length,
        chunks:batches.reduce((sum,batch)=>sum+(batch.chunks?.length??0),0)}));
      expect(validConnectionArtifact({ version: CONNECTION_GEOMETRY_VERSION, batches, complete })).toBe(true);
      expect(points.length / 3).toBe(965946);
      identities.push([...ids].sort()); positions.push(points);
    } finally { api.Dispose(); }
  }
  expect(identities[0]).toEqual(identities[1]);
  expect(positions[0].length).toBe(positions[1].length);
  let maxDelta = 0;
  for (let i = 0; i < positions[0].length; i++) maxDelta = Math.max(maxDelta, Math.abs(positions[0][i]-positions[1][i]));
  expect(maxDelta).toBeLessThan(1e-6);
}, 60000);
