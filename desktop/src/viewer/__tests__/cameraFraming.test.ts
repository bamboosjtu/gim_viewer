import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { frameBox } from '../camera.js';

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
