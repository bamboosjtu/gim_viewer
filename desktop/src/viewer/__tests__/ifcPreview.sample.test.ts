// @vitest-environment node
import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { inspectIfcPreview } from '../ifcPreviewData.js';
import { previewShapeGeometry } from '../ifcPreviewProvider.js';
import * as THREE from 'three';
import {extractIfcObjectFine} from '../ifcObjectFineData.js';
import {objectFineGroup} from '../ifcObjectFineRuntime.js';

it('small real substation02 IFC: metadata identity, preview geometry and sample fingerprint',async()=>{
  const require=createRequire(import.meta.url), {IfcAPI}=require('web-ifc');
  const packageDir=dirname(require.resolve('web-ifc'));
  const source=resolve(process.env.GIM_SAMPLE_ROOT??'../demo','substation02/CBM/02-警传室.ifc');
  const bytes=readFileSync(source),sha=createHash('sha256').update(bytes).digest('hex');
  expect(bytes.byteLength).toBe(575414);
  expect(sha).toBe('3cfe2f6927511badc4b5ae112a71e994404b83139102d0ea63c4b2be8f7f927d');
  const api=new IfcAPI();api.SetWasmPath(packageDir+sep,true);await api.Init(undefined,true);
  const model=api.OpenModel(bytes,{COORDINATE_TO_ORIGIN:false});
  try {
    const data=inspectIfcPreview(api,model,'ifc_small_sample','CBM/02-警传室.ifc');
    expect(data.diagnostics.products).toBeGreaterThan(0);expect(data.shapes.length).toBeGreaterThan(0);
    expect(data.shapes.every(shape=>shape.object.globalId&&shape.object.expressId>0&&shape.object.ifcType)).toBe(true);
    const shape=data.shapes.find(item=>item.profile)??data.shapes[0];
    const geometry=previewShapeGeometry(shape,shape.profile?1:0,data.origin);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.isEmpty()).toBe(false);
    expect(geometry.getAttribute('position').array.every(Number.isFinite)).toBe(true);
    geometry.dispose();
    const small=data.shapes.find(s=>s.object.expressId===428)!;
    const fine=extractIfcObjectFine(api,model,428,small.object.globalId),sourceToViewer=new THREE.Matrix4().makeRotationX(-Math.PI/2);
    const exact=new THREE.Box3().setFromObject(objectFineGroup(fine,small.object,sourceToViewer));
    const coarse=previewShapeGeometry(small,small.profile?1:0,data.origin);coarse.computeBoundingBox();
    const expected=coarse.boundingBox!.applyMatrix4(sourceToViewer.clone().multiply(new THREE.Matrix4().makeTranslation(...data.origin as [number,number,number])));
    expect(exact.min.distanceTo(expected.min)).toBeLessThan(1e-5);expect(exact.max.distanceTo(expected.max)).toBeLessThan(1e-5);coarse.dispose();
    console.info(JSON.stringify({source,bytes:bytes.byteLength,sha,products:data.diagnostics.products,
      represented:data.diagnostics.represented,unsupported:data.diagnostics.unsupported,shapeCount:data.shapes.length,
      prismCount:data.shapes.filter(item=>item.profile).length,expressId:shape.object.expressId,globalId:shape.object.globalId,
      sourceMatrix:shape.matrix,origin:data.origin}));
  } finally {api.CloseModel(model);}
},30_000);

it('real substation02 steel: source metadata, all product identities, parametric prism coverage',async()=>{
  const require=createRequire(import.meta.url), {IfcAPI}=require('web-ifc');
  const packageDir=dirname(require.resolve('web-ifc'));
  const source=resolve(process.env.GIM_SAMPLE_ROOT??'../demo','substation02/CBM/0302-钢结构.ifc');
  const bytes=readFileSync(source);
  expect(bytes.byteLength).toBe(390725879);
  const sha=createHash('sha256').update(bytes).digest('hex');
  expect(sha).toBe('71d5d31cdddbf01f336864cc6d13a469ce07efa475e175f2f7b7ec65df679605');
  const api=new IfcAPI();api.SetWasmPath(packageDir+sep,true);await api.Init(undefined,true);
  const start=performance.now(),model=api.OpenModel(bytes,{COORDINATE_TO_ORIGIN:false}),opened=performance.now();
  try {
    const data=inspectIfcPreview(api,model,'ifc_sample_steel','CBM/0302-钢结构.ifc');
    const inspected=performance.now(), objects=new Map(data.shapes.map(s=>[s.object.expressId,s.object]));
    console.info(JSON.stringify({diagnostics:data.diagnostics,objects:objects.size,shapeCount:data.shapes.length,types:[...objects.values()].reduce((counts:Record<string,number>,o)=>{counts[o.ifcType]=(counts[o.ifcType]??0)+1;return counts;},{})}));
    expect(data.diagnostics.products).toBe(28231);expect(objects.size).toBe(28231);
    expect([...objects.values()].every(o=>o.globalId&&o.ifcType&&o.sourcePath)).toBe(true);
    expect(new Set([...objects.values()].map(o=>o.globalId)).size).toBe(28231);
    expect(data.unitScale).toBe(.001);
    let placementMaxAbsDiff=0;
    const boxes=data.shapes.filter(s=>!s.profile).slice(0,100);
    for(const s of boxes) {
      const object=api.GetLine(model,s.object.expressId);
      // Independent native placement check, not a calibration against exact meshes.
      const expected=new THREE.Matrix4().makeScale(.001,.001,.001).multiply(new THREE.Matrix4().fromArray(api.GetWorldTransformMatrix(model,object.ObjectPlacement.value)));
      placementMaxAbsDiff=Math.max(placementMaxAbsDiff,...expected.elements.map((n,i)=>Math.abs(n-s.matrix[i])));
    }
    expect(placementMaxAbsDiff).toBeLessThan(1e-7);
    const prisms=new Set(data.shapes.filter(s=>s.profile).map(s=>s.object.expressId));
    expect(prisms.size).toBeGreaterThan(0);
    let triangles=0;
    for(const shape of data.shapes.filter(s=>s.profile)) {
      const geometry=previewShapeGeometry(shape,1,data.origin);triangles+=geometry.getAttribute('position').count/3;
      expect(geometry.getAttribute('position').array.every(Number.isFinite)).toBe(true);geometry.dispose();
    }
    const report={source,sha,bytes:bytes.length,webIfc:JSON.parse(readFileSync(resolve(packageDir,'package.json'),'utf8')).version,openMs:opened-start,inspectMs:inspected-opened,
      prismBuildMs:performance.now()-inspected,...data.diagnostics,prismObjects:prisms.size,prismTriangles:triangles,coordinateOrigin:data.origin,placementChecks:boxes.length,placementMaxAbsDiff};
    mkdirSync('../output/ifc-preview-prototype',{recursive:true});writeFileSync('../output/ifc-preview-prototype/sample02.json',JSON.stringify(report,null,2));console.info(JSON.stringify(report));
  } finally {api.CloseModel(model);}
},120_000);
