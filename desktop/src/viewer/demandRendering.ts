import type * as THREE from 'three';
import type {ViewerContext} from './viewerEngine.js';
import type {OrthoPerspectiveCamera,SimpleRenderer} from '@thatopen/components';

type RequestRender=(urgent?:boolean)=>void;
const owners=new WeakMap<object,RequestRender>();

/** In-place visual changes have no Three.js tree event. Removed objects have no owner. */
export function requestObjectRender(object:object|null|undefined,urgent=true):void {
  if(object)owners.get(object)?.(urgent);
}
export function requestViewerRender(ctx:ViewerContext):void {
  requestObjectRender(ctx.world?.scene?.three);
}
export function setRenderVisibility<T extends {visible:boolean}>(object:T,visible:boolean,urgent=true):void {
  if(object.visible===visible)return;
  object.visible=visible;requestObjectRender(object,urgent);
}

/** O(1) per tick. Scene-only redraws yield time to import/IPC; camera/input bypass the cooldown.
 * This limits drawing, not camera updates, Fragments updates or business scheduling. */
export class RenderDemand {
  private dirty=true;
  private urgent=true;
  private nextSceneAt=-Infinity;
  private startedAt=0;
  private released=false;
  constructor(private renderer:{needsUpdate:boolean},private now:()=>number=()=>performance.now()){}
  request=(urgent=false):void=>{
    if(this.released)return;
    this.dirty=true;this.urgent ||= urgent;this.tick();
  };
  tick=():void=>{
    if(!this.released&&(this.urgent||this.dirty&&this.now()>=this.nextSceneAt))this.renderer.needsUpdate=true;
  };
  before=():void=>{
    this.dirty=false;this.urgent=false;this.startedAt=this.now();
  };
  after=():void=>{
    const now=this.now(),elapsed=Math.max(0,now-this.startedAt);
    // At least 80 ms between scene-only redraws; expensive draws yield about 3x
    // their elapsed time, capped at 750 ms so progressive geometry remains visible.
    this.nextSceneAt=now+Math.min(750,Math.max(80,elapsed*3));
  };
  dispose():void{this.released=true;}
}

/** Subscribe once per attached subtree, never enumerate the scene in the frame loop.
 * Public Object3D events preserve additions/removals by DEV, IFC, outlines and grids. */
export function observeSceneChanges(scene:THREE.Object3D,request:RequestRender):()=>void {
  const observed=new Set<THREE.Object3D>();
  const added=(event:{target?:THREE.Object3D;child:THREE.Object3D})=>{
    if(!event.child){request(true);return;}
    watch(event.child);request(event.target===scene);
  };
  const removed=(event:{target?:THREE.Object3D;child:THREE.Object3D})=>{
    if(!event.child){request(true);return;}
    unwatch(event.child);request(event.target===scene);
  };
  function watch(root:THREE.Object3D){
    root.traverse(object=>{
      if(observed.has(object))return;
      observed.add(object);owners.set(object,request);
      object.addEventListener('childadded',added);object.addEventListener('childremoved',removed);
    });
  }
  function detach(object:THREE.Object3D){
    object.removeEventListener('childadded',added);object.removeEventListener('childremoved',removed);
    if(owners.get(object)===request)owners.delete(object);
    observed.delete(object);
  }
  function unwatch(root:THREE.Object3D){root.traverse(detach);}
  watch(scene);
  return ()=>{for(const object of observed)detach(object);};
}

interface FragmentVisualModel {
  object:THREE.Object3D;
  tiles:ReadonlyMap<unknown,THREE.Mesh>;
  onViewUpdated:{add(callback:()=>void):void;remove(callback:()=>void):void};
}
/** Fragments emits FINISH even when no visual state changed. Inspect only the
 * completing model's public tiles and Three versions, never the scene or vertex
 * data. Attribute/interleaved-buffer versions also cover in-place LOD masks. */
export function observeFragmentVisualChanges(model:FragmentVisualModel,
  request:()=>void=()=>requestObjectRender(model.object,false)):()=>void {
  const snapshots=new WeakMap<object,unknown[]>();
  let size=-1;
  const update=()=>{
    let changed=size!==model.tiles.size;size=model.tiles.size;
    for(const mesh of model.tiles.values()){
      let previous=snapshots.get(mesh);
      if(!previous){previous=[];snapshots.set(mesh,previous);changed=true;}
      let index=0;
      const check=(value:unknown)=>{if(previous[index]!==value){previous[index]=value;changed=true;}index++;};
      const geometry=mesh.geometry;
      check(mesh.visible);check(mesh.layers.mask);check(mesh.renderOrder);check(geometry);
      for(const value of mesh.matrix.elements)check(value);
      check(geometry.index);check(geometry.index?.version);
      check(geometry.drawRange.start);check(geometry.drawRange.count);
      for(const group of geometry.groups){check(group.start);check(group.count);check(group.materialIndex);}
      check(null);
      for(const name of Object.keys(geometry.attributes)){
        const attribute=geometry.attributes[name];check(name);check(attribute);
        if('data' in attribute){check(attribute.data);check(attribute.data.version);}
        else check(attribute.version);
      }
      check(null);
      for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
        check(material);check(material.version);check(material.visible);check(material.opacity);
      }
      if(previous.length!==index){previous.length=index;changed=true;}
    }
    if(changed)request();
  };
  model.onViewUpdated.add(update);
  return ()=>model.onViewUpdated.remove(update);
}

export function installDemandRendering(ctx:ViewerContext,renderer:SimpleRenderer):()=>void {
  const demand=new RenderDemand(renderer);
  const request=()=>demand.request(true);
  const unwatch=observeSceneChanges(ctx.world.scene.three,demand.request);
  const camera=ctx.world.camera as OrthoPerspectiveCamera;
  const controls=camera.controls;
  controls?.addEventListener('update',request);
  camera.projection.onChanged.add(request);
  camera.onAspectUpdated.add(request);
  ctx.world.onBeforeUpdate.add(demand.tick);
  renderer.onBeforeUpdate.add(demand.before);renderer.onAfterUpdate.add(demand.after);
  renderer.onResize.add(request);renderer.onClippingPlanesUpdated.add(request);
  const canvas=renderer.three.domElement;
  canvas.addEventListener('webglcontextrestored',request);
  document.addEventListener('visibilitychange',request);window.addEventListener('focus',request);
  const dispose=()=>{
    demand.dispose();unwatch();
    controls?.removeEventListener('update',request);
    camera.projection.onChanged.remove(request);camera.onAspectUpdated.remove(request);
    ctx.world.onBeforeUpdate.remove(demand.tick);
    renderer.onBeforeUpdate.remove(demand.before);renderer.onAfterUpdate.remove(demand.after);
    renderer.onResize.remove(request);renderer.onClippingPlanesUpdated.remove(request);
    canvas.removeEventListener('webglcontextrestored',request);
    document.removeEventListener('visibilitychange',request);window.removeEventListener('focus',request);
    renderer.onDisposed.remove(dispose);
  };
  renderer.onDisposed.add(dispose);demand.request(true);
  return dispose;
}
