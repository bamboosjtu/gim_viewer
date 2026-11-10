import {describe,it,expect,vi} from 'vitest';
import * as THREE from 'three';
import {RenderDemand,observeSceneChanges,observeFragmentVisualChanges,requestObjectRender,setRenderVisibility} from '../demandRendering.js';

describe('static viewer redraw policy',()=>{
  it('draws initially, stays idle, and merges scene-only changes into a bounded refresh',()=>{
    let now=0;const renderer={needsUpdate:false},policy=new RenderDemand(renderer,()=>now);
    policy.tick();expect(renderer.needsUpdate).toBe(true);
    renderer.needsUpdate=false;policy.before();now=100;policy.after();
    for(let i=0;i<50;i++){now++;policy.tick();}
    expect(renderer.needsUpdate).toBe(false);
    policy.request();policy.request();expect(renderer.needsUpdate).toBe(false);
    now=400;policy.tick();expect(renderer.needsUpdate).toBe(true);
    renderer.needsUpdate=false;policy.before();policy.after();
    now=1000;policy.tick();expect(renderer.needsUpdate).toBe(false);
  });
  it('camera/selection/resize invalidations bypass loading cooldown; redraws requested while drawing survive',()=>{
    let now=0;const renderer={needsUpdate:false},policy=new RenderDemand(renderer,()=>now);
    policy.before();now=500;policy.after();policy.request(true);
    expect(renderer.needsUpdate).toBe(true);
    renderer.needsUpdate=false;policy.before();policy.request();now=510;policy.after();
    now=590;policy.tick();expect(renderer.needsUpdate).toBe(true);
    policy.dispose();renderer.needsUpdate=false;policy.request(true);policy.tick();expect(renderer.needsUpdate).toBe(false);
  });
  it('observes appended subtrees without walking the full scene on every tick or mutation',()=>{
    const scene=new THREE.Scene(),root=new THREE.Group(),child=new THREE.Group();root.add(child);scene.add(root);
    const request=vi.fn(),release=observeSceneChanges(scene,request),traverse=vi.spyOn(scene,'traverse');
    const leaf=new THREE.Object3D();child.add(leaf);expect(request).toHaveBeenCalledWith(false);
    expect(traverse).not.toHaveBeenCalled();
    request.mockClear();requestObjectRender(leaf);expect(request).toHaveBeenCalledWith(true);
    request.mockClear();setRenderVisibility(leaf,false);expect(request).toHaveBeenCalledOnce();
    request.mockClear();setRenderVisibility(leaf,false);expect(request).not.toHaveBeenCalled();
    scene.remove(root);expect(request).toHaveBeenCalledWith(true);
    request.mockClear();child.add(new THREE.Object3D());requestObjectRender(leaf);expect(request).not.toHaveBeenCalled();
    scene.add(root);request.mockClear();requestObjectRender(leaf);expect(request).toHaveBeenCalledOnce();
    release();request.mockClear();requestObjectRender(leaf);scene.add(new THREE.Group());expect(request).not.toHaveBeenCalled();
  });
  it('reparenting objects removes the previous owner and targets the new scene only',()=>{
    const a=new THREE.Scene(),b=new THREE.Scene(),group=new THREE.Group(),leaf=new THREE.Object3D();group.add(leaf);a.add(group);
    const ra=vi.fn(),rb=vi.fn(),da=observeSceneChanges(a,ra),db=observeSceneChanges(b,rb);
    b.add(group);ra.mockClear();rb.mockClear();requestObjectRender(leaf);
    expect(ra).not.toHaveBeenCalled();expect(rb).toHaveBeenCalledWith(true);
    da();db();
  });
  it('ignores Fragments heartbeat completions and redraws actual public tile changes',()=>{
    const listeners=new Set<()=>void>(),event={add:(f:()=>void)=>listeners.add(f),remove:(f:()=>void)=>listeners.delete(f)};
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
    const model={object:new THREE.Group(),tiles:new Map([[1,mesh]]),onViewUpdated:event};
    const request=vi.fn(),release=observeFragmentVisualChanges(model,request),update=()=>listeners.forEach(f=>f());
    update();request.mockClear();for(let i=0;i<100;i++)update();expect(request).not.toHaveBeenCalled();
    const changed=(work:()=>void)=>{request.mockClear();work();update();expect(request).toHaveBeenCalledOnce();request.mockClear();update();expect(request).not.toHaveBeenCalled();};
    changed(()=>{mesh.geometry.attributes.position.needsUpdate=true;});
    changed(()=>{mesh.geometry.index!.needsUpdate=true;});
    changed(()=>{mesh.geometry.groups[0].count--;});
    changed(()=>{mesh.position.x=2;mesh.updateMatrix();});
    changed(()=>{mesh.material=new THREE.MeshBasicMaterial();});
    changed(()=>{mesh.visible=false;});
    const buffer=new THREE.InstancedInterleavedBuffer(new Float32Array(8),4);
    changed(()=>{mesh.geometry.setAttribute('itemFilter',new THREE.InterleavedBufferAttribute(buffer,2,0));});
    changed(()=>{buffer.needsUpdate=true;});
    changed(()=>{model.tiles.delete(1);});
    changed(()=>{model.tiles.set(1,new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()));});
    release();request.mockClear();mesh.visible=true;update();expect(request).not.toHaveBeenCalled();
  });
});
