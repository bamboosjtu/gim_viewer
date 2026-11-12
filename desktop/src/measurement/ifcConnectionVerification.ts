/** Explicit local probe; normal releases never import the benchmark host. */
import { Matrix4, Box3, Vector3 } from 'three';
import { IfcAPI } from 'web-ifc';
import { streamConnectionGeometry, validConnectionArtifact, CONNECTION_GEOMETRY_VERSION, type ConnectionGeometryBatch } from '../viewer/ifcConnectionBatches.js';
import { resolveWebIfcWasmBaseUrl } from '../viewer/wasmAssets.js';

export const IFC_CONNECTION_FIXTURE=`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Connection chunk validation'),'2;1');
FILE_NAME('anonymous.ifc','2026-11-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCUNITASSIGNMENT((#6));
#8=IFCPROJECT('0000000000000000000001',$,'Anonymous',$,$,$,$,(#5),#7);
#9=IFCCARTESIANPOINT((100.,200.,300.));
#10=IFCAXIS2PLACEMENT3D(#9,#2,#3);
#11=IFCLOCALPLACEMENT($,#10);
#12=IFCCARTESIANPOINT((0.,0.));
#13=IFCAXIS2PLACEMENT2D(#12,$);
#14=IFCCIRCLEPROFILEDEF(.AREA.,$,#13,0.1);
#15=IFCEXTRUDEDAREASOLID(#14,#4,#2,5.);
#16=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#15));
#17=IFCPRODUCTDEFINITIONSHAPE($,$,(#16));
#18=IFCBUILDINGELEMENTPROXY('0000000000000000000002',$,'conductor',$,$,#11,#17,$,$);
#19=IFCBUILDINGELEMENTPROXY('0000000000000000000003',$,'empty conductor',$,$,#11,$,$,$);
ENDSEC;
END-ISO-10303-21;`;
const check=(value:unknown,reason:string)=>{if(!value)throw Error(`ifc-connection-verification:${reason}`);};
const equal=(a:ArrayLike<number>,b:ArrayLike<number>)=>a.length===b.length&&Array.from(a).every((v,i)=>v===b[i]);
const sha=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>))].map(n=>n.toString(16).padStart(2,'0')).join('');

/** Same native-engine case is used by Node and fixed WebView2. No mock API. */
export async function verifyIfcConnectionReader(api:IfcAPI){
  const model=api.OpenModel(new TextEncoder().encode(IFC_CONNECTION_FIXTURE),{CIRCLE_SEGMENTS:4096,COORDINATE_TO_ORIGIN:true});
  const cases=[];
  try{
    const expected=[],flat=api.GetFlatMesh(model,18);
    try{for(let part=0;part<flat.geometries.size();part++){
      const placed=flat.geometries.get(part),geometry=api.GetGeometry(model,placed.geometryExpressID);
      try{
        const vertices=api.GetVertexArray(geometry.GetVertexData(),geometry.GetVertexDataSize());
        const indices=api.GetIndexArray(geometry.GetIndexData(),geometry.GetIndexDataSize());
        check(indices.length>9216&&vertices.length%6===0,'fixture-size');
        check(new Set(indices).size<indices.length&&indices.some((value,i)=>i>0&&value<indices[i-1]),'fixture-indices');
        const expanded=new Float32Array(indices.length*6);
        for(let i=0;i<indices.length;i++)expanded.set(vertices.subarray(indices[i]*6,indices[i]*6+6),i*6);
        expected.push({part,vertices:expanded,matrix:Array.from(placed.flatTransformation),color:[placed.color.x,placed.color.y,placed.color.z,placed.color.w]});
      }finally{geometry.delete();}
    }}finally{(flat as {delete?:()=>void}).delete?.();}
    check(expected.length,'fixture-no-geometry');
    for(const normalized of [false,true]){
      const batches:ConnectionGeometryBatch[]=[];let growth:{beforeBytes:number;afterBytes:number}|undefined;
      const result=await streamConnectionGeometry(api,model,normalized,async batch=>{
        batches.push(batch);
        if(!normalized&&!growth&&batch.chunks?.some(chunk=>chunk.vertices.length)){
          const before=api.wasmModule.HEAPU8.buffer,beforeBytes=before.byteLength;
          check(beforeBytes<=256*1024*1024,'unexpected-heap-size');
          const vector=new api.wasmModule.DoubleVector();
          try{vector.resize(Math.ceil(beforeBytes/8)+8192,0);const after=api.wasmModule.HEAPU8.buffer;
            check(after!==before,'heap-did-not-grow');growth={beforeBytes,afterBytes:after.byteLength};
          }finally{vector.delete();}
        }
        await new Promise(resolve=>setTimeout(resolve,0));
      });
      check(result.objectCount===1&&result.failedObjects.length===0,'failed-objects');
      const inverse=normalized?new Matrix4().fromArray(api.GetCoordinationMatrix(model)).invert():new Matrix4(),parts=[];
      for(const part of expected){
        const chunks=batches.flatMap(b=>b.chunks??[]).filter(chunk=>chunk.part===part.part);
        check(chunks.length>1,'fixture-not-chunked');
        const actual=new Float32Array(chunks.reduce((sum,chunk)=>sum+chunk.vertices.length,0));let offset=0;
        for(const chunk of chunks){actual.set(chunk.vertices,offset);offset+=chunk.vertices.length;
          check(equal(chunk.matrix,inverse.clone().multiply(new Matrix4().fromArray(part.matrix)).toArray()),'matrix-mismatch');
          check(equal(chunk.color,part.color),'color-mismatch');}
        check(equal(actual,part.vertices),'vertex-normal-or-order-mismatch');
        const bounds=(values:Float32Array)=>{const box=new Box3();for(let i=0;i<values.length;i+=6)box.expandByPoint(new Vector3(values[i],values[i+1],values[i+2]));return [...box.min.toArray(),...box.max.toArray()];};
        check(equal(bounds(actual),bounds(part.vertices)),'bounds-mismatch');
        parts.push({part:part.part,triangles:actual.length/18,chunks:chunks.length,bounds:bounds(actual),expandedSha256:await sha(new Uint8Array(actual.buffer)),maxComponentError:0});
      }
      check(validConnectionArtifact({version:CONNECTION_GEOMETRY_VERSION,batches,complete:result}),'artifact-invalid');
      cases.push({normalized,result,parts,growth:growth??null});
    }
    return {status:'PASS',webIfcVersion:api.GetVersion(),sourceSha256:await sha(new TextEncoder().encode(IFC_CONNECTION_FIXTURE)),cases};
  }finally{api.CloseModel(model);}
}

export async function verifyNativeIfcConnections(){
  const base=await resolveWebIfcWasmBaseUrl(),wasm=await fetch(new URL('web-ifc.wasm',base));
  check(wasm.ok,'wasm-unavailable');const wasmSha256=await sha(new Uint8Array(await wasm.arrayBuffer()));
  const api=new IfcAPI();api.SetWasmPath(base,true);
  try{await api.Init(undefined,true);return {...await verifyIfcConnectionReader(api),runtime:'fixed-webview2-web-ifc-wasm',nativeWebView2Verified:true,wasmSha256,userAgent:navigator.userAgent};}
  catch(error){return {status:'FAIL',nativeWebView2Verified:false,error:String(error),wasmSha256,userAgent:navigator.userAgent};}
  finally{if(api.wasmModule)api.Dispose();}
}
