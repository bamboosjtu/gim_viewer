import {it,expect,vi} from 'vitest';
import * as THREE from 'three';
import {observeModelPresentation} from '../modelPresentation.js';
function event(){const listeners=new Set<()=>void>();return {add:(f:()=>void)=>listeners.add(f),remove:(f:()=>void)=>listeners.delete(f),emit:()=>[...listeners].forEach(f=>f()),listeners};}
function fixture(){
  const scene=new THREE.Scene(),root=new THREE.Group();scene.add(root);
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());root.add(mesh);
  const canvas=document.createElement('canvas');canvas.getBoundingClientRect=()=>({width:300,height:200}) as DOMRect;
  const renderer={three:{domElement:canvas},onBeforeUpdate:event(),onAfterUpdate:event(),onDisposed:event()},ctx={world:{renderer,scene:{three:scene}}} as any;
  const presented=vi.fn();let current=true;
  const observer=observeModelPresentation(ctx,()=>current,presented);observer.watch(root);
  const draw=(target:THREE.Mesh=mesh)=>target.onAfterRender(renderer.three as any,scene,new THREE.PerspectiveCamera(),target.geometry,target.material as THREE.Material,null as any);
  return {root,mesh,renderer,observer,presented,draw,expire:()=>{current=false;}};
}
it('does not treat scene attachment or an empty/grid frame as the first model frame',()=>{
  const f=fixture();f.renderer.onBeforeUpdate.emit();f.renderer.onAfterUpdate.emit();expect(f.presented).not.toHaveBeenCalled();
  f.renderer.onBeforeUpdate.emit();f.draw();expect(f.presented).not.toHaveBeenCalled();f.renderer.onAfterUpdate.emit();expect(f.presented).toHaveBeenCalledOnce();
  expect(f.renderer.onAfterUpdate.listeners.size).toBe(0);f.draw();f.renderer.onAfterUpdate.emit();expect(f.presented).toHaveBeenCalledOnce();
});
it('observes late Fragments tiles and excludes empty, hidden and zero-opacity representations',()=>{
  const f=fixture(),late=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());f.root.add(late);
  for(const change of [()=>{late.geometry.setDrawRange(0,0);},()=>{late.geometry.setDrawRange(0,36);late.visible=false;},()=>{late.visible=true;late.material.opacity=0;}]){
    change();f.renderer.onBeforeUpdate.emit();f.draw(late);f.renderer.onAfterUpdate.emit();expect(f.presented).not.toHaveBeenCalled();
  }
  late.material.opacity=1;f.renderer.onBeforeUpdate.emit();f.draw(late);f.renderer.onAfterUpdate.emit();expect(f.presented).toHaveBeenCalledOnce();
});
it('rejects stale sessions and resets uncompleted render passes without inventing a visible frame',()=>{
  const f=fixture();f.renderer.onBeforeUpdate.emit();f.draw();
  f.renderer.onBeforeUpdate.emit();f.renderer.onAfterUpdate.emit();expect(f.presented).not.toHaveBeenCalled();
  f.expire();f.renderer.onBeforeUpdate.emit();f.draw();f.renderer.onAfterUpdate.emit();expect(f.presented).not.toHaveBeenCalled();expect(f.renderer.onAfterUpdate.listeners.size).toBe(0);
});
it('preserves model callbacks and does not certify a zero-size canvas',()=>{
  const f=fixture();f.observer.dispose();const original=vi.fn();f.mesh.onAfterRender=original;
  const observer=observeModelPresentation({world:{renderer:f.renderer,scene:{three:f.root.parent}}} as any,()=>true,f.presented);observer.watch(f.root);
  f.renderer.three.domElement.width=0;f.renderer.onBeforeUpdate.emit();f.draw();f.renderer.onAfterUpdate.emit();expect(original).toHaveBeenCalledOnce();expect(f.presented).not.toHaveBeenCalled();
  observer.dispose();expect(f.mesh.onAfterRender).toBe(original);
});
