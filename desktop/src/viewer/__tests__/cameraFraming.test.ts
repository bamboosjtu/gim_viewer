import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { frameBox,fitCameraToScene,fitCameraToStationOverview } from '../camera.js';

it('moves the target and adjusts distance while preserving the current azimuth and elevation', async () => {
  const position=new THREE.Vector3(10,5,-8), target=new THREE.Vector3(2,1,3), before=position.clone().sub(target).normalize();
  const camera=new THREE.PerspectiveCamera(50,1.5),setLookAt=vi.fn(async()=>{});
  const ctx={world:{camera:{three:camera,controls:{getPosition:(out:THREE.Vector3)=>out.copy(position),getTarget:(out:THREE.Vector3)=>out.copy(target),setLookAt}}}} as any;
  const box=new THREE.Box3(new THREE.Vector3(10,20,30),new THREE.Vector3(14,26,38));await frameBox(ctx,box);
  const [x,y,z,tx,ty,tz]=setLookAt.mock.calls[0] as unknown as number[];
  expect([tx,ty,tz]).toEqual([12,23,34]);expect(new THREE.Vector3(x-tx,y-ty,z-tz).normalize().dot(before)).toBeCloseTo(1,10);
  expect(new THREE.Vector3(x-tx,y-ty,z-tz).length()).toBeGreaterThan(box.getSize(new THREE.Vector3()).length()/2);
});

it('does not move for an empty box or obsolete selection', async () => {
  const setLookAt=vi.fn(),ctx={world:{camera:{controls:{setLookAt}}}} as any;
  await frameBox(ctx,new THREE.Box3());await frameBox(ctx,new THREE.Box3(new THREE.Vector3(),new THREE.Vector3(1,1,1)),{isCurrent:()=>false,isSessionCurrent:()=>false});expect(setLookAt).not.toHaveBeenCalled();
});

function fixture(){
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,1.5,1,1000),ortho=new THREE.OrthographicCamera(-500,500,500,-500,1,1000);
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(650,80,650),new THREE.MeshBasicMaterial());scene.add(mesh);
  const controls={setLookAt:vi.fn(async(x:number,y:number,z:number,tx:number,ty:number,tz:number)=>{camera.position.set(x,y,z);camera.lookAt(tx,ty,tz);camera.updateMatrixWorld();}),
    getPosition:(out:THREE.Vector3)=>out.copy(camera.position),getTarget:(out:THREE.Vector3)=>out.set(0,0,0)};
  const ctx={world:{scene:{three:scene},camera:{three:camera,threePersp:camera,threeOrtho:ortho,controls}}}as any;
  return {ctx,scene,camera,ortho,mesh};
}
function expectDepthContained(camera:THREE.PerspectiveCamera,box:THREE.Box3){
  for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
    const depth=-new THREE.Vector3(x,y,z).applyMatrix4(camera.matrixWorldInverse).z;
    expect(depth).toBeGreaterThan(camera.near);expect(depth).toBeLessThan(camera.far);
  }
  expect(new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse)).intersectsBox(box)).toBe(true);
}
it('keeps a large station inside the depth range and prepares both projection cameras',()=>{
  const {ctx,camera,ortho,mesh}=fixture();
  expect(fitCameraToStationOverview(ctx,{hasFittedCamera:false})).toBe(true);
  const box=new THREE.Box3().setFromObject(mesh);expect(camera.position.length()).toBeGreaterThan(1000);
  expect(camera.far).toBeGreaterThan(1000);expect(ortho.far).toBe(camera.far);expectDepthContained(camera,box);
});

it('fills the viewport without clipping and uses the voltage preset instead of an inherited far plane',()=>{
  const {ctx,camera,ortho,mesh}=fixture();camera.far=10000;ortho.far=10000;
  fitCameraToStationOverview(ctx,{hasFittedCamera:false},{farPlane:6000,fillFraction:.8});
  expect(camera.far).toBe(6000);expect(ortho.far).toBe(6000);
  const box=new THREE.Box3().setFromObject(mesh);let extent=0;
  for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
    const p=new THREE.Vector3(x,y,z).project(camera);expect(Math.abs(p.x)).toBeLessThanOrEqual(.800001);expect(Math.abs(p.y)).toBeLessThanOrEqual(.800001);
    extent=Math.max(extent,Math.abs(p.x),Math.abs(p.y));
  }
  expect(extent).toBeCloseTo(.8,5);
});

it('does not let a hidden layer move the overview away from the visible model',()=>{
  const {ctx,scene,camera}=fixture(),hidden=new THREE.Group();hidden.visible=false;
  const distant=new THREE.Mesh(new THREE.BoxGeometry(650,80,650),new THREE.MeshBasicMaterial());distant.position.x=100000;hidden.add(distant);scene.add(hidden);
  fitCameraToStationOverview(ctx,{hasFittedCamera:false},{farPlane:6000});
  expect(camera.position.length()).toBeLessThan(2000);expect(camera.far).toBe(6000);
});
it('scene fit and explicit framing also expand depth, without shrinking a wider existing range',async()=>{
  const {ctx,camera,mesh}=fixture();fitCameraToScene(ctx,{hasFittedCamera:false});expectDepthContained(camera,new THREE.Box3().setFromObject(mesh));
  camera.far=10000;await frameBox(ctx,new THREE.Box3(new THREE.Vector3(-400,-100,-400),new THREE.Vector3(400,100,400)));
  expect(camera.far).toBe(10000);expectDepthContained(camera,new THREE.Box3().setFromObject(mesh));
});
it('close object framing retains tiny geometry in front of the near plane',async()=>{
  const {ctx,camera}=fixture();
  const tiny=new THREE.Box3(new THREE.Vector3(-.02,-.02,-.02),new THREE.Vector3(.02,.02,.02));
  camera.near=5;await frameBox(ctx,tiny);expectDepthContained(camera,tiny);expect(camera.near).toBeLessThan(1);
});
