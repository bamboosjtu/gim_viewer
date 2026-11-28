/** DEV/PHM STL adapter. The SDK owns format detection and facet decoding. */
import * as THREE from 'three';
import { geometryFromMeshData } from './geometryBatch.js';
import { decodeStl } from '../gim/geometry/stlSource.js';

function stlGroup(buffer: ArrayBuffer, path: string, format?: 'ascii'): THREE.Group | null {
  const result = decodeStl(buffer, format ? { format } : {});
  if (!result.mesh) return null;
  const group = new THREE.Group();
  group.name = path;
  // Auto-detection also serves DEV assembly, which distinguishes empty sources from decode errors.
  if (result.status === 'empty') return format === 'ascii' ? null : group;
  const geometry = geometryFromMeshData(result.mesh, false);
  // This decoder transfers exclusive local buffers to the existing metre-based GLB path.
  geometry.scale(0.001, 0.001, 0.001);
  const material = stlMaterial(result.format);
  group.add(new THREE.Mesh(geometry, material));
  return group;
}

export function stlMaterial(format: 'ascii' | 'binary') {
  const props = { color: 0xcccccc, side: THREE.DoubleSide, flatShading: false };
  return format === 'ascii'
    ? new THREE.MeshStandardMaterial(props)
    : new THREE.MeshPhongMaterial({ ...props, specular: 0x111111, shininess: 30 });
}

export function parseStlBinary(buffer: ArrayBuffer, stlPath: string): THREE.Group | null {
  return stlGroup(buffer, stlPath);
}
export function parseStlAscii(buffer: ArrayBuffer, stlPath: string): THREE.Group | null {
  return stlGroup(buffer, stlPath, 'ascii');
}

/**
 * 释放 STL Group 的 GPU 资源（geometry + material）。
 *
 * 由 projectCleanupService 在切换项目时调用。
 * 调用前需已从 scene 移除（scene.remove(group)）。
 */
export function disposeStlGroup(
  group: THREE.Group,
  disposed = new Set<THREE.BufferGeometry | THREE.Material>(),
): void {
  const release = (item: THREE.BufferGeometry | THREE.Material) => {
    if (!disposed.has(item)) {
      disposed.add(item);
      item.dispose();
    }
  };
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      release(mesh.geometry);
    }
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      material.forEach(release);
    } else if (material) {
      release(material);
    }
  });
}
