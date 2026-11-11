import {expect, it} from 'vitest';
import * as THREE from 'three';
import {BoxViewIndex} from '../boxViewIndex.js';

it('matches a full box/frustum scan including long crossing, mirror, scale and coordinate updates', () => {
  const index = new BoxViewIndex(), boxes = new Map<string, THREE.Box3>();
  for (let i = 0; i < 2048; i++) {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))
      .applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3((i % 32) * 8 - 128, Math.floor(i / 32) * 5 - 160, -40),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, i / 50, .2)), new THREE.Vector3(i % 2 ? -2 : 1, 3, 1)));
    boxes.set(String(i), box); index.set(String(i), box);
  }
  const long = new THREE.Box3(new THREE.Vector3(-1000, -1, -30), new THREE.Vector3(1000, 1, -29));
  boxes.set('long', long); index.set('long', long);
  const camera = new THREE.PerspectiveCamera(50, 1.5, .1, 500);
  for (const x of [0, 25, -70]) {
    camera.position.set(x, 0, 20); camera.lookAt(x, 0, -30); camera.updateMatrixWorld(true);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const expected = [...boxes].filter(([,box]) => frustum.intersectsBox(box)).map(([key]) => key).sort();
    expect([...index.query(frustum)].sort()).toEqual(expected);
    expect(index.diagnostics.testedBoxes).toBeLessThan(boxes.size / 2);
  }
  expect(index.diagnostics.rebuilds).toBe(1);
  const moved = long.clone().translate(new THREE.Vector3(0, 10000, 0)); index.set('long', moved);
  index.set('0', null);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  expect(index.query(frustum).has('long')).toBe(false);
  expect(index.diagnostics.entries).toBe(2048);
  expect(index.diagnostics.rebuilds).toBe(1);
  index.clear(); expect(index.query(frustum).size).toBe(0);
});

it('updates a stationary view from changed bounds only, then rebuilds for a moved camera', () => {
  const index = new BoxViewIndex(), boxes = new Map<string, THREE.Box3>();
  const camera = new THREE.PerspectiveCamera(50, 1.5, .1, 500);
  camera.position.set(0,0,20); camera.lookAt(0,0,-30); camera.updateMatrixWorld(true);
  const frustum = () => new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  const expected = (view:THREE.Frustum) => [...boxes].filter(([,box])=>view.intersectsBox(box)).map(([key])=>key).sort();
  index.query(frustum());
  for(let i=0;i<80;i++) {
    const key=String(i%23),box=new THREE.Box3(new THREE.Vector3(i-40,-1,-30),new THREE.Vector3(i-38,1,-28));
    boxes.set(key,box);index.set(key,box);
    if(i%4===0){const removed=String((i+3)%23);boxes.delete(removed);index.set(removed,null);}
    const view=frustum(),result=index.query(view);
    expect([...result].sort()).toEqual(expected(view));
    expect(index.diagnostics.testedBoxes).toBeLessThanOrEqual(1);
    expect(index.diagnostics.visitedNodes).toBe(0);
    result.clear(); // Callers cannot mutate the next query's cached result.
  }
  expect(index.diagnostics.rebuilds).toBe(1);
  camera.position.x=60;camera.lookAt(60,0,-30);camera.updateMatrixWorld(true);
  const moved=frustum();expect([...index.query(moved)].sort()).toEqual(expected(moved));
  expect(index.diagnostics.rebuilds).toBe(2);
  index.clear();expect(index.query(moved).size).toBe(0);
  const added=new THREE.Box3(new THREE.Vector3(59,-1,-30),new THREE.Vector3(61,1,-29));
  index.set('new',added);expect([...index.query(moved)]).toEqual(['new']);
});

it('queries moving views through bounded changed entries without rebuilding each catalog reply',()=>{
  const index=new BoxViewIndex(),boxes=new Map<string,THREE.Box3>(),camera=new THREE.PerspectiveCamera(50,1.5,.1,500);
  for(let i=0;i<400;i++) {
    const box=new THREE.Box3(new THREE.Vector3((i%20)*5-50,Math.floor(i/20)*5-50,-40),new THREE.Vector3((i%20)*5-48,Math.floor(i/20)*5-48,-38));
    boxes.set(String(i),box);index.set(String(i),box);
  }
  const view=(x:number)=>{camera.position.set(x,0,20);camera.lookAt(x,0,-30);camera.updateMatrixWorld(true);return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));};
  const check=(frustum:THREE.Frustum)=>expect([...index.query(frustum)].sort()).toEqual([...boxes].filter(([,b])=>frustum.intersectsBox(b)).map(([key])=>key).sort());
  check(view(0));
  for(let i=0;i<40;i++) {
    const key=String(i),box=boxes.get(key)!.clone().translate(new THREE.Vector3(150,0,0));
    boxes.set(key,box);index.set(key,box);
    if(i%4===0){const removed=String(300+i);boxes.delete(removed);index.set(removed,null);}
    check(view(100+i)); // New bounds lie outside their old tree branches.
  }
  expect(index.diagnostics.rebuilds).toBe(1);
  for(const [key,box]of boxes){const moved=box.clone().translate(new THREE.Vector3(-100,0,0));boxes.set(key,moved);index.set(key,moved);}
  check(view(-20));expect(index.diagnostics.rebuilds).toBe(2);
});
