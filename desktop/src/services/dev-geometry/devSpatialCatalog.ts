import { GEOMETRY_CACHE_VERSION as DEV_GEOMETRY_VERSION } from '@desktop/contracts.js';
export { DEV_GEOMETRY_VERSION };
import * as THREE from 'three';
import { aggregateGeometryBounds, analyzePrimitive } from '@gim/gim-sdk/geometry';
import { entityIndex } from '../../gim/geometry/xmlModDocument.js';
import { steelSection } from '../../gim/geometry/steelSection.js';
import { stretchedBodyDisplacement } from '../../gim/geometry/stretchedBody.js';
import { offsetRectangularTableVertices } from '../../gim/geometry/offsetRectangularTable.js';
import { primitiveName, type XmlModPrimitive } from '../../gim/geometry/ir.js';
import type { XmlModDocument } from '../../gim/geometry/xmlModParser.js';
import { discoverGeometriesFromDevPath } from './modGeometryDiscovery.js';
import { getFileByPath } from '../../gim/fileLookup.js';

export const DEV_SPATIAL_CATALOG_VERSION = 'dev-spatial-catalog-v1';

export type BoundsTuple = [number, number, number, number, number, number];
export interface DevSourceBounds {
  devPath: string;
  sourceBounds: BoundsTuple | null; // DEV local metres, without CBM or IFC anchor
  boundsQuality: 'conservative' | 'unknown' | 'empty';
  primitiveCounts: Record<string, number>;
  estimatedSteelSections?: number;
  unsupportedTypes: string[];
  absoluteConeCount?: number;
  diagnostic?: string;
  stretchModes?: Record<string, number>;
}
export interface DevSpatialOccurrence extends DevSourceBounds {
  instanceKey: string;
  rootOccurrence: string;
  placementMatrix: number[]; // CBM cumulative, source millimetres
  templateStatus: 'unrequested' | 'ready' | 'empty' | 'unsupported' | 'failed';
}
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
export function tupleBox(box: THREE.Box3): BoundsTuple | null {
  return box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)
    ? null
    : ([...box.min.toArray(), ...box.max.toArray()] as BoundsTuple);
}
export function boxTuple(tuple: BoundsTuple): THREE.Box3 {
  return new THREE.Box3(
    v(...(tuple.slice(0, 3) as [number, number, number])),
    v(...(tuple.slice(3) as [number, number, number])),
  );
}
/** Analytic conservative bounds; no BufferGeometry, subdivision, CSG or export. */
export function primitiveBounds(p: XmlModPrimitive): THREE.Box3 | null {
  const radial = (r: number, z0: number, z1: number) => new THREE.Box3(v(-r, -r, z0), v(r, r, z1));
  switch (p.type) {
    case 'Standard': {
      const { range } = analyzePrimitive(p.canonical);
      return range.coverage === 'conservative'
        ? new THREE.Box3(v(...range.bounds.min), v(...range.bounds.max))
        : null;
    }
    case 'BeamChannelLike':
    case 'ChannelSteel': {
      const s = steelSection(p);
      if (!s) return null;
      return new THREE.Box3(
        v(-s.width / 2, -s.length / 2, -s.height / 2),
        v(s.width / 2, s.length / 2, s.height / 2),
      );
    }
    case 'Cuboid':
      return new THREE.Box3(v(-p.l / 2, -p.w / 2, 0), v(p.l / 2, p.w / 2, p.h));
    case 'Cylinder':
      return radial(p.r, 0, p.h);
    case 'TruncatedCone':
      return radial(Math.max(p.br, p.tr >= 0 && p.tr <= 1 ? p.tr * p.br : p.tr), 0, p.h);
    case 'Sphere':
      return radial(p.r, -p.r, p.r);
    case 'Ring':
      return radial(p.r + Math.abs(p.dr), -Math.abs(p.dr), Math.abs(p.dr));
    case 'CircularGasket': {
      const tube = Math.abs(p.or - p.ir) / 2;
      return radial(p.or + tube, -tube, tube);
    }
    case 'PorcelainBushing':
      return radial(
        Math.max(p.r, p.r1, p.r2),
        Math.min(0, p.h * (0.5 / Math.max(1, p.n) - 0.06)),
        Math.max(p.h, p.h * (1 - 0.5 / Math.max(1, p.n) + 0.02)),
      );
    case 'TerminalBlock': {
      const x = Math.max(p.l / 2, Math.abs(((p.cn - 1) * p.cs) / 2) + p.r);
      const y = Math.max(p.w / 2, Math.abs(((p.rn - 1) * p.rs) / 2) + p.r);
      return new THREE.Box3(v(-x, -y, 0), v(x, y, p.t + p.bl));
    }
    case 'StretchedBody': {
      const resolved = stretchedBodyDisplacement(p.normal, p.l);
      if (!resolved) return null;
      const box = new THREE.Box3();
      for (const raw of p.array.split(';').filter(Boolean)) {
        const a = raw.split(',').map(Number);
        if (a.length < 2 || !a.every(Number.isFinite)) return null;
        const pt = v(a[0], a[1], a[2] ?? 0);
        box.expandByPoint(pt);
        box.expandByPoint(pt.clone().add(v(...resolved.vector)));
      }
      return box;
    }
    case 'OffsetRectangularTable': {
      const vertices = offsetRectangularTableVertices(p.raw);
      if (!vertices) return null;
      const box = new THREE.Box3();
      for (let i = 0; i < vertices.length; i += 3)
        box.expandByPoint(v(vertices[i], vertices[i + 1], vertices[i + 2]));
      return box;
    }
    // Catmull-Rom can overshoot its control polygon. These sources remain unknown.
    case 'Wire':
    case 'Cable':
      return null;
    default:
      return null;
  }
}
/** Navigation range broad phase. Collision still uses the template triangles. */
function patrolPrimitiveRange(p: XmlModPrimitive): THREE.Box3 | null {
  const known = primitiveBounds(p);
  if (known) return known;
  if (p.type === 'Table' && [p.ll1, p.ll2, p.h].every((n) => Number.isFinite(n) && n > 0)) {
    const half = v(p.ll1 / 2, p.ll2 / 2, p.h / 2);
    return new THREE.Box3(half.clone().negate(), half);
  }
  if (p.type === 'RectangularFixedPlate' || p.type === 'RectangularRing') {
    const a = p.raw;
    if (p.type === 'RectangularRing' && p.sourceForm === 'TableGasket') {
      const outer = Number(a.OR),
        top = Number(a.TR),
        inner = Number(a.IR),
        height = Number(a.H);
      if (
        ![outer, top, inner, height].every(Number.isFinite) ||
        !(outer > top && top > inner && inner > 0 && height > 0)
      )
        return null;
      return new THREE.Box3(v(-outer, -outer, 0), v(outer, outer, height));
    }
    const dims =
      p.type === 'RectangularFixedPlate'
        ? [Number(a.L ?? a.L1), Number(a.W ?? a.W1), Number(a.T ?? a.H)]
        : [Number(a.L1), Number(a.W1), Number(a.H ?? a.T)];
    if (!dims.every((n) => Number.isFinite(n) && n > 0)) return null;
    const [l, w, h] = dims;
    return new THREE.Box3(v(-l / 2, -w / 2, -h), v(l / 2, w / 2, h));
  }
  if (
    p.type === 'RotationalEllipsoid' &&
    [p.lr, p.wr, p.h].every((n) => Number.isFinite(n) && n > 0)
  ) {
    const half = v(Math.max(1, p.lr), Math.max(1, p.wr), Math.max(1, p.h)).multiplyScalar(0.5);
    return new THREE.Box3(half.clone().negate(), half);
  }
  if (p.type === 'Wire' || p.type === 'Cable') {
    const coords = p.type === 'Wire' ? p.fitPoints : p.inflectionPoints;
    if (
      coords.length < 6 ||
      coords.length % 3 ||
      !coords.every(Number.isFinite) ||
      !(p.d > 0 && Number.isFinite(p.d))
    )
      return null;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < coords.length; i += 3)
      points.push(new THREE.Vector3().fromArray(coords, i));
    const curve = new THREE.CatmullRomCurve3(points),
      box = new THREE.Box3().setFromPoints(points);
    const spans = points.length - 1;
    for (let i = 0; i < spans; i++) {
      // Recover the two interior Bézier controls of this cubic. The convex hull
      // encloses the complete spline, including overshoot between fit points.
      const a = points[i],
        d = points[i + 1];
      const u = curve
        .getPoint((i + 1 / 3) / spans)
        .multiplyScalar(27)
        .addScaledVector(a, -8)
        .sub(d);
      const w = curve
        .getPoint((i + 2 / 3) / spans)
        .multiplyScalar(27)
        .sub(a)
        .addScaledVector(d, -8);
      box.expandByPoint(
        u
          .clone()
          .multiplyScalar(2)
          .sub(w)
          .multiplyScalar(1 / 18),
      );
      box.expandByPoint(
        w
          .multiplyScalar(2)
          .sub(u)
          .multiplyScalar(1 / 18),
      );
    }
    const roundoff = 32 * Number.EPSILON * Math.max(1, box.min.length(), box.max.length());
    return box.expandByScalar(Math.max(p.d / 2, 1e-6) + roundoff);
  }
  if (p.type === 'Unsupported') {
    const a = p.raw;
    if (p.sourceType === 'FlatSteel') {
      const model = /^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i.exec(a.Model ?? '');
      const dims = [Number(a.Length), Number(model?.[1]), Number(model?.[2])];
      if (!model || !dims.every((n) => Number.isFinite(n) && n > 0)) return null;
      const r = Math.hypot(...dims);
      return new THREE.Box3(v(-r, -r, -r), v(r, r, r));
    }
    if (
      (p.sourceType === 'GimGeCableSymbolicCurve' && ['标注线', '标高线'].includes(a.Category)) ||
      (p.sourceType === 'GimGeCableConcentration' && a.Description === '接线点')
    ) {
      const r = Number(a.L ?? a.D);
      if (Number.isFinite(r) && r > 0) return new THREE.Box3(v(-r, -r, -r), v(r, r, r));
    }
  }
  return null;
}
export function documentBounds(
  doc: XmlModDocument,
  patrolRange = false,
): { box: THREE.Box3; unknown: boolean } {
  const badPlacements = new Set(
    doc.diagnostics.filter((d) => d.code === 'invalid-source-matrix').map((d) => d.entityId),
  );
  const range = aggregateGeometryBounds(
    doc.entities,
    entityIndex(doc),
    'display',
    (e) => {
      if (badPlacements.has(e.id)) return { coverage: 'unknown' };
      const p = e.primitive;
      if (p.type === 'Boolean') return { op: p.op, operands: [p.entity1, p.entity2] };
      if (p.type === 'Standard') return analyzePrimitive(p.canonical).range;
      const bounds = patrolRange ? patrolPrimitiveRange(p) : primitiveBounds(p);
      if (!bounds || !tupleBox(bounds)) return { coverage: 'unknown' };
      return {
        coverage: 'conservative',
        bounds: {
          min: bounds.min.toArray(),
          max: bounds.max.toArray(),
          unit: 'mm',
          quality: 'estimated',
        },
      };
    },
    doc.malformedEntityCount > 0 || badPlacements.has(undefined),
  );
  const box =
    range.coverage === 'conservative'
      ? range.bounds
      : range.coverage === 'unknown'
        ? range.knownBounds
        : undefined;
  return {
    box: box ? new THREE.Box3(v(...box.min), v(...box.max)) : new THREE.Box3(),
    unknown: range.coverage === 'unknown',
  };
}
/** Validate the same standard binary/ASCII layouts as stlLoader; scan vertices only. */
export function stlBounds(bytes: ArrayBuffer): THREE.Box3 | null {
  if (bytes.byteLength < 84) return null;
  const view = new DataView(bytes),
    count = view.getUint32(80, true),
    box = new THREE.Box3();
  if (count <= 5_000_000 && 84 + count * 50 === bytes.byteLength) {
    for (let i = 0; i < count; i++)
      for (let j = 0; j < 3; j++) {
        const offset = 84 + i * 50 + 12 + j * 12;
        const pt = v(
          view.getFloat32(offset, true),
          view.getFloat32(offset + 4, true),
          view.getFloat32(offset + 8, true),
        );
        if (!pt.toArray().every(Number.isFinite)) return null;
        box.expandByPoint(pt);
      }
  } else {
    const text = new TextDecoder().decode(bytes);
    if (!/^solid\b/.test(text)) return null; // Private dialect remains explicitly unknown.
    for (const match of text.matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g)) {
      const pt = v(Number(match[1]), Number(match[2]), Number(match[3]));
      if (!pt.toArray().every(Number.isFinite)) return null;
      box.expandByPoint(pt);
    }
  }
  return tupleBox(box) ? box : null;
}
export async function buildDevSourceBounds(
  devPath: string,
  files: Map<string, File>,
  parse: (text: string, path: string) => XmlModDocument,
  discovery: import('./modGeometryDiscovery.js').GeometryDiscoveryOptions = {},
  patrolRange = false,
): Promise<DevSourceBounds> {
  const result: DevSourceBounds = {
    devPath,
    sourceBounds: null,
    boundsQuality: 'empty',
    primitiveCounts: {},
    unsupportedTypes: [],
  };
  try {
    const discovered = await discoverGeometriesFromDevPath(
      devPath,
      files,
      new THREE.Matrix4().toArray(),
      new Set(),
      0,
      { instances: 0 },
      { ...discovery, strictDependencies: true },
    );
    const total = new THREE.Box3();
    let unknown = Boolean(discovered.sourceDiagnostics?.length);
    for (const edge of discovered.mods) {
      const file = getFileByPath(files, edge.modPath);
      if (!file) throw Error(`Source missing: ${edge.modPath}`);
      const doc = parse(await file.text(), edge.modPath),
        bounds = documentBounds(doc, patrolRange);
      for (const e of doc.entities)
        if (e.primitive.type === 'Standard' && e.primitive.canonical.kind === 'StretchedBody') {
          result.stretchModes ??= {};
          result.stretchModes['direction-length'] =
            (result.stretchModes['direction-length'] ?? 0) + 1;
        } else if (e.primitive.type === 'StretchedBody') {
          const mode =
            stretchedBodyDisplacement(e.primitive.normal, e.primitive.l)?.mode ?? 'invalid';
          result.stretchModes ??= {};
          result.stretchModes[mode] = (result.stretchModes[mode] ?? 0) + 1;
        }
      unknown ||= bounds.unknown;
      if (!bounds.box.isEmpty())
        total.union(
          bounds.box.applyMatrix4(new THREE.Matrix4().fromArray(edge.placementTransformMatrix)),
        );
      for (const e of doc.entities)
        if (e.visible) {
          if (
            (e.primitive.type === 'ChannelSteel' || e.primitive.type === 'BeamChannelLike') &&
            steelSection(e.primitive)?.estimated
          )
            result.estimatedSteelSections = (result.estimatedSteelSections ?? 0) + 1;
          if (
            (e.primitive.type === 'TruncatedCone' && e.primitive.tr > 1) ||
            (e.primitive.type === 'Standard' && e.primitive.canonical.kind === 'TruncatedCone')
          )
            result.absoluteConeCount = (result.absoluteConeCount ?? 0) + 1;
          const type = primitiveName(e.primitive);
          result.primitiveCounts[type] = (result.primitiveCounts[type] ?? 0) + 1;
          if (!primitiveBounds(e.primitive) && e.primitive.type !== 'Boolean')
            result.unsupportedTypes.push(type);
        }
    }
    for (const edge of discovered.stls) {
      const file = getFileByPath(files, edge.stlPath);
      const bounds = file ? stlBounds(await file.arrayBuffer()) : null;
      if (bounds)
        total.union(
          bounds.applyMatrix4(new THREE.Matrix4().fromArray(edge.placementTransformMatrix)),
        );
      else unknown = true;
    }
    total.min.multiplyScalar(0.001);
    total.max.multiplyScalar(0.001);
    result.sourceBounds = tupleBox(total);
    result.boundsQuality = unknown ? 'unknown' : result.sourceBounds ? 'conservative' : 'empty';
    result.unsupportedTypes = [...new Set(result.unsupportedTypes)];
  } catch (error) {
    result.boundsQuality = 'unknown';
    result.diagnostic = String(error);
  }
  return result;
}
