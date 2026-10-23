import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { raycastVisibleIfc } from '../ifcVisibleRaycast.js';

function fixture() {
  const make=(id:string,distance:number)=>{
    const model={object:new THREE.Group(),raycast:vi.fn(async()=>({localId:1,distance,fragments:{modelId:id}})),
      raycastAll:vi.fn(),getVisible:vi.fn(async(ids:number[])=>ids.map(()=>true))};
    return model;
  };
  const a=make('A',1),b=make('B',2),ctx={fragments:{list:new Map([['A',a],['B',b]])}} as any;
  const data={camera:new THREE.PerspectiveCamera(),mouse:new THREE.Vector2(),dom:document.createElement('canvas')};
  return {a,b,ctx,data};
}
it('does not raycast hidden sources, including sources hidden by an ancestor',async()=>{
  const f=fixture();f.a.object.visible=false;
  expect((await raycastVisibleIfc(f.ctx,f.data))?.fragments.modelId).toBe('B');
  expect(f.a.raycast).not.toHaveBeenCalled();
  const parent=new THREE.Group();parent.visible=false;parent.add(f.b.object);
  expect(await raycastVisibleIfc(f.ctx,f.data)).toBe(null);
});
it('keeps a visible item behind an invisible nearest item selectable',async()=>{
  const f=fixture();f.b.object.visible=false;
  f.a.getVisible.mockImplementation(async ids=>ids.map(id=>id===2));
  f.a.raycastAll.mockResolvedValue([{localId:1,distance:1},{localId:2,distance:3,fragments:{modelId:'A'}}]);
  const hit=await raycastVisibleIfc(f.ctx,f.data);
  expect(hit?.localId).toBe(2);expect(f.a.raycastAll).toHaveBeenCalledOnce();
});
it('a layer hidden while its raycast is pending cannot publish a hit',async()=>{
  const f=fixture();f.b.object.visible=false;let unblock!:(value:any)=>void;
  f.a.raycast.mockImplementation(()=>new Promise(resolve=>{unblock=resolve;}));
  const pending=raycastVisibleIfc(f.ctx,f.data);f.a.object.visible=false;
  unblock({localId:1,distance:1});expect(await pending).toBe(null);
});
it('isolates a failed source while picking the closest remaining visible source',async()=>{
  const f=fixture();const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try {f.a.raycast.mockRejectedValue(Error('source unavailable'));
    expect((await raycastVisibleIfc(f.ctx,f.data))?.fragments.modelId).toBe('B');
    expect(warning).toHaveBeenCalledOnce();
  } finally {warning.mockRestore();}
});
