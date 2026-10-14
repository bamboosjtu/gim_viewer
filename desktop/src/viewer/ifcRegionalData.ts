import * as THREE from 'three';
import { IFCPROJECT, IFCRELVOIDSELEMENT, type IfcAPI } from 'web-ifc';
export interface RegionalObject {
  expressId: number;
  globalId: string;
  ifcType: string;
  name: string;
  bounds: number[];
}
export interface OpeningRelation {
  id: number;
  host: number;
  opening: number;
}
export interface RegionalIndex {
  objects: RegionalObject[];
  openingRelations: OpeningRelation[];
  unitScale: number;
  sourceSha256?: string;
}
export function readRegionalSemantics(
  api: IfcAPI,
  model: number
): Pick<RegionalIndex, 'openingRelations' | 'unitScale'> {
  const ref = (v: any) => Number(v?.value ?? v),
    text = (v: any) => String(v?.value ?? v ?? ''),
    line = (v: any) => api.GetLine(model, ref(v), false);
  const openingRelations: OpeningRelation[] = [],
    ids = api.GetLineIDsWithType(model, IFCRELVOIDSELEMENT);
  try {
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i),
        r = line(id);
      openingRelations.push({
        id,
        host: ref(r.RelatingBuildingElement),
        opening: ref(r.RelatedOpeningElement),
      });
    }
  } finally {
    (ids as any).delete?.();
  }
  const unit = (u: any, depth = 0): number => {
    if (depth > 8) return NaN;
    const kind = api.GetNameFromTypeCode(u.type).toUpperCase();
    if (kind === 'IFCSIUNIT' && text(u.Name) === 'METRE')
      return (
        (
          {
            '': 1,
            MILLI: 0.001,
            CENTI: 0.01,
            DECI: 0.1,
            MICRO: 1e-6,
            KILO: 1000,
          } as Record<string, number>
        )[text(u.Prefix)] ?? NaN
      );
    if (kind === 'IFCCONVERSIONBASEDUNIT') {
      const conversion = line(u.ConversionFactor);
      return (
        ref(conversion.ValueComponent) *
        unit(line(conversion.UnitComponent), depth + 1)
      );
    }
    return NaN;
  };
  const projects = api.GetLineIDsWithType(model, IFCPROJECT);
  let unitScale = NaN;
  try {
    if (projects.size() === 1) {
      const p = line(projects.get(0)),
        lengths = line(p.UnitsInContext)
          .Units.map((u: any) => line(u))
          .filter((u: any) => text(u.UnitType) === 'LENGTHUNIT');
      if (lengths.length === 1) unitScale = unit(lengths[0]);
    }
  } finally {
    (projects as any).delete?.();
  }
  return { openingRelations, unitScale };
}
/** Bounds are in web-ifc absolute Y-up metres, exactly like GetFlatMesh output.
 * Shared geometry templates are inspected once, including fastener templates;
 * this index never creates or uploads a fastener render model. */
