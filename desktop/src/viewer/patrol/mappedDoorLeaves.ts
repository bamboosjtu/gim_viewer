import { Box3, Matrix4, Triangle, Vector3 } from 'three';
import type { ObjectFinePart } from '../ifcObjectFineData.js';
import type { DoorMotionDescriptor } from './doorMotion.js';

export interface MappedDoorLeaf {
  parts: number[];
  bounds: number[];
  motion: DoorMotionDescriptor;
}
const zUp = new Matrix4().makeRotationX(Math.PI / 2);
function partShape(part: ObjectFinePart, index: number) {
  const transform = zUp.clone().multiply(new Matrix4().fromArray(part.matrix)),
    box = new Box3(),
    vertices: Vector3[] = [];
  for (let i = 0; i < part.vertices.length; i += 6) {
    const p = new Vector3().fromArray(part.vertices, i).applyMatrix4(transform);
    vertices.push(p);
    box.expandByPoint(p);
  }
  const center = box.getCenter(new Vector3()),
    size = box.getSize(new Vector3());
  return { index, box, center, size, vertices, indices: part.indices };
}
type Shape = ReturnType<typeof partShape>;
function panel(shape: Shape) {
  const { vertices, box, indices } = shape;
  if (box.isEmpty() || shape.size.z < 1.6 || shape.size.z > 6) return;
  const axis = new Vector3();
  // Choose the longest horizontal mesh edge as panel width (a diagonal includes its thickness).
  let longest = 0;
  for (let i = 0; i < indices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = vertices[indices[i + k]],
        b = vertices[indices[i + ((k + 1) % 3)]];
      if (Math.abs(a.z - b.z) > 0.002) continue;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length > longest) {
        longest = length;
        axis.subVectors(b, a).setZ(0).normalize();
      }
    }
  }
  const across = new Vector3(-axis.y, axis.x, 0);
  let min = Infinity,
    max = -Infinity,
    t0 = Infinity,
    t1 = -Infinity;
  for (const v of vertices) {
    const u = v.dot(axis),
      t = v.dot(across);
    min = Math.min(min, u);
    max = Math.max(max, u);
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
  }
  const width = max - min,
    thickness = t1 - t0;
  if (width < 0.55 || width > 6 || thickness < 0.005 || thickness > Math.min(0.25, width * 0.25))
    return;
  // A closed panel covers its centre. Keep hollow jambs and frames in the static collision mesh.
  const targets = [0.25, 0.5, 0.75].flatMap((u) =>
    [0.3, 0.7].map((z) => new Vector3(min + width * u, box.min.z + shape.size.z * z, 0)),
  );
  const projected = (v: Vector3) => new Vector3(v.dot(axis), v.z, 0);
  const triangles: Triangle[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const tri = new Triangle(
      projected(vertices[indices[i]]),
      projected(vertices[indices[i + 1]]),
      projected(vertices[indices[i + 2]]),
    );
    if (tri.getArea() > 1e-6) triangles.push(tri);
  }
  if (!targets.every((p) => triangles.some((t) => t.containsPoint(p)))) return;
  const end = (u: number) =>
    axis
      .clone()
      .multiplyScalar(u)
      .addScaledVector(across, (t0 + t1) / 2)
      .setZ(box.min.z);
  return { shape, width, left: end(min), right: end(max) };
}
export function canInspectDoorPanels(type: string, label: string) {
  return (
    /^(IFCDOOR(?:STANDARDCASE)?|IFCBUILDINGELEMENTPROXY|IFCGATE)$/.test(type) &&
    (/平开大门|swing gate/i.test(label) ||
      (/^IFCDOOR/.test(type) && /嵌板木门|单扇|双扇|single.leaf|double.leaf/i.test(label)))
  );
}
/** Resolve only a separately identifiable panel of this product. The swing is a browsing approximation. */
export function mappedDoorLeaves(
  type: string,
  label: string,
  parts: readonly ObjectFinePart[],
): MappedDoorLeaf[] {
  const gate = /平开大门|swing gate/i.test(label);
  if (!canInspectDoorPanels(type, label)) return [];
  const shapes = parts.map(partShape),
    candidates = shapes.map(panel).filter((p) => p !== undefined);
  // Rebated frames can have broad face plates. A door panel lies between the larger trim faces.
  const panels = gate
    ? candidates
    : candidates.filter(
        (p) =>
          !candidates.some(
            (q) => q !== p && q.width < p.width - 0.04 && q.shape.size.z < p.shape.size.z - 0.025,
          ),
      );

  if (!panels.length || panels.length > 2 || (gate && panels.length !== 2)) return [];
  if (panels.length === 2) {
    const [a, b] = panels,
      along = a.right.clone().sub(a.left).normalize(),
      alongB = b.right.clone().sub(b.left).normalize();
    if (
      Math.abs(along.dot(alongB)) < 0.99 ||
      Math.abs(a.shape.box.min.z - b.shape.box.min.z) > 0.04 ||
      Math.abs(a.shape.size.z - b.shape.size.z) > 0.08
    )
      return [];
  }
  const result: MappedDoorLeaf[] = [];
  for (const p of panels) {
    const others = shapes.filter(
      (s) =>
        s !== p.shape &&
        s.size.z < 0.4 &&
        s.size.x < 0.45 &&
        s.size.y < 0.45 &&
        s.center.z > p.shape.box.min.z + 0.35 &&
        s.center.z < p.shape.box.max.z - 0.15 &&
        p.shape.box.distanceToPoint(s.center) < 0.18 &&
        panels.every(
          (q) =>
            q === p ||
            p.shape.center.distanceToSquared(s.center) < q.shape.center.distanceToSquared(s.center),
        ),
    );
    const peer = panels.find((q) => q !== p);
    const reference = peer?.shape.center ?? others[0]?.center;
    if (!reference) return [];
    const hinge =
        p.left.distanceToSquared(reference) > p.right.distanceToSquared(reference)
          ? p.left
          : p.right,
      tip = hinge === p.left ? p.right : p.left;
    if (peer && Math.min(peer.left.distanceTo(tip), peer.right.distanceTo(tip)) > 0.18) return [];
    const box = p.shape.box.clone();
    for (const s of others) box.union(s.box);
    result.push({
      parts: [p.shape.index, ...others.map((s) => s.index)],
      bounds: [...box.min.toArray(), ...box.max.toArray()],
      motion: {
        sourceId: '',
        leafRepresentationId: String(parts[p.shape.index].geometryId ?? p.shape.index),
        hingePosition: hinge.toArray(),
        closedTip: tip.toArray(),
        hingeAxis: [0, 0, 1],
        radius: p.width,
        closedAngle: 0,
        openAngle: Math.PI / 2,
        evidence: [
          'same-product-panel',
          gate ? 'paired-swing-gate' : 'latch-opposite-edge',
          'preview-swing',
        ],
      },
    });
  }
  return result;
}
