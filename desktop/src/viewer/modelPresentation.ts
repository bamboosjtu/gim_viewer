import type * as THREE from 'three';
import type {ViewerContext} from './viewerEngine.js';
import {requestViewerRender} from './demandRendering.js';

/** Observe a model draw submitted for the current viewport. No GPU fence,
 * readback, geometry compilation or wait for the whole station is involved. */
export function observeModelPresentation(ctx:ViewerContext,isCurrent:()=>boolean,onPresented:()=>void){
  const renderer=ctx.world.renderer;
  const hooks=new Map<THREE.Object3D,{before:THREE.Object3D['onAfterRender'];wrapped:THREE.Object3D['onAfterRender']}>();
  const roots=new Set<THREE.Object3D>();let drawn=false,disposed=false;
  const added=(event:{child:THREE.Object3D})=>watch(event.child);
  const removed=(event:{child:THREE.Object3D})=>unwatch(event.child);
  const drawnModel:THREE.Object3D['onAfterRender']=function(this:THREE.Object3D,actual,scene,_camera,geometry,material){
    if(drawn||!isCurrent()||actual!==renderer?.three||scene!==ctx.world.scene.three||!material.visible||material.opacity===0)return;
    const canvas=actual.domElement,rect=canvas.getBoundingClientRect();
    if(canvas.width<=0||canvas.height<=0||rect.width<=0||rect.height<=0||document.visibilityState==='hidden')return;
    let attached=false;for(let node:THREE.Object3D|null=this;node;node=node.parent){if(!node.visible)return;if(node===scene)attached=true;}if(!attached)return;
    const position=geometry.getAttribute('position'),count=geometry.index?.count??position?.count??0;
    if(count>0&&geometry.drawRange.count>0&&(!(this as THREE.InstancedMesh).isInstancedMesh||(this as THREE.InstancedMesh).count>0))drawn=true;
  };
  function watch(root:THREE.Object3D){root.traverse(object=>{
    if(hooks.has(object))return;
    const before=object.onAfterRender;
    const wrapped:THREE.Object3D['onAfterRender']=function(this:THREE.Object3D,...args){before.apply(this,args);drawnModel.apply(this,args);};
    hooks.set(object,{before,wrapped});object.onAfterRender=wrapped;
    object.addEventListener('childadded',added);object.addEventListener('childremoved',removed);
  });}
  function detach(object:THREE.Object3D){const hook=hooks.get(object);if(!hook)return;
    if(object.onAfterRender===hook.wrapped)object.onAfterRender=hook.before;
    object.removeEventListener('childadded',added);object.removeEventListener('childremoved',removed);hooks.delete(object);
  }
  function unwatch(root:THREE.Object3D){root.traverse(detach);}
  const before=()=>{drawn=false;};
  const dispose=()=>{if(disposed)return;disposed=true;for(const object of hooks.keys())detach(object);roots.clear();renderer?.onBeforeUpdate.remove(before);renderer?.onAfterUpdate.remove(after);renderer?.onDisposed.remove(dispose);};
  const after=()=>{if(!isCurrent()){dispose();return;}if(drawn){dispose();onPresented();}};
  renderer?.onBeforeUpdate.add(before);renderer?.onAfterUpdate.add(after);renderer?.onDisposed.add(dispose);
  return {watch(root:THREE.Object3D){if(disposed||roots.has(root))return;roots.add(root);watch(root);requestViewerRender(ctx);},dispose};
}
