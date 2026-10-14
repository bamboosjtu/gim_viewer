import * as THREE from 'three';

interface CoordinateModel {
  getCoordinates?: () => Promise<number[]>;
  getCoordinationMatrix: () => Promise<THREE.Matrix4>;
}
const anchors = new WeakMap<CoordinateModel, Promise<THREE.Matrix4>>();
/** Fragments caches an identity Matrix4 before its first asynchronous coordinates
 * query completes. Read public coordinates directly; identity itself is valid. */
export async function readIfcCoordinateAnchor(model: CoordinateModel): Promise<THREE.Matrix4> {
  let pending = anchors.get(model);
  if (!pending) {
    pending = (async () => {
      if (!model.getCoordinates) return (await model.getCoordinationMatrix()).clone();
      const values = await model.getCoordinates();
      if (values.length !== 9 || !values.every(Number.isFinite)) throw Error('Invalid IFC coordinates');
      const [x, y, z, xx, xy, xz, yx, yy, yz] = values;
      const zDir = new THREE.Vector3(xx, xy, xz).cross(new THREE.Vector3(yx, yy, yz));
      const matrix = new THREE.Matrix4().set(xx, yx, zDir.x, x, xy, yy, zDir.y, y, xz, yz, zDir.z, z, 0, 0, 0, 1);
      if (Math.abs(matrix.determinant()) < 1e-12) throw Error('Singular IFC coordinate anchor');
      return matrix;
    })();
    anchors.set(model, pending);
    void pending.catch(() => { if (anchors.get(model) === pending) anchors.delete(model); });
  }
  return (await pending).clone();
}
