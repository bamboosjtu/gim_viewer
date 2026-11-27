import { GEOMETRY_CACHE_VERSION as DEV_GEOMETRY_VERSION } from '@desktop/contracts.js';
export { DEV_GEOMETRY_VERSION };
import * as THREE from 'three';
import {
  aggregateGeometryBounds,
  analyzePrimitive,
  primitiveRepresentationQuality,
  queryStlBounds,
} from '@gim/gim-sdk/geometry';
import { entityIndex } from '../../gim/geometry/xmlModDocument.js';
import { steelSection } from '../../gim/geometry/steelSection.js';
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
  /** Reachable declarations including Boolean operands, grouped by MOD path and reason. */
  estimatedGeometryCount?: number;
  approximationReasons?: Record<string, string[]>;
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
    default:
      return null;
  }
}
/** Navigation range broad phase. Collision still uses the template triangles. */
function patrolPrimitiveRange(p: XmlModPrimitive): THREE.Box3 | null {
  const known = primitiveBounds(p);
  if (known) return known;
  if (p.type === 'Cable') {
    const coords = p.inflectionPoints;
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
export function documentBounds(doc: XmlModDocument, patrolRange = false) {
  let estimatedGeometryCount = 0;
  const reasons = new Set<string>();
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
      if (p.type === 'Standard') {
        const { range } = analyzePrimitive(p.canonical);
        const quality = primitiveRepresentationQuality(p.canonical);
        if (
          quality !== 'standard-derived' ||
          (range.coverage === 'conservative' && range.bounds.quality === 'estimated')
        ) {
          estimatedGeometryCount++;
          reasons.add(
            [
              p.canonical.kind,
              quality,
              'approximation' in p.canonical ? p.canonical.approximation : 'estimated bounds',
            ]
              .filter(Boolean)
              .join(' / '),
          );
        }
        return range;
      }
      const estimated =
        p.type === 'Cable' ||
        ((p.type === 'ChannelSteel' || p.type === 'BeamChannelLike') && steelSection(p)?.estimated);
      if (estimated) {
        estimatedGeometryCount++;
        reasons.add(primitiveName(p) + ' / host preview');
      }
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
    estimatedGeometryCount,
    reasons: [...reasons],
  };
}
/** Range-only decoding shares the STL grammar and allocates no mesh buffers. */
export function stlBounds(bytes: ArrayBuffer): THREE.Box3 | null {
  const { bounds } = queryStlBounds(bytes);
  return bounds ? new THREE.Box3(v(...bounds.min), v(...bounds.max)) : null;
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
        }
      if (bounds.estimatedGeometryCount) {
        result.estimatedGeometryCount =
          (result.estimatedGeometryCount ?? 0) + bounds.estimatedGeometryCount;
        result.approximationReasons ??= {};
        result.approximationReasons[edge.modPath] = bounds.reasons;
      }
      unknown ||= bounds.unknown;
      if (!bounds.box.isEmpty())
        total.union(
          bounds.box.applyMatrix4(new THREE.Matrix4().fromArray(edge.placementTransformMatrix)),
        );
      for (const e of doc.entities)
        if (e.visible) {
          if (
            (e.primitive.type === 'Standard' &&
              'modelEstimate' in e.primitive.canonical &&
              e.primitive.canonical.modelEstimate) ||
            ((e.primitive.type === 'ChannelSteel' || e.primitive.type === 'BeamChannelLike') &&
              steelSection(e.primitive)?.estimated)
          )
            result.estimatedSteelSections = (result.estimatedSteelSections ?? 0) + 1;
          if (e.primitive.type === 'Standard' && e.primitive.canonical.kind === 'TruncatedCone')
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