export class RegionalIndexCollector {
  readonly objects: RegionalObject[] = [];
  private seen = new Set<number>();
  private geometryBoxes = new Map<number, THREE.Box3>();
  private sourceInverse: THREE.Matrix4 | null = null;
  constructor(
    private api: IfcAPI,
    private model: number,
    private normalized = false
  ) {}
  observe = (flat: import('web-ifc').FlatMesh): void => {
    const id = flat.expressID;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    const entity = this.api.GetLine(this.model, id, false),
      bounds = new THREE.Box3();
    if (!entity.GlobalId?.value) return;
    // web-ifc has already selected its origin before emitting the first mesh.
    this.sourceInverse ??= this.normalized
      ? new THREE.Matrix4()
          .fromArray(this.api.GetCoordinationMatrix(this.model))
          .invert()
      : new THREE.Matrix4();
    const point = new THREE.Vector3();
    for (let i = 0; i < flat.geometries.size(); i++) {
      const placed = flat.geometries.get(i);
      let box = this.geometryBoxes.get(placed.geometryExpressID);
      if (!box) {
        const geometry = this.api.GetGeometry(
          this.model,
          placed.geometryExpressID
        );
        try {
          const v = this.api.GetVertexArray(
            geometry.GetVertexData(),
            geometry.GetVertexDataSize()
          );
          box = new THREE.Box3();
          for (let j = 0; j < v.length; j += 6)
            box.expandByPoint(point.set(v[j], v[j + 1], v[j + 2]));
          this.geometryBoxes.set(placed.geometryExpressID, box);
        } finally {
          geometry.delete();
        }
      }
      bounds.union(
        box
          .clone()
          .applyMatrix4(
            this.sourceInverse
              .clone()
              .multiply(
                new THREE.Matrix4().fromArray(placed.flatTransformation)
              )
          )
      );
    }
    if (!bounds.isEmpty())
      this.objects.push({
        expressId: id,
        globalId: String(entity.GlobalId.value),
        ifcType: this.api.GetNameFromTypeCode(entity.type).toUpperCase(),
        name: String(entity.Name?.value ?? ''),
        bounds: [...bounds.min.toArray(), ...bounds.max.toArray()],
      });
  };
  finish(
    semantics: Pick<RegionalIndex, 'openingRelations' | 'unitScale'>
  ): RegionalIndex {
    // Include types omitted by the far importer, including all fasteners.
    // Already observed products return before any entity/vertex reads.
    this.api.StreamAllMeshes(this.model, this.observe);
    this.geometryBoxes.clear();
    return { ...semantics, objects: this.objects };
  }
}
export function buildRegionalIndex(
  api: IfcAPI,
  model: number,
  semantics: Pick<RegionalIndex, 'openingRelations' | 'unitScale'>
): RegionalIndex {
  return new RegionalIndexCollector(api, model).finish(semantics);
}
/** Classifies only requested hosts. Unknown representations retain their cuts. */
export function classifyRegionalOpenings(
  api: IfcAPI,
  model: number,
  index: RegionalIndex,
  hosts: Set<number>
): { small: number[]; retained: number; unknown: number } {
  const rows = new Map<number, any>(),
    ref = (v: any) => Number(v?.value ?? v),
    text = (v: any) => String(v?.value ?? v ?? ''),
    line = (v: any) => {
      const id = ref(v);
      if (!rows.has(id)) rows.set(id, api.GetLine(model, id, false));
      return rows.get(id);
    };
  const brepWidth = (solid: any): number | null => {
    const polygons: { ids: number[]; points: number[][] }[] = [],
      vertices = new Map<number, number[]>(),
      parent = new Map<number, number>();
    const find = (id: number): number => {
      const p = parent.get(id)!;
      if (p !== id) parent.set(id, find(p));
      return parent.get(id)!;
    };
    for (const f of line(solid.Outer).CfsFaces ?? []) {
      for (const b of line(f).Bounds ?? []) {
        const loop = line(line(b).Bound);
        if (!loop.Polygon) return null;
        const ids = loop.Polygon.map(ref);
        for (const id of ids) {
          if (!parent.has(id)) parent.set(id, id);
          if (!vertices.has(id))
            vertices.set(id, line(id).Coordinates.map(ref));
        }
        for (const id of ids) parent.set(find(id), find(ids[0]));
        polygons.push({
          ids,
          points: ids.map((id: number) => vertices.get(id)!),
        });
      }
    }
    const pieces = new Map<
      number,
      { points: number[][]; loops: number[][][] }
    >();
    for (const [id, p] of vertices) {
      const root = find(id);
      if (!pieces.has(root)) pieces.set(root, { points: [], loops: [] });
      pieces.get(root)!.points.push(p);
    }
    for (const polygon of polygons)
      pieces.get(find(polygon.ids[0]))!.loops.push(polygon.points);
    let maximum = 0;
    for (const piece of pieces.values()) {
      if (
        piece.points.some(
          (p) => p.length !== 3 || p.some((v) => !Number.isFinite(v))
        )
      )
        return null;
      let width: number | null = null;
      // Rounded polygonal caps distinguish hole diameter from cutting depth.
      for (const polygon of piece.loops.filter((p) => p.length > 4)) {
        const origin = new THREE.Vector3().fromArray(polygon[0]);
        let normal: THREE.Vector3 | null = null;
        for (let i = 1; i < polygon.length - 1; i++) {
          const n = new THREE.Vector3()
            .fromArray(polygon[i])
            .sub(origin)
            .cross(new THREE.Vector3().fromArray(polygon[i + 1]).sub(origin));
          if (n.lengthSq() > 1e-12) {
            normal = n.normalize();
            break;
          }
        }
        if (!normal) continue;
        const x = new THREE.Vector3(
            Math.abs(normal.x) < 0.8 ? 1 : 0,
            Math.abs(normal.x) < 0.8 ? 0 : 1,
            0
          )
            .cross(normal)
            .normalize(),
          y = new THREE.Vector3().crossVectors(normal, x);
        const points = piece.points.map((p) => {
          const v = new THREE.Vector3().fromArray(p).sub(origin);
          return [v.dot(x), v.dot(y), v.dot(normal!)];
        });
        const lo = [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i]))),
          hi = [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i]))),
          epsilon = Math.max(1e-5, (hi[2] - lo[2]) * 1e-7),
          caps = [new Set<string>(), new Set<string>()];
        let valid = true;
        for (const p of points) {
          const end =
            Math.abs(p[2] - lo[2]) <= epsilon
              ? 0
              : Math.abs(p[2] - hi[2]) <= epsilon
                ? 1
                : -1;
          if (end < 0) {
            valid = false;
            break;
          }
          caps[end].add(
            [0, 1].map((i) => Math.round(p[i] / epsilon)).join(',')
          );
        }
        if (
          valid &&
          caps[0].size === caps[1].size &&
          [...caps[0]].every((p) => caps[1].has(p))
        ) {
          width = Math.max(hi[0] - lo[0], hi[1] - lo[1]) * index.unitScale;
          break;
        }
      }
      if (width === null) return null;
      maximum = Math.max(maximum, width);
    }
    return maximum || null;
  };
  const size = (item: any, seen = new Set<number>()): number | null => {
    const id = ref(item);
    if (!id || seen.has(id) || seen.size > 64) return null;
    seen.add(id);
    const solid = line(id),
      type = api.GetNameFromTypeCode(solid.type).toUpperCase();
    if (type === 'IFCFACETEDBREP') return brepWidth(solid);
    if (type === 'IFCBOOLEANRESULT' && text(solid.Operator) === 'UNION') {
      const a = size(solid.FirstOperand, new Set(seen)),
        b = size(solid.SecondOperand, new Set(seen));
      return a === null || b === null ? null : Math.max(a, b);
    }
    if (type !== 'IFCEXTRUDEDAREASOLID') return null;
    const profile = line(solid.SweptArea),
      kind = api.GetNameFromTypeCode(profile.type).toUpperCase();
    if (kind === 'IFCCIRCLEPROFILEDEF')
      return 2 * ref(profile.Radius) * index.unitScale;
    if (kind === 'IFCRECTANGLEPROFILEDEF')
      return Math.max(ref(profile.XDim), ref(profile.YDim)) * index.unitScale;
    if (kind !== 'IFCARBITRARYCLOSEDPROFILEDEF') return null;
    const curve = line(profile.OuterCurve);
    if (!Array.isArray(curve.Points)) return null;
    const points = curve.Points.map((p: any) => line(p).Coordinates.map(ref));
    return (
      Math.max(
        ...[0, 1].map(
          (i) =>
            Math.max(...points.map((p: number[]) => p[i])) -
            Math.min(...points.map((p: number[]) => p[i]))
        )
      ) * index.unitScale
    );
  };
  const result = { small: [] as number[], retained: 0, unknown: 0 };
  for (const relation of index.openingRelations.filter((r) =>
    hosts.has(r.host)
  )) {
    try {
      const opening = line(relation.opening),
        reps = line(opening.Representation).Representations,
        sizes: number[] = [];
      let unknown = false;
      for (const r of reps) {
        const rep = line(r);
        if (text(rep.RepresentationIdentifier).toUpperCase() !== 'BODY')
          continue;
        for (const item of rep.Items ?? []) {
          const width = size(item);
          if (width === null || !Number.isFinite(width) || width <= 0)
            unknown = true;
          else sizes.push(width);
        }
      }
      if (!unknown && sizes.length && Math.max(...sizes) <= 0.05)
        result.small.push(relation.id);
      else {
        result.retained++;
        if (unknown || !sizes.length) result.unknown++;
      }
    } catch {
      result.retained++;
      result.unknown++;
    }
  }
  return result;
}

/** Nearest-first region query; bounds intersection includes long crossing members. */
export function queryRegionalObjects(
  objects: RegionalObject[],
  sourceToViewer: THREE.Matrix4,
  camera: THREE.Camera,
  radius = 30
): RegionalObject[] {
  camera.updateMatrixWorld();
  const position = new THREE.Vector3().setFromMatrixPosition(
    camera.matrixWorld
  );
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    )
  );
  return objects
    .map((object) => ({
      object,
      box: new THREE.Box3(
        new THREE.Vector3(...object.bounds.slice(0, 3)),
        new THREE.Vector3(...object.bounds.slice(3, 6))
      ).applyMatrix4(sourceToViewer),
    }))
    .filter(
      ({ box }) =>
        box.distanceToPoint(position) <= radius && frustum.intersectsBox(box)
    )
    .sort(
      (a, b) =>
        a.box.distanceToPoint(position) - b.box.distanceToPoint(position)
    )
    .map(({ object }) => object);
}
