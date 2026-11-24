import { Box3, Matrix4, Vector3 } from 'three';
import type { IfcAPI } from 'web-ifc';
import type { Vec3 } from '../../shared/viewerCommands.js';

export interface DoorMotionDescriptor {
  sourceId: string;
  leafRepresentationId: string;
  hingePosition: Vec3;
  hingeAxis: Vec3;
  openAngle: number;
  closedAngle: number;
  radius: number;
  closedTip: Vec3;
  evidence: string[];
}
type Ref = { value: number };
interface IfcDoorLine {
  type: number;
  expressID: number;
  Representation: Ref;
  Representations: Ref[];
  Items: Ref[];
  SweptArea: Ref;
  RepresentationIdentifier: { value: string };
  SenseAgreement: { value: boolean };
  BasisCurve: Ref;
  Trim1: Ref[];
  Trim2: Ref[];
  Position: Ref;
  Radius: Ref;
  ObjectPlacement?: Ref;
  PlacementRelTo?: Ref;
  RelativePlacement: Ref;
  Location: Ref;
  Axis?: Ref;
  RefDirection?: Ref;
  Coordinates: Ref[];
  DirectionRatios: Ref[];
}
const val = (x: { value?: number } | number) => Number(typeof x === 'object' ? x?.value : x);
const field = (x: { value?: string | boolean } | string | boolean) =>
  String(typeof x === 'object' ? x?.value : (x ?? ''));
/** Narrow authoring convention: an explicitly separate leaf, and its source swing arc.
 * Frames, compound doors, mapped/ambiguous plans and parameter-only trims remain static. */
export function readDoorMotion(
  api: IfcAPI,
  model: number,
  id: number,
  type: string,
  label: string,
  unit: number,
): DoorMotionDescriptor | undefined {
  if (
    !['IFCDOOR', 'IFCDOORSTANDARDCASE', 'IFCBUILDINGELEMENTPROXY'].includes(type) ||
    !/(建筑门扇|防火门扇|平开门扇|\bdoor\s*(leaf|panel)\b)/i.test(label) ||
    /柜|箱|frame|门框|cabinet/i.test(label) ||
    !(unit > 0)
  )
    return;
  const read = (ref: { value: number }) => api.GetLine(model, ref.value, false) as IfcDoorLine;
  const kind = (obj: { type: number }) => api.GetNameFromTypeCode(obj.type).toUpperCase();
  const vec = (values: Array<{ value: number }>) =>
    new Vector3(val(values[0]), val(values[1]), values.length > 2 ? val(values[2]) : 0);
  function placement(ref: { value: number }): Matrix4 {
    const axis = read(ref);
    const z = axis.Axis ? vec(read(axis.Axis).DirectionRatios).normalize() : new Vector3(0, 0, 1);
    const x = axis.RefDirection
      ? vec(read(axis.RefDirection).DirectionRatios).normalize()
      : new Vector3(1, 0, 0);
    const y = z.clone().cross(x).normalize();
    x.crossVectors(y, z);
    if (y.lengthSq() < 0.99) throw Error('无效门轴坐标');
    return new Matrix4()
      .makeBasis(x, y, z)
      .setPosition(vec(read(axis.Location).Coordinates).multiplyScalar(unit));
  }
  try {
    const leaf = read({ value: id }),
      reps = read(leaf.Representation).Representations.map(read);
    const body = reps.filter((r) => field(r.RepresentationIdentifier).toLowerCase() === 'body');
    const plan = reps.filter(
      (r) => field(r.RepresentationIdentifier).toLowerCase() === 'footprint',
    );
    if (body.length !== 1 || body[0].Items.length !== 1 || plan.length !== 1) return;
    const solid = read(body[0].Items[0]);
    if (
      kind(solid) !== 'IFCEXTRUDEDAREASOLID' ||
      kind(read(solid.SweptArea)) !== 'IFCRECTANGLEPROFILEDEF'
    )
      return;
    const arcs = plan[0].Items.map(read).filter((r) => kind(r) === 'IFCTRIMMEDCURVE');
    if (arcs.length !== 1) return;
    const arc = arcs[0],
      circle = read(arc.BasisCurve);
    if (kind(circle) !== 'IFCCIRCLE' || arc.Trim1.length !== 1 || arc.Trim2.length !== 1) return;
    const a = read(arc.Trim1[0]),
      b = read(arc.Trim2[0]);
    if (kind(a) !== 'IFCCARTESIANPOINT' || kind(b) !== 'IFCCARTESIANPOINT') return;
    const world = new Matrix4(),
      visited = new Set<number>();
    for (let ref = leaf.ObjectPlacement; ref;) {
      if (visited.has(ref.value)) return;
      visited.add(ref.value);
      const local = read(ref);
      if (kind(local) !== 'IFCLOCALPLACEMENT') return;
      world.premultiply(placement(local.RelativePlacement));
      ref = local.PlacementRelTo;
    }
    const base = placement(circle.Position),
      center = new Vector3().setFromMatrixPosition(base);
    const u = vec(a.Coordinates).multiplyScalar(unit).sub(center),
      v = vec(b.Coordinates).multiplyScalar(unit).sub(center);
    const radius = val(circle.Radius) * unit;
    if (
      radius < 0.4 ||
      radius > 4 ||
      Math.abs(u.length() - radius) > 0.01 ||
      Math.abs(v.length() - radius) > 0.01
    )
      return;
    const axis = new Vector3(0, 0, 1).transformDirection(base);
    const angle = Math.atan2(axis.dot(u.clone().cross(v)), u.dot(v));
    const sense = field(arc.SenseAgreement).toLowerCase();
    if (
      Math.abs(angle) < 0.1 ||
      Math.abs(angle) > Math.PI * 0.95 ||
      !['true', 't', 'false', 'f'].includes(sense) ||
      angle > 0 !== ['true', 't'].includes(sense)
    )
      return;
    axis.transformDirection(world);
    if (
      ![angle, radius, ...center.toArray(), ...world.elements, ...axis.toArray()].every(
        Number.isFinite,
      ) ||
      Math.abs(axis.z) < 0.999
    )
      return;
    return {
      sourceId: String(id),
      leafRepresentationId: String(body[0].Items[0].value),
      closedTip: u.add(center).applyMatrix4(world).toArray(),
      hingePosition: center.applyMatrix4(world).toArray(),
      hingeAxis: axis.toArray(),
      closedAngle: 0,
      openAngle: angle,
      radius,
      evidence: [type, label, 'Body #' + body[0].expressID, 'FootPrint #' + arc.expressID],
    };
  } catch {
    return;
  }
}
export function doorTransform(d: DoorMotionDescriptor, angle: number) {
  const [x, y, z] = d.hingePosition;
  return new Matrix4()
    .makeTranslation(x, y, z)
    .multiply(new Matrix4().makeRotationAxis(new Vector3(...d.hingeAxis), angle))
    .multiply(new Matrix4().makeTranslation(-x, -y, -z));
}
export function doorRange(d: DoorMotionDescriptor, closed: Box3) {
  const h = d.hingePosition,
    r = d.radius + 0.15;
  return new Box3(
    new Vector3(h[0] - r, h[1] - r, closed.min.z),
    new Vector3(h[0] + r, h[1] + r, closed.max.z),
  );
}
