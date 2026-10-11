// @vitest-environment node
import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { inspectIfcPreview } from '../ifcPreviewData.js';
import { previewShapeGeometry } from '../ifcPreviewProvider.js';
import * as THREE from 'three';

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
