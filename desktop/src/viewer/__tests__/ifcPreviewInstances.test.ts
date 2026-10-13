import {describe,it,expect,vi} from 'vitest';
import * as THREE from 'three';
import {buildPreviewInstances,disposePreviewMeshes,previewBoxMatrix,setPreviewInstanceVisible,farViewDecision,projectedPreviewPixels} from '../ifcPreviewInstances.js';
import {previewShapeGeometry} from '../ifcPreviewProvider.js';
import type {IfcPreviewShape} from '../ifcGeometryProvider.js';

function shape(id=1):IfcPreviewShape{return {object:{key:`ifc:model:object:${id}`,modelId:'model',sourcePath:'CBM/source.ifc',expressId:id,globalId:`guid-${id}`,ifcType:'IFCMEMBER',name:'Member',provider:'ifc-preview'},bounds:[1,2,3,4,6,10],matrix:new THREE.Matrix4().makeRotationY(.6).setPosition(50000,80000,1000).toArray(),approximation:'IFC bounding box'};}
describe('shared IFC boxes and screen-space prototype',()=>{
  it('retains inclined axes, original box, precision origin and project matrix',()=>{
    const s=shape(),origin=[50000,80000,1000],project=new THREE.Matrix4().makeRotationX(-Math.PI/2);
    const root=project.clone().multiply(new THREE.Matrix4().makeTranslation(...origin as [number,number,number]));
    const expected=previewShapeGeometry(s,0,origin);expected.computeBoundingBox();
    const actual=new THREE.Box3(new THREE.Vector3(-.5,-.5,-.5),new THREE.Vector3(.5,.5,.5)).applyMatrix4(previewBoxMatrix(s,origin)).applyMatrix4(root);
    const legacy=expected.boundingBox!.applyMatrix4(root);
    expect(actual.min.distanceTo(legacy.min)).toBeLessThan(1e-5);expect(actual.max.distanceTo(legacy.max)).toBeLessThan(1e-5);expected.dispose();
  });
  it('compacts visibility slots and restores the same ExpressId at its new slot',async()=>{
    const built=await buildPreviewInstances([shape(1),shape(2),shape(3)],[0,0,0],new THREE.MeshBasicMaterial(),'model',()=>false,async()=>{}),[a,b,c]=built.instances;
    expect(a.mesh.geometry).toBe(c.mesh.geometry);setPreviewInstanceVisible(a,false);
    expect(c.index).toBe(0);expect(c.mesh.count).toBe(2);expect(c.mesh.userData.instanceExpressIds[0]).toBe(3);
    setPreviewInstanceVisible(c,false);setPreviewInstanceVisible(a,true);setPreviewInstanceVisible(c,true);
    expect(a.mesh.count).toBe(3);expect(a.mesh.userData.instanceExpressIds[a.index]).toBe(1);expect(a.shape.object.globalId).toBe('guid-1');expect(b.index).toBe(0);
    disposePreviewMeshes(built.group);
  });
  it('all chunks share one box and dispose it exactly once, including instance resources',async()=>{
    const built=await buildPreviewInstances(Array.from({length:2050},(_,i)=>shape(i)),[0,0,0],new THREE.MeshBasicMaterial(),'model',()=>false,async()=>{});
    expect(built.group.children).toHaveLength(3);const dispose=vi.spyOn(built.instances[0].mesh.geometry,'dispose'),instance=vi.spyOn(built.instances[0].mesh,'dispose');
    disposePreviewMeshes(built.group);expect(dispose).toHaveBeenCalledTimes(1);expect(instance).toHaveBeenCalledTimes(1);expect(built.group.children).toHaveLength(0);
  });
  it('cancellation at a chunk boundary rejects rather than publishing partial proxies',async()=>{
    let cancelled=false;await expect(buildPreviewInstances(Array.from({length:2050},(_,i)=>shape(i)),[0,0,0],new THREE.MeshBasicMaterial(),'model',()=>cancelled,async()=>{cancelled=true;})).rejects.toThrow('Preview released');
  });
  it('hides tiny fasteners but never type-hides plates; selection and hysteresis override pixels',()=>{
    expect(farViewDecision(1,'IFCMECHANICALFASTENER',false,'box',false)).toBe('hidden');
    expect(farViewDecision(2.5,'IFCMECHANICALFASTENER',false,'hidden',false)).toBe('hidden');
    expect(farViewDecision(3.1,'IFCMECHANICALFASTENER',false,'hidden',false)).toBe('box');
    expect(farViewDecision(.2,'IFCPLATE',true,'box',false)).toBe('box');
    expect(farViewDecision(.2,'IFCMECHANICALFASTENER',false,'hidden',true)).toBe('box');
    expect(farViewDecision(20,'IFCMEMBER',true,'prism',false)).toBe('prism');
    expect(farViewDecision(20,'IFCMEMBER',true,'box',false)).toBe('box');
  });
  it('uses projection and distance (perspective / orthographic), never source bytes',()=>{
    const camera=new THREE.PerspectiveCamera(60,1,.1,1000);camera.updateMatrixWorld();
    expect(projectedPreviewPixels(new THREE.Sphere(new THREE.Vector3(0,0,-10),1),camera,1080)).toBeGreaterThan(projectedPreviewPixels(new THREE.Sphere(new THREE.Vector3(0,0,-100),1),camera,1080));
    const ortho=new THREE.OrthographicCamera(-10,10,10,-10);ortho.updateMatrixWorld();expect(projectedPreviewPixels(new THREE.Sphere(new THREE.Vector3(0,0,-10),1),ortho,1000)).toBe(100);
  });
});
