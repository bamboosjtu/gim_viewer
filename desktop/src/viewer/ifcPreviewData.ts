import * as THREE from 'three';
import { IFCPROJECT, IFCPRODUCT, IFCSITE, IFCFEATUREELEMENTSUBTRACTION, IFCMAPCONVERSION, type IfcAPI } from 'web-ifc';
import type { IfcPreviewData, IfcPreviewShape } from './ifcGeometryProvider.js';

// GetLine is intentionally shallow: BRep/boolean reconstruction never runs here.
type Line = Record<string, any>;
const number = (v: any): number => Number(v?.value ?? v);
const text = (v: any): string => String(v?.value ?? v ?? '');
const ref = (v: any): number => typeof v === 'number' ? v : Number(v?.value ?? 0);
const prefixes: Record<string, number> = { MILLI: .001, CENTI: .01, DECI: .1, MICRO: 1e-6, KILO: 1000, '': 1 };

/** Pure metadata projection. API injection also permits independent fixture checks. */
export function inspectIfcPreview(api: Pick<IfcAPI, 'GetLine' | 'GetLineIDsWithType' | 'GetNameFromTypeCode'>,
  model: number, modelId: string, sourcePath: string): IfcPreviewData {
  const cache = new Map<number, Line>();
  const line = (v: any): Line => {
    const id = ref(v);
    if (!id) throw new Error('missing IFC reference');
    let result = cache.get(id);
    if (!result) { result = api.GetLine(model, id, false); cache.set(id, result!); }
    if (!result) throw new Error('missing IFC entity');
    return result;
  };
  const type = (l: Line): string => api.GetNameFromTypeCode(l.type).toUpperCase();
  const list = (t: number): number[] => {
    const v = api.GetLineIDsWithType(model, t, true);
    try { return Array.from({length: v.size()}, (_, i) => v.get(i)); } finally { (v as unknown as {delete?:()=>void}).delete?.(); }
  };
  const projects = list(IFCPROJECT);
  if(list(IFCMAPCONVERSION).length)throw new Error('unsupported IFC map conversion');
  if (projects.length !== 1) throw new Error('preview needs one IfcProject');
  const project = line(projects[0]);
  const units = line(project.UnitsInContext).Units.map((u: any) => line(u)) as Line[];
  const lengths = units.filter(u => text(u.UnitType) === 'LENGTHUNIT');
  const unit = (u: Line, depth = 0): number => {
    if (depth > 8) throw new Error('unit cycle/depth');
    if (type(u) === 'IFCSIUNIT' && text(u.Name) === 'METRE' && text(u.Prefix) in prefixes) return prefixes[text(u.Prefix)];
    if (type(u) === 'IFCCONVERSIONBASEDUNIT') {
      const conversion = line(u.ConversionFactor);
      return number(conversion.ValueComponent) * unit(line(conversion.UnitComponent), depth + 1);
    }
    throw new Error('unsupported IFC length unit');
  };
  if (lengths.length !== 1) throw new Error('ambiguous/missing IFC length unit');
  const scale = unit(lengths[0]);
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('invalid IFC unit');
  const vector = (v: any, field: string): THREE.Vector3 => {
    const values = line(v)[field].map(number);
    if (values.length < 2 || !values.every(Number.isFinite)) throw new Error('invalid IFC vector');
    return new THREE.Vector3(values[0], values[1], values[2] ?? 0);
  };
  const axis = (v: any): THREE.Matrix4 => {
    if (!ref(v)) return new THREE.Matrix4();
    const l = line(v), kind = type(l);
    if (kind !== 'IFCAXIS2PLACEMENT3D' && kind !== 'IFCAXIS2PLACEMENT2D') throw new Error('unsupported IFC axis placement');
    const z = l.Axis ? vector(l.Axis, 'DirectionRatios').normalize() : new THREE.Vector3(0,0,1);
    const x = l.RefDirection ? vector(l.RefDirection, 'DirectionRatios') : new THREE.Vector3(1,0,0);
    x.addScaledVector(z, -x.dot(z)).normalize();
    if (z.lengthSq() < .9 || x.lengthSq() < .9) throw new Error('degenerate IFC axes');
    const y = new THREE.Vector3().crossVectors(z,x);
    return new THREE.Matrix4().makeBasis(x,y,z).setPosition(vector(l.Location,'Coordinates'));
  };
  const placements = new Map<number, THREE.Matrix4>();
  const placement = (v: any, ancestors = new Set<number>()): THREE.Matrix4 => {
    if (!ref(v)) return new THREE.Matrix4();
    const id = ref(v), found = placements.get(id);
    if (found) return found.clone();
    if (ancestors.has(id) || ancestors.size > 128) throw new Error('IFC placement cycle/depth');
    const l = line(v);
    if (type(l) !== 'IFCLOCALPLACEMENT') throw new Error('unsupported IFC object placement');
    const next = new Set(ancestors).add(id);
    const result = placement(l.PlacementRelTo, next).multiply(axis(l.RelativePlacement));
    placements.set(id,result); return result.clone();
  };
  const context = (v: any, ancestors = new Set<number>()): THREE.Matrix4 => {
    const id = ref(v);
    if (!id || ancestors.has(id) || ancestors.size > 16) throw new Error('missing/cyclic IFC context');
    const l = line(v);
    // Map conversion needs an explicit CRS contract; do not guess projected coordinates.
    if (l.HasCoordinateOperation?.length) throw new Error('unsupported IFC map conversion');
    return l.ParentContext ? context(l.ParentContext,new Set(ancestors).add(id)) : axis(l.WorldCoordinateSystem);
  };
  const shapeMatrix = (product: Line, rep: Line, solid: any): THREE.Matrix4 => {
    const m = context(rep.ContextOfItems).multiply(placement(product.ObjectPlacement)).multiply(axis(solid));
    return new THREE.Matrix4().makeScale(scale,scale,scale).multiply(m);
  };
  const polygon = (v: any): number[][] => {
    const p = line(v), kind = type(p);
    let pts: number[][];
    if (kind === 'IFCRECTANGLEPROFILEDEF') {
      const x=number(p.XDim)/2,y=number(p.YDim)/2;
      pts=[[-x,-y],[x,-y],[x,y],[-x,y]];
    } else if (kind === 'IFCARBITRARYCLOSEDPROFILEDEF') {
      const curve=line(p.OuterCurve);
      if (type(curve)!=='IFCPOLYLINE') throw new Error('unsupported preview profile curve');
      pts=curve.Points.map((pt: any) => {
        const point=vector(pt,'Coordinates');
        if(Math.abs(point.z)>1e-9)throw new Error('nonplanar preview profile');
        return [point.x,point.y];
      });
      if (pts.length>1 && pts[0][0]===pts[pts.length-1][0] && pts[0][1]===pts[pts.length-1][1]) pts.pop();
    } else throw new Error('unsupported preview profile');
    if (pts.length<3 || pts.length>4096 || !pts.flat().every(Number.isFinite)) throw new Error('invalid preview profile');
    const m=axis(p.Position);
    return pts.map(pt => new THREE.Vector3(pt[0],pt[1],0).applyMatrix4(m).toArray().slice(0,2));
  };
  const shapes: IfcPreviewShape[]=[];
  const diagnostics: IfcPreviewData['diagnostics']={products:0,represented:0,unsupported:0,reasons:{}};
  const reason=(s: string) => { diagnostics.reasons[s]=(diagnostics.reasons[s]??0)+1; };
  const voids=new Set(list(IFCFEATUREELEMENTSUBTRACTION));
  for (const id of list(IFCPRODUCT)) {
    // Openings are subtractive semantics, not positive proxy geometry.
    if(voids.has(id))continue;
    const product=line(id);
    if (!product.Representation) continue;
    diagnostics.products++;
    if(!text(product.GlobalId)) {diagnostics.unsupported++;reason('missing IFC GlobalId');continue;}
    let count=0;
    const object={key:`ifc:${modelId.toLowerCase()}:object:${id}`,modelId,sourcePath,expressId:id,
      globalId:text(product.GlobalId),ifcType:type(product),name:text(product.Name),provider:'ifc-preview' as const};
    try {
      const reps=line(product.Representation).Representations.map((r: any)=>line(r)) as Line[];
      // Prefer the complete explicit box for LOD0; LOD1 uses swept bodies when supported.
      for (const rep of reps) {
        const identifier=text(rep.RepresentationIdentifier).toLowerCase();
        if (identifier!=='box' && identifier!=='body') continue;
        for (const item of rep.Items ?? []) {
          try {
            let solid=line(item), clipped=false; const visited=new Set<number>();
            while(type(solid)==='IFCBOOLEANCLIPPINGRESULT') {
              if(visited.has(solid.expressID) || visited.size>32) throw new Error('clipping cycle/depth');
              visited.add(solid.expressID);solid=line(solid.FirstOperand);clipped=true;
            }
            const kind=type(solid);
            if(kind==='IFCBOUNDINGBOX') {
              const corner=vector(solid.Corner,'Coordinates'), dims=[number(solid.XDim),number(solid.YDim),number(solid.ZDim)];
              if(!dims.every(x=>Number.isFinite(x)&&x>=0)) throw new Error('invalid box');
              shapes.push({object,matrix:shapeMatrix(product,rep,null).toArray(),bounds:[corner.x,corner.y,corner.z,corner.x+dims[0],corner.y+dims[1],corner.z+dims[2]],approximation:'IFC bounding box'});count++;
            } else if(kind==='IFCEXTRUDEDAREASOLID') {
              const profile=polygon(solid.SweptArea), direction=vector(solid.ExtrudedDirection,'DirectionRatios').normalize(), depth=number(solid.Depth);
              if(direction.lengthSq()<.9 || !Number.isFinite(depth) || depth<=0) throw new Error('invalid extrusion');
              const extrusion=direction.multiplyScalar(depth).toArray(), bounds=new THREE.Box3();
              for(const p of profile) for(const end of [false,true]) bounds.expandByPoint(new THREE.Vector3(p[0]+(end?extrusion[0]:0),p[1]+(end?extrusion[1]:0),end?extrusion[2]:0));
              shapes.push({object,matrix:shapeMatrix(product,rep,solid.Position).toArray(),bounds:[...bounds.min.toArray(),...bounds.max.toArray()] as IfcPreviewShape['bounds'],profile,extrusion,approximation:clipped?'FirstOperand prism; clipping omitted':'extruded profile prism'});count++;
            } else reason(`unsupported ${kind}`);
          } catch(error) {reason(error instanceof Error?error.message:String(error));}
        }
      }
    } catch(error) {reason(error instanceof Error?error.message:String(error));}
    if(count)diagnostics.represented++;else diagnostics.unsupported++;
  }
  const sites=list(IFCSITE);
  // Origin is metadata-derived precision normalization, canceled by the root transform.
  const sourceOrigin=sites.length===1 ? new THREE.Vector3().setFromMatrixPosition(placement(line(sites[0]).ObjectPlacement)).multiplyScalar(scale).toArray() : [0,0,0];
  return {shapes,unitScale:scale,origin:sourceOrigin,diagnostics};
}
