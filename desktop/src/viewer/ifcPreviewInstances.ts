import * as THREE from 'three';
import type { IfcPreviewShape } from './ifcGeometryProvider.js';

/** Unit-box placement, retaining the source OBB axes (including inclined members). */
export function previewBoxMatrix(shape:IfcPreviewShape,origin:number[]):THREE.Matrix4 {
  const [x,y,z,X,Y,Z]=shape.bounds;
  return new THREE.Matrix4().makeTranslation(-origin[0],-origin[1],-origin[2])
    .multiply(new THREE.Matrix4().fromArray(shape.matrix))
    .multiply(new THREE.Matrix4().makeTranslation((x+X)/2,(y+Y)/2,(z+Z)/2))
    .multiply(new THREE.Matrix4().makeScale(X-x,Y-y,Z-z));
}

export interface PreviewInstance {
  shape:IfcPreviewShape;
  mesh:THREE.InstancedMesh;
  index:number;
  matrix:THREE.Matrix4;
  visible:boolean;
}

/** Bounded chunks share one immutable indexed box. Identity is instanceId, never triangle index. */
export async function buildPreviewInstances(shapes:IfcPreviewShape[],origin:number[],material:THREE.Material,
  modelId:string,isCancelled:()=>boolean,yieldTask:()=>Promise<void>):Promise<{group:THREE.Group;instances:PreviewInstance[]}> {
  const group=new THREE.Group(),instances:PreviewInstance[]=[];
  const geometry=new THREE.BoxGeometry(1,1,1);
  try {
    for(let start=0;start<shapes.length;start+=1024){
      if(isCancelled())throw new DOMException('Preview released','AbortError');
      const chunk=shapes.slice(start,start+1024),mesh=new THREE.InstancedMesh(geometry,material,chunk.length);
      mesh.userData={provider:'ifc-preview',modelId,lod:0,approximate:true,
        instanceExpressIds:new Uint32Array(chunk.map(s=>s.object.expressId))};
      for(let index=0;index<chunk.length;index++){
        const matrix=previewBoxMatrix(chunk[index],origin);
        mesh.setMatrixAt(index,matrix);instances.push({shape:chunk[index],mesh,index,matrix,visible:true});
      }
      mesh.userData.previewSlots=instances.slice(-chunk.length);
      mesh.computeBoundingBox();mesh.computeBoundingSphere();group.add(mesh);
      await yieldTask();
    }
    // No instances means no owner of the unit geometry.
    if(!shapes.length)geometry.dispose();
    return {group,instances};
  } catch(error) {for(const mesh of group.children as THREE.InstancedMesh[])mesh.dispose();geometry.dispose();throw error;}
}

/** Shared geometry is disposed once; InstancedMesh owns additional renderer resources. */
export function disposePreviewMeshes(group:THREE.Group):void {
  const geometries=new Set<THREE.BufferGeometry>();
  for(const mesh of [...group.children] as THREE.Mesh[]){
    group.remove(mesh);if(mesh.geometry)geometries.add(mesh.geometry);
    if(mesh instanceof THREE.InstancedMesh)mesh.dispose();
  }
  for(const geometry of geometries)geometry.dispose();
}

/** Active-slot compaction saves vertex work; picking IDs follow the same slot permutation. */
export function setPreviewInstanceVisible(entry:PreviewInstance,visible:boolean):void {
  if(entry.visible===visible)return;
  const mesh=entry.mesh,slots=mesh.userData.previewSlots as PreviewInstance[],ids=mesh.userData.instanceExpressIds as Uint32Array;
  if(visible){entry.index=mesh.count++;slots[entry.index]=entry;ids[entry.index]=entry.shape.object.expressId;mesh.setMatrixAt(entry.index,entry.matrix);}
  else {
    const last=slots[--mesh.count];
    if(last!==entry){slots[entry.index]=last;last.index=entry.index;ids[last.index]=last.shape.object.expressId;mesh.setMatrixAt(last.index,last.matrix);}
    slots.length=mesh.count;entry.index=-1;
  }
  entry.visible=visible;mesh.instanceMatrix.needsUpdate=true;
}

export type FarViewDecision='hidden'|'box'|'prism';
/** Thresholds are pixel budgets, not IFC-type importance. Plates are never type-hidden. */
export function farViewDecision(pixels:number,ifcType:string,hasPrism:boolean,previous:FarViewDecision,selected:boolean):FarViewDecision {
  if(selected)return hasPrism?'prism':'box';
  const fastener=/^IFC(MECHANICALFASTENER|FASTENER)$/.test(ifcType);
  if(fastener&&pixels<(previous==='hidden'?3:2))return 'hidden';
  if(hasPrism&&pixels>=(previous==='prism'?16:24))return 'prism';
  return 'box';
}

/** Conservative projected diameter; use the nearest sphere depth, never a fitted coordinate offset. */
export function projectedPreviewPixels(sphere:THREE.Sphere,camera:THREE.Camera,height:number):number {
  const p=sphere.center.clone().applyMatrix4(camera.matrixWorldInverse),nearDepth=Math.max(.001,-p.z-sphere.radius);
  if(camera instanceof THREE.PerspectiveCamera)return sphere.radius*height*camera.projectionMatrix.elements[5]/nearDepth;
  if(camera instanceof THREE.OrthographicCamera)return 2*sphere.radius*height*camera.zoom/(camera.top-camera.bottom);
  return 0;
}
