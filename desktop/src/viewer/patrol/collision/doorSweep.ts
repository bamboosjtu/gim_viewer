import { Box3, Matrix4, Triangle, Vector3 } from 'three';
import {
  bodyHits,
  triangleDistanceSquared,
  supportHeight,
  visitTriangles,
  type PlacedAsset,
} from './patrolGeometry.js';
import { doorTransform, type DoorMotionDescriptor } from '../doorMotion.js';
export type DoorObstruction = { kind: 'person' } | { kind: 'obstacle'; id: string };
export async function doorSweepObstruction(
  descriptor: DoorMotionDescriptor,
  closed: Matrix4,
  box: Box3,
  leaf: PlacedAsset,
  objects: ReadonlyMap<string, PlacedAsset>,
  feet: Vector3,
  signal: AbortSignal,
): Promise<DoorObstruction | undefined> {
  const angle = descriptor.openAngle,
    segments = Math.max(1, Math.ceil((Math.abs(angle) * descriptor.radius) / 0.025));
  const margin = ((descriptor.radius + 0.16) * Math.abs(angle)) / (2 * segments);
  const hinge = new Vector3(...descriptor.hingePosition),
    along = new Vector3(...descriptor.closedTip).sub(hinge).setZ(0).normalize();
  const alongAt = (v: Vector3) => (v.x - hinge.x) * along.x + (v.y - hinge.y) * along.y;
  const preview = descriptor.evidence.includes('preview-swing');
  const split = leaf.id.lastIndexOf('/leaf/'),
    owner = split < 0 ? leaf.id : leaf.id.slice(0, split);
  const parentParts = new Set(
    [...objects.keys()].filter((id) => id === owner || id.startsWith(owner + '/leaf/')),
  );
  let obstruction: DoorObstruction | undefined;
  let threshold = hinge.z;
  if (preview) {
    const tip = new Vector3(...descriptor.closedTip),
      thresholdBox = new Box3().setFromPoints([hinge, tip]).expandByScalar(0.15);
    for (const other of objects.values())
      if (other.support)
        visitTriangles(other, thresholdBox, (t) => {
          for (const u of [0, 0.25, 0.5, 0.75, 1]) {
            const h = supportHeight(t, hinge.clone().lerp(tip, u), 0.15, 0.12);
            if (h !== undefined) threshold = Math.max(threshold, h);
          }
          return false;
        });
  }
  // Each intermediate triangle is expanded by a bound on its angular displacement between samples.
  let slice = performance.now();
  for (let k = 0; k < segments; k++) {
    if (performance.now() - slice >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      slice = performance.now();
    }
    signal.throwIfAborted();
    const delta = doorTransform(descriptor, (angle * (k + 0.5)) / segments).multiply(closed);
    const toClosed = doorTransform(descriptor, (-angle * (k + 0.5)) / segments);
    const sampled = { ...leaf, matrix: delta, inverse: delta.clone().invert() };
    if (
      visitTriangles(sampled, box, (t) => {
        if (bodyHits(t, feet, feet, margin)) {
          obstruction = { kind: 'person' };
          return true;
        }
        const region = new Box3().setFromPoints([t.a, t.b, t.c]).expandByScalar(margin);
        const original = t.clone();
        original.a.applyMatrix4(toClosed);
        original.b.applyMatrix4(toClosed);
        original.c.applyMatrix4(toClosed);
        for (const other of objects.values()) {
          if (other.id === leaf.id) continue;
          if (
            visitTriangles(other, region, (b: Triangle) => {
              if (
                Math.max(b.a.z, b.b.z, b.c.z) <= box.min.z + 1e-5 ||
                Math.min(b.a.z, b.b.z, b.c.z) >= box.max.z - 1e-5
              )
                return false;
              if (triangleDistanceSquared(t, b) > margin * margin) return false;
              // A horizontal slab can already intersect the authored bottom of a preview leaf;
              // swinging around Z cannot change that elevation. Keep raised obstacles solid.
              if (preview && other.support && Math.max(b.a.z, b.b.z, b.c.z) <= threshold + 0.01)
                return false;
              if (preview) {
                const u = [alongAt(b.a), alongAt(b.b), alongAt(b.c)];
                const atEdge = Math.max(...u) < 0.09 || Math.min(...u) > descriptor.radius - 0.09;
                if (
                  atEdge &&
                  (parentParts.has(other.id) ||
                    triangleDistanceSquared(original, b) <= (margin + 0.012) ** 2)
                )
                  return false;
              }
              return true;
            })
          ) {
            obstruction = { kind: 'obstacle', id: other.id };
            return true;
          }
        }
        return false;
      })
    )
      return obstruction;
  }
  return undefined;
}
