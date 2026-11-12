import * as THREE from 'three';

// Same station-scale extent limit used by the scene admission guard. A
// template's extent is independent of the IFC/project translation anchor.
export const GEOMETRY_MAX_EXTENT_M = 500;
export const STL_SOURCE_ENVELOPE_KEY = '__gimStlSourceEnvelope';
export interface StlSourceEnvelope {
  kind: 'binary-stl-source-v1';
  path: string;
  sha256: string;
  triangles: number;
  /** Independently scanned source vertices with the real DEV/PHM placement, metres. */
  bounds: number[];
}
const verifiedEnvelopes = new WeakMap<THREE.Object3D, string>();
function envelopeOwner(object: THREE.Object3D): THREE.Object3D {
  while (!object.userData[STL_SOURCE_ENVELOPE_KEY] && object.children.length === 1) object = object.children[0];
  return object;
}
export function stlSourceEnvelopeProof(object: THREE.Object3D): StlSourceEnvelope | undefined {
  return envelopeOwner(object).userData[STL_SOURCE_ENVELOPE_KEY];
}
/** Only the source compiler or a verifier comparing current source bytes may call this. */
export function acceptVerifiedStlSourceEnvelope(object: THREE.Object3D): void {
  const owner=envelopeOwner(object),proof=stlSourceEnvelopeProof(object);
  if(proof)verifiedEnvelopes.set(owner,JSON.stringify(proof));
}
export function copyVerifiedStlSourceEnvelope(source: THREE.Object3D, target: THREE.Object3D): void {
  const owner=envelopeOwner(source),proof=stlSourceEnvelopeProof(source);
  if(proof&&verifiedEnvelopes.get(owner)===JSON.stringify(proof)
    &&JSON.stringify(stlSourceEnvelopeProof(target))===JSON.stringify(proof))acceptVerifiedStlSourceEnvelope(target);
}

/** Large source meshes need an explicit source envelope and millimetre
 * Float32 spacing. A finite but astronomical mesh never obtains this escape. */
function preciseBounds(box: THREE.Box3): boolean {
  const values = [...box.min.toArray(), ...box.max.toArray()];
  if (box.isEmpty() || !values.every(Number.isFinite)) return false;
  const magnitude = Math.max(...values.map(Math.abs));
  return magnitude === 0 || 2 ** (Math.floor(Math.log2(magnitude)) - 23) <= 0.001;
}

export function stlSourceEnvelope(object: THREE.Object3D): THREE.Box3 | undefined {
  const owner = envelopeOwner(object);
  const proof = owner.userData[STL_SOURCE_ENVELOPE_KEY] as StlSourceEnvelope | undefined;
  if (!proof || verifiedEnvelopes.get(owner)!==JSON.stringify(proof)
    || proof.kind !== 'binary-stl-source-v1' || typeof proof.path !== 'string'
    || !/\.stl$/i.test(proof.path) || !/^[a-f0-9]{64}$/.test(proof.sha256)
    || !Number.isSafeInteger(proof.triangles) || proof.triangles <= 0 || proof.triangles > 5_000_000
    || !Array.isArray(proof.bounds) || proof.bounds.length !== 6 || !proof.bounds.every(Number.isFinite)) return;
  let meshes = 0, triangles = 0;
  object.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) { meshes++; triangles += (mesh.geometry?.index?.count ?? mesh.geometry?.getAttribute('position')?.count ?? 0) / 3; }
  });
  if (meshes !== 1 || triangles !== proof.triangles) return;
  const box = new THREE.Box3(new THREE.Vector3().fromArray(proof.bounds), new THREE.Vector3().fromArray(proof.bounds, 3));
  if(!preciseBounds(box))return;
  owner.updateWorldMatrix(true,false);
  return owner.parent ? box.applyMatrix4(owner.parent.matrixWorld) : box;
}

export function invalidGeometryBounds(box: THREE.Box3, sourceEnvelope?: THREE.Box3): string | null {
  if (box.isEmpty()) return 'empty-bounds';
  const values = [...box.min.toArray(), ...box.max.toArray()];
  if (!values.every(Number.isFinite)) return 'non-finite-bounds';
  const size = box.getSize(new THREE.Vector3()).toArray();
  if (Math.max(...size) <= GEOMETRY_MAX_EXTENT_M) return null;
  const expected = sourceEnvelope ? [...sourceEnvelope.min.toArray(), ...sourceEnvelope.max.toArray()] : [];
  if (sourceEnvelope && preciseBounds(sourceEnvelope) && preciseBounds(box)
    && values.every((value, index) => Math.abs(value - expected[index]) <= 0.001)) return null;
  return `extent-exceeds-${GEOMETRY_MAX_EXTENT_M}m: ${size.join(',')}`;
}

export function invalidGeometryExtent(object: THREE.Object3D): string | null {
  const box = new THREE.Box3().setFromObject(object);
  return invalidGeometryBounds(box, stlSourceEnvelope(object));
}
