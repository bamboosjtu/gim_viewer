import {expect,it,vi} from 'vitest';
import * as THREE from 'three';
import {AppState} from '../../app/state.js';
import {setupSelection} from '../selection.js';

function deferred<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }
function fixture() {
  const state=new AppState();state.activateProject(1,'sha');state.initialized=true;
  const container=document.createElement('div'),canvas=document.createElement('canvas');container.append(canvas);document.body.append(container);
  canvas.getBoundingClientRect=()=>({left:0,top:0,width:100,height:100} as DOMRect);
  const pick=vi.fn(),refine=vi.fn();
  state.deviceLodRuntime={pick,refine,clearSelection:vi.fn(),setOnlySelected:vi.fn(),diagnostics:{},select:vi.fn(),release:vi.fn()};
  const raycast=vi.fn();
  const fragments={list:new Map([['model',{object:new THREE.Group(),raycast,getVisible:async()=>[true]}]]),raycast,highlight:vi.fn(async()=>{}),resetHighlight:vi.fn(async()=>{})};
  const ctx={world:{camera:{three:new THREE.PerspectiveCamera()}},fragments} as any;
  const dev=vi.fn(),ifc=vi.fn();setupSelection(ctx,state,container,ifc,vi.fn(),undefined,dev);
  const click=()=>canvas.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:50,clientY:50}));
  return {state,container,pick,refine,fragments,dev,ifc,click};
}
it('rejects a delayed A pick after B has become the active source occurrence without requesting L2',async()=>{
  const f=fixture(),a=deferred<null>(),b=deferred<null>();
  f.pick.mockReturnValueOnce({rootOccurrence:'A',instanceKey:'instanceA',distance:2})
    .mockReturnValueOnce({rootOccurrence:'B',instanceKey:'instanceB',distance:2});
  f.fragments.raycast.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  f.click();f.click();b.resolve(null);
  await vi.waitFor(()=>expect(f.dev).toHaveBeenCalledOnce());
  expect(f.dev.mock.calls[0].slice(0,2)).toEqual(['B','instanceB']);
  a.resolve(null);await Promise.resolve();await Promise.resolve();
  expect(f.dev).toHaveBeenCalledOnce();expect(f.state.selectionRequest?.target).toEqual({kind:'cbm',key:'B'});
  expect(f.refine).not.toHaveBeenCalled();f.container.remove();
});
it('keeps the closest IFC hit ahead of a more distant DEV batch',async()=>{
  const f=fixture();f.pick.mockReturnValue({rootOccurrence:'A',instanceKey:'instanceA',distance:4});
  f.fragments.raycast.mockResolvedValue({localId:7,fragments:{modelId:'model'},rayDistance:1});
  f.click();await vi.waitFor(()=>expect(f.ifc).toHaveBeenCalledOnce());
  expect(f.dev).not.toHaveBeenCalled();expect(f.state.selectionRequest?.target?.key).toBe('model:7');
  expect(f.refine).not.toHaveBeenCalled();f.container.remove();
});
it('picks the visible DEV before replacing the previous only-selected visibility filter',async()=>{
  const f=fixture();f.state.onlySelected=true;
  let visible=true;
  f.state.deviceLodRuntime!.clearSelection=vi.fn(()=>{visible=false;});
  f.pick.mockImplementation(()=>visible ? {rootOccurrence:'A',instanceKey:'instanceA',distance:2} : null);
  f.fragments.raycast.mockResolvedValue(null);
  f.click();await vi.waitFor(()=>expect(f.dev).toHaveBeenCalledOnce());
  expect(visible).toBe(false);
  expect(f.dev.mock.calls[0].slice(0,2)).toEqual(['A','instanceA']);
  expect(f.state.selectionRequest?.target).toEqual({kind:'cbm',key:'A'});
  expect(f.refine).not.toHaveBeenCalled();f.container.remove();
});
