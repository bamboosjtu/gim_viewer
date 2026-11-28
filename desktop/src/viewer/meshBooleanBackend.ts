import * as THREE from 'three';
import { ADDITION, INTERSECTION, SUBTRACTION, Brush, Evaluator } from 'three-bvh-csg';
import type { MeshData, SyncBooleanBackend } from '@gim/gim-sdk/geometry';
import { geometryFromMeshData } from './geometryBatch.js';

function floats(geometry: THREE.BufferGeometry, name: string, size: number) {
  const attr = geometry.getAttribute(name);
  if (attr instanceof THREE.BufferAttribute && attr.array instanceof Float32Array)
    return attr.array;
  const out = new Float32Array(attr.count * size);
  for (let i = 0; i < attr.count; i++) {
    out[i * size] = attr.getX(i);
    out[i * size + 1] = attr.getY(i);
    if (size === 3) out[i * size + 2] = attr.getZ(i);
  }
  return out;
}
export function readBooleanMesh(geometry: THREE.BufferGeometry): MeshData {
  const index = geometry.index?.array;
  return {
    positions: floats(geometry, 'position', 3),
    normals: floats(geometry, 'normal', 3),
    indices:
      index instanceof Uint32Array || index instanceof Uint16Array
        ? index
        : index
          ? Uint32Array.from(index)
          : undefined,
    uvs: geometry.hasAttribute('uv') ? floats(geometry, 'uv', 2) : undefined,
  };
}
const codes = { union: ADDITION, intersection: INTERSECTION, difference: SUBTRACTION };
export function createMeshBooleanBackend(onEvaluation?: (ms: number) => void): SyncBooleanBackend {
  let evaluator: Evaluator | undefined;
  return {
    backendId: 'three-bvh-csg',
    version: '0.0.18',
    evaluate({ operation, operands }) {
      const started = performance.now();
      // Brush preparation may replace indices and annotate attributes. Each brush owns its working geometry.
      const [a, b] = operands.map((mesh) =>
        geometryFromMeshData({ ...mesh, indices: mesh.indices?.slice() }),
      );
      let output: THREE.BufferGeometry | undefined;
      try {
        evaluator ??= new Evaluator();
        output = evaluator.evaluate(new Brush(a), new Brush(b), codes[operation]).geometry;
        const count = output.index?.count ?? output.getAttribute('position')?.count;
        if (count === 0) return { status: 'empty', diagnostics: [] };
        if (!count) throw Error('Missing Boolean surface');
        return { status: 'success', mesh: readBooleanMesh(output), diagnostics: [] };
      } finally {
        output?.dispose();
        a.dispose();
        b.dispose();
        onEvaluation?.(performance.now() - started);
      }
    },
  };
}
