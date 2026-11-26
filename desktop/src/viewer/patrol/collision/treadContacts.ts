import { Triangle, Vector3 } from 'three';
import { patrolProfile as profile } from '../navigationQueryPort.js';
import { supportHeight } from './patrolGeometry.js';

const tolerance = 1e-5;
type Edge = [Vector3, Vector3];
const points = (t: Triangle) => [t.a, t.b, t.c];
const edges = (t: Triangle): Edge[] => [
  [t.a, t.b],
  [t.b, t.c],
  [t.c, t.a],
];
const minUp = Math.cos((profile.maxSlopeDegrees * Math.PI) / 180);
const sameXY = (a: Vector3, b: Vector3) =>
  Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

/** A riser must reach the tread and project entirely onto its measured edge. */
function isRiserBelow(t: Triangle, [a, b]: Edge) {
  const top = Math.max(t.a.z, t.b.z, t.c.z);
  if (Math.abs(top - a.z) > tolerance || Math.min(t.a.z, t.b.z, t.c.z) >= top - tolerance)
    return false;
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = Math.hypot(dx, dy);
  if (length <= tolerance) return false;
  return points(t).every((p) => {
    const x = p.x - a.x,
      y = p.y - a.y,
      along = (x * dx + y * dy) / length;
    return (
      along >= -tolerance &&
      along <= length + tolerance &&
      Math.abs(x * dy - y * dx) <= tolerance * length
    );
  });
}

/** Evidence for contact with a reachable tread, scoped to one placed support mesh. */
export class TreadContacts {
  readonly faces = new Set<number>();
  private readonly rim: Edge[] = [];
  private readonly lids: Triangle[] = [];
  private readonly adjacent: Triangle[] = [];
  private readonly sides: Triangle[] = [];
  private readonly bottoms: { edge: Edge; top: number }[] = [];
  private readonly projected = new Triangle();
  private readonly center = new Vector3();
  private readonly nearest = new Vector3();

  private underFoot(t: Triangle, foot: Vector3) {
    this.projected.a.copy(t.a).setZ(0);
    this.projected.b.copy(t.b).setZ(0);
    this.projected.c.copy(t.c).setZ(0);
    this.center.copy(foot).setZ(0);
    this.projected.closestPointToPoint(this.center, this.nearest);
    return (
      this.nearest.distanceToSquared(this.center) <= profile.radius ** 2 &&
      supportHeight(t, this.nearest.setZ(foot.z)) !== undefined
    );
  }

  observe(t: Triangle, index: number, centerSupported: boolean, from: Vector3, to: Vector3) {
    const lo = Math.min(t.a.z, t.b.z, t.c.z),
      hi = Math.max(t.a.z, t.b.z, t.c.z);
    if (lo > from.z + profile.stepUp + tolerance || hi < from.z - profile.stepDown - tolerance)
      return;
    const up = t.getNormal(this.nearest).z;
    if (Math.abs(up) < tolerance && hi - lo > tolerance) {
      this.sides.push(t.clone());
      return;
    }
    if (up < minUp) return;
    const reached = centerSupported || this.underFoot(t, to) || this.underFoot(t, from);
    if (reached) this.faces.add(index);
    if (hi - lo > tolerance) return;
    const cap = t.clone();
    if (reached) {
      this.rim.push(...edges(cap));
      this.lids.push(cap);
    } else this.adjacent.push(cap);
  }

  connect() {
    if (!this.rim.length || !this.sides.length) return;
    // Opposite surfaces of a solid tread can use different triangulation diagonals.
    const reached = this.rim.slice();
    for (const cap of this.adjacent) {
      const vertices = points(cap);
      if (
        reached.some(
          ([a, b]) =>
            Math.abs(a.z - cap.a.z) <= tolerance &&
            vertices.some((p) => sameXY(p, a)) &&
            vertices.some((p) => sameXY(p, b)),
        )
      ) {
        this.rim.push(...edges(cap));
        this.lids.push(cap);
      }
    }
    for (const side of this.sides) {
      const bottom = Math.min(side.a.z, side.b.z, side.c.z);
      const lower = points(side).filter((p) => Math.abs(p.z - bottom) <= tolerance);
      if (lower.length !== 2) continue;
      const rim = this.rim.find((edge) => isRiserBelow(side, edge));
      if (rim) this.bottoms.push({ edge: [lower[0], lower[1]], top: rim[0].z });
    }
  }

  allowsContact(t: Triangle) {
    if (
      this.rim.some((edge) => isRiserBelow(t, edge)) ||
      this.bottoms.some((b) => isRiserBelow(t, b.edge))
    )
      return true;
    const z = t.a.z;
    if (
      Math.abs(t.b.z - z) > tolerance ||
      Math.abs(t.c.z - z) > tolerance ||
      t.getNormal(this.nearest).z >= 0
    )
      return false;
    const vertices = points(t);
    // The underside of a projecting nosing must share a skirt edge and lie under its lid.
    return this.bottoms.some(
      ({ edge: [a, b], top }) =>
        Math.abs(a.z - z) <= tolerance &&
        top - z <= profile.stepUp &&
        vertices.some((p) => sameXY(p, a)) &&
        vertices.some((p) => sameXY(p, b)) &&
        vertices.every((p) =>
          this.lids.some(
            (lid) =>
              Math.abs(lid.a.z - top) <= tolerance &&
              supportHeight(lid, this.nearest.copy(p).setZ(lid.a.z), 0, 0) !== undefined,
          ),
        ),
    );
  }
}
