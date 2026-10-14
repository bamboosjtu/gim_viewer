import type { IfcAPI } from 'web-ifc';

export interface ObjectFinePart {
  geometryId?:number;
  vertices:Float32Array;
  indices:Uint32Array;
  matrix:number[];
  color:number[];
}
export interface ObjectFineResult {
  expressId:number;globalId:string;ifcType:string;
  parts:ObjectFinePart[];geometryMs:number;wasmHeapBytes:number;coordinationMatrix:number[];
}
/** Exactly one source product; GetFlatMesh does not stream/convert the entire file. */
export function extractIfcObjectFine(api:IfcAPI,model:number,expressId:number,globalId:string,templates?:Map<number,{vertices:Float32Array;indices:Uint32Array}>):ObjectFineResult {
  const entity=api.GetLine(model,expressId,false);
  if(!entity||String(entity.GlobalId?.value??'')!==globalId)throw new Error('IFC object identity mismatch');
  const started=performance.now(),flat=api.GetFlatMesh(model,expressId),parts:ObjectFinePart[]=[];
  try {
    for(let i=0;i<flat.geometries.size();i++){
      const placed=flat.geometries.get(i),geometry=api.GetGeometry(model,placed.geometryExpressID);
      try {
        let template=templates?.get(placed.geometryExpressID);
        if(!template){template={vertices:new Float32Array(api.GetVertexArray(geometry.GetVertexData(),geometry.GetVertexDataSize())),indices:new Uint32Array(api.GetIndexArray(geometry.GetIndexData(),geometry.GetIndexDataSize()))};templates?.set(placed.geometryExpressID,template);}
        const {vertices,indices}=template;
        if(vertices.length%6||!vertices.every(Number.isFinite))throw new Error('Invalid fine vertices');
        if(placed.flatTransformation.length!==16||!placed.flatTransformation.every(Number.isFinite)||indices.length%3||!indices.every(index=>index<vertices.length/6))throw new Error('Invalid fine placement/indices');
        parts.push({geometryId:placed.geometryExpressID,vertices,indices,matrix:[...placed.flatTransformation],color:[placed.color.x,placed.color.y,placed.color.z,placed.color.w]});
      } finally {geometry.delete();}
    }
  } finally {
    // 0.0.77's declaration includes delete(), but its WASM FlatMesh is a
    // plain value object. Only delete actual embind owners, not the value.
    if(typeof flat.delete==='function')flat.delete();
    else (flat.geometries as unknown as {delete?:()=>void}).delete?.();
  }
  return {expressId,globalId,ifcType:api.GetNameFromTypeCode(entity.type),parts,geometryMs:performance.now()-started,
    wasmHeapBytes:(api as any).wasmModule?.HEAPU8?.byteLength??0,coordinationMatrix:api.GetCoordinationMatrix(model)};
}
