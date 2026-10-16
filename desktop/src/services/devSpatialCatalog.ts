import * as THREE from 'three';
import { stretchedBodyDisplacement } from '../gim/geometry/stretchedBody.js';
import { offsetRectangularTableVertices } from '../gim/geometry/offsetRectangularTable.js';
import type { XmlModPrimitive } from '../gim/geometry/ir.js';
import type { XmlModDocument } from '../gim/geometry/xmlModParser.js';
import { discoverGeometriesFromDevPath } from './modGeometryDiscovery.js';
import { getFileByPath } from '../gim/fileLookup.js';

export const DEV_SPATIAL_CATALOG_VERSION = 'dev-spatial-catalog-v2';
export const DEV_GEOMETRY_VERSION = 'geometry-cache-v12-mirrored-assembly';
export type BoundsTuple = [number, number, number, number, number, number];
export interface DevSourceBounds {
  devPath: string;
  sourceBounds: BoundsTuple | null; // DEV local metres, without CBM or IFC anchor
  boundsQuality: 'conservative' | 'unknown' | 'empty';
  primitiveCounts: Record<string, number>;
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
    ? null : [...box.min.toArray(), ...box.max.toArray()] as BoundsTuple;
}
export function boxTuple(tuple: BoundsTuple): THREE.Box3 {
  return new THREE.Box3(v(...tuple.slice(0, 3) as [number, number, number]), v(...tuple.slice(3) as [number, number, number]));
}
/** Analytic conservative bounds; no BufferGeometry, subdivision, CSG or export. */
export function primitiveBounds(p: XmlModPrimitive): THREE.Box3 | null {
  const radial = (r: number, z0: number, z1: number) => new THREE.Box3(v(-r, -r, z0), v(r, r, z1));
  switch (p.type) {
    case 'Cuboid': return new THREE.Box3(v(-p.l / 2, -p.w / 2, 0), v(p.l / 2, p.w / 2, p.h));
    case 'Cylinder': return radial(p.r, 0, p.h);
    case 'TruncatedCone': return radial(Math.max(p.br, p.tr >= 0 && p.tr <= 1 ? p.tr * p.br : p.tr), 0, p.h);
    case 'Sphere': return radial(p.r, -p.r, p.r);
    case 'Ring': return radial(p.r + Math.abs(p.dr), -Math.abs(p.dr), Math.abs(p.dr));
    case 'CircularGasket': { const tube = Math.abs(p.or - p.ir) / 2; return radial(p.or + tube, -tube, tube); }
    case 'PorcelainBushing': return radial(Math.max(p.r, p.r1, p.r2), Math.min(0, p.h * (0.5 / Math.max(1, p.n) - 0.06)), Math.max(p.h, p.h * (1 - 0.5 / Math.max(1, p.n) + 0.02)));
    case 'TerminalBlock': {
      const x = Math.max(p.l / 2, Math.abs((p.cn - 1) * p.cs / 2) + p.r);
      const y = Math.max(p.w / 2, Math.abs((p.rn - 1) * p.rs / 2) + p.r);
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
        box.expandByPoint(pt); box.expandByPoint(pt.clone().add(v(...resolved.vector)));
      }
      return box;
    }
    case 'OffsetRectangularTable': {
      const vertices = offsetRectangularTableVertices(p.raw);
      if (!vertices) return null;
      const box = new THREE.Box3();
      for (let i = 0; i < vertices.length; i += 3) box.expandByPoint(v(vertices[i], vertices[i+1], vertices[i+2]));
      return box;
    }
    case 'Wire': case 'Cable': {
      const pts = p.type === 'Wire' ? p.fitPoints : p.inflectionPoints;
      const box = new THREE.Box3();
      for (let i = 0; i + 2 < pts.length; i += 3) box.expandByPoint(v(pts[i], pts[i + 1], pts[i + 2]));
      // Catmull-Rom can overshoot its control polygon. These sources remain unknown.
      return null;
    }
    default: return null;
  }
}
export function documentBounds(doc: XmlModDocument): { box: THREE.Box3; unknown: boolean } {
  const box = new THREE.Box3(), byId = new Map<number, THREE.Box3>();
  const entities = new Map(doc.entities.map(e => [e.id, e]));
  let unknown = doc.malformedEntityCount > 0;
  for (const e of doc.entities) {
    if (e.primitive.type === 'Boolean') continue;
    const bounds = primitiveBounds(e.primitive);
    if (!bounds || !tupleBox(bounds)) { if (e.visible) unknown = true; continue; }
    bounds.applyMatrix4(new THREE.Matrix4().fromArray(e.transformMatrix));
    byId.set(e.id, bounds);
    if (e.visible) box.union(bounds);
  }
  const stack = new Set<number>();
  const booleanBox = (id: number): THREE.Box3 | null => {
    if (byId.has(id)) return byId.get(id)!.clone();
    if (stack.has(id)) return null;
    stack.add(id);
    const e = entities.get(id);
    if (e?.primitive.type !== 'Boolean') { stack.delete(id); return null; }
    const a = booleanBox(e.primitive.entity1), b = booleanBox(e.primitive.entity2);
    stack.delete(id);
    if (!a || !b) return null;
    // Union of operand bounds also contains intersection/difference results.
    const result = a.union(b).applyMatrix4(new THREE.Matrix4().fromArray(e.transformMatrix));
    byId.set(id, result); return result;
  };
  for (const e of doc.entities) if (e.visible && e.primitive.type === 'Boolean') {
    const bounds = booleanBox(e.id); if (bounds) box.union(bounds); else unknown = true;
  }
  return { box, unknown };
}
/** Validate the same standard binary/ASCII layouts as stlLoader; scan vertices only. */
export function stlBounds(bytes: ArrayBuffer): THREE.Box3 | null {
  if (bytes.byteLength < 84) return null;
  const view = new DataView(bytes), count = view.getUint32(80, true), box = new THREE.Box3();
  if (count <= 5_000_000 && 84 + count * 50 === bytes.byteLength) {
    for (let i = 0; i < count; i++) for (let j = 0; j < 3; j++) {
      const offset = 84 + i * 50 + 12 + j * 12;
      const pt = v(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
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
export async function buildDevSourceBounds(devPath: string, files: Map<string, File>, parse: (text: string, path: string) => XmlModDocument, discovery: import('./modGeometryDiscovery.js').GeometryDiscoveryOptions = {}): Promise<DevSourceBounds> {
  const result: DevSourceBounds = { devPath, sourceBounds: null, boundsQuality: 'empty', primitiveCounts: {}, unsupportedTypes: [] };
  try {
    const discovered = await discoverGeometriesFromDevPath(devPath, files, new THREE.Matrix4().toArray(), new Set(), 0, { instances: 0 }, { ...discovery, strictDependencies: true });
    const total = new THREE.Box3(); let unknown = false;
    for (const edge of discovered.mods) {
      const file = getFileByPath(files, edge.modPath);
      if (!file) throw Error(`Source missing: ${edge.modPath}`);
      const doc = parse(await file.text(), edge.modPath), bounds = documentBounds(doc);
      for (const e of doc.entities) if (e.primitive.type === 'StretchedBody') {
        const mode = stretchedBodyDisplacement(e.primitive.normal, e.primitive.l)?.mode ?? 'invalid';
        result.stretchModes ??= {}; result.stretchModes[mode] = (result.stretchModes[mode] ?? 0) + 1;
      }
      unknown ||= bounds.unknown;
      if (!bounds.box.isEmpty()) total.union(bounds.box.applyMatrix4(new THREE.Matrix4().fromArray(edge.placementTransformMatrix)));
      for (const e of doc.entities) if (e.visible) {
        if (e.primitive.type === 'TruncatedCone' && e.primitive.tr > 1) result.absoluteConeCount = (result.absoluteConeCount ?? 0) + 1;
        const type = e.primitive.type === 'Unsupported' ? e.primitive.sourceType : e.primitive.type;
        result.primitiveCounts[type] = (result.primitiveCounts[type] ?? 0) + 1;
        if (!primitiveBounds(e.primitive) && e.primitive.type !== 'Boolean') result.unsupportedTypes.push(type);
      }
    }
    for (const edge of discovered.stls) {
      const file = getFileByPath(files, edge.stlPath);
      const bounds = file ? stlBounds(await file.arrayBuffer()) : null;
      if (bounds) total.union(bounds.applyMatrix4(new THREE.Matrix4().fromArray(edge.placementTransformMatrix)));
      else unknown = true;
    }
    total.min.multiplyScalar(0.001); total.max.multiplyScalar(0.001);
    result.sourceBounds = tupleBox(total);
    result.boundsQuality = unknown ? 'unknown' : result.sourceBounds ? 'conservative' : 'empty';
    result.unsupportedTypes = [...new Set(result.unsupportedTypes)];
  } catch (error) { result.boundsQuality = 'unknown'; result.diagnostic = String(error); }
  return result;
}
