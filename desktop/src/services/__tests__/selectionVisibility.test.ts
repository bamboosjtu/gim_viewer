import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { createSelectionVisibility } from '../selectionVisibility.js';

function fixture() {
  const state=new AppState();state.activateProject(1,'sha');
  const update=vi.fn(async()=>{}),api=createSelectionVisibility(state,{fragments:{core:{update}}} as any);
  state.selectionVisibility=api;
  const preview={setSelectionScope:vi.fn(),release:vi.fn()};state.substationConnectionPreview=preview as any;
  const make=(id:string)=>{
    const visibility=new Map([[1,true],[2,true]]);
    const model={modelId:id,object:new THREE.Group(),getItemsIdsWithGeometry:vi.fn(async()=>[1,2]),
      getVisible:vi.fn(async(ids:number[])=>ids.map(id=>visibility.get(id)!)),
      setVisible:vi.fn(async(ids:number[]|undefined,value:boolean)=>{for(const id of ids??[])visibility.set(id,value);}),
      getGuidsByLocalIds:vi.fn(async(ids:number[])=>ids.map(id=>`g${id}`)),
      getLocalIdsByGuids:vi.fn(async(ids:string[])=>ids.map(id=>Number(id.slice(1)))),};
    const runtime={index:{objects:[{expressId:101,globalId:'g1'},{expressId:102,globalId:'g2'}]},
      setSelectionScope:vi.fn(),setOnlySelected:vi.fn(),refreshVisibility:vi.fn(),clearSelectionFilter:vi.fn(),clearFineSelection:vi.fn(),release:vi.fn()};
    state.ifcRegionalRuntimes.set(id,runtime as any);api.registerModel(id,model);
    return {model,runtime,visibility};
  };
  const a=make('A'),b=make('B');
  const select=(target='selected')=>{const request=state.beginSelection({kind:'cbm',key:target});state.selectionHighlightRequestId=request.id;return request;};
  return {state,api,a,b,preview,select,update};
}
it('ordinary selection does not enumerate IFC visibility or force a scene update',async()=>{
  const f=fixture();f.select();f.state.highlightedItems={A:[1]};await f.api.sync();
  expect(f.a.model.getVisible).not.toHaveBeenCalled();expect(f.a.model.getGuidsByLocalIds).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();expect(f.preview.setSelectionScope).not.toHaveBeenCalled();
});
it('a DEV selection hides every IFC representation and restores source-layer visibility',async()=>{
  const f=fixture();f.select();f.state.onlySelected=true;
  const selected=new THREE.Group(),other=new THREE.Group(),hidden=new THREE.Group();hidden.visible=false;
  f.state.loadedXmlModGroups.set('selected',selected);f.state.loadedXmlModGroups.set('other',other);f.state.loadedStlGroups.set('hidden',hidden);
  f.state.highlightedModState={groups:[selected],originalMaterials:new Map()};
  f.api.setModelVisible('B',false);await f.api.sync();
  expect(f.a.model.object.visible).toBe(false);expect(f.b.model.object.visible).toBe(false);
  expect(f.a.runtime.setSelectionScope).toHaveBeenLastCalledWith(true,new Set());
  expect(selected.visible).toBe(true);expect(other.visible).toBe(false);
  const scopes=f.preview.setSelectionScope.mock.lastCall![1];
  expect([...scopes.values()].every((scope:any)=>!scope.localIds.size&&!scope.globalIds.size&&!scope.expressIds.size)).toBe(true);
  f.state.onlySelected=false;await f.api.sync();
  expect(f.a.model.object.visible).toBe(true);expect(f.b.model.object.visible).toBe(false);
  expect(other.visible).toBe(true);expect(hidden.visible).toBe(false);
});
it('an exact far pick selects its matching regional and connection identity, never another source',async()=>{
  const f=fixture();f.select();f.state.highlightedItems={A:[2]};f.state.onlySelected=true;
  await f.api.sync();
  expect([...f.a.visibility.values()]).toEqual([false,true]);expect(f.b.model.object.visible).toBe(false);
  expect(f.a.runtime.setSelectionScope).toHaveBeenLastCalledWith(true,new Set([102]));
  const scopes=f.preview.setSelectionScope.mock.lastCall![1];
  expect(scopes.get('A').globalIds).toEqual(new Set(['g2']));
});
it('a regional pick preserves its far counterpart and multiple explicit source references',async()=>{
  const f=fixture();f.select();f.state.onlySelected=true;
  const group=new THREE.Group();group.userData={provider:'ifc-regional',modelId:'A',expressId:101,globalId:'g1'};
  f.state.highlightedModState={groups:[group],originalMaterials:new Map()};f.state.highlightedItems={B:[2]};
  await f.api.sync();
  expect([...f.a.visibility.values()]).toEqual([true,false]);expect([...f.b.visibility.values()]).toEqual([false,true]);
  expect(f.a.runtime.setSelectionScope).toHaveBeenLastCalledWith(true,new Set([101]));
});
it('keeps committed source identity after precision replaces the highlighted regional group',async()=>{
  const f=fixture(),request=f.select();
  const group=new THREE.Group();group.userData={provider:'ifc-regional',modelId:'A',expressId:101,globalId:'g1'};
  f.state.highlightedModState={groups:[group],originalMaterials:new Map()};
  await f.api.sync(f.state.selectionGuard(request));
  f.state.highlightedModState=null;group.clear();
  f.state.onlySelected=true;await f.api.sync();
  expect([...f.a.visibility.values()]).toEqual([true,false]);
  expect(f.a.runtime.setSelectionScope).toHaveBeenLastCalledWith(true,new Set([101]));
  const late={...f.b.model,modelId:'late',object:new THREE.Group()};f.api.registerModel('late',late);
  await f.api.sync();expect(f.a.model.object.visible).toBe(true);expect(late.object.visible).toBe(false);
});
it('does not pick an arbitrary regional object for an ambiguous GUID and clears all on empty selection',async()=>{
  const f=fixture();f.a.runtime.index.objects.push({expressId:999,globalId:'g1'});
  f.select();f.state.onlySelected=true;f.state.highlightedItems={A:[1]};await f.api.sync();
  expect(f.a.runtime.setSelectionScope).toHaveBeenLastCalledWith(true,new Set());
  f.state.beginSelection(null);await f.api.sync();
  expect(f.a.model.object.visible).toBe(false);expect(f.b.model.object.visible).toBe(false);
});
it('rejects late A identity lookups after B owns the selection',async()=>{
  const f=fixture();const a=f.select('A');f.state.onlySelected=true;f.state.highlightedItems={A:[1]};
  let unblock!:(ids:string[])=>void;
  f.a.model.getGuidsByLocalIds.mockImplementationOnce(()=>new Promise(resolve=>{unblock=resolve;}));
  const old=f.api.sync(f.state.selectionGuard(a));await vi.waitFor(()=>expect(unblock).toBeTypeOf('function'));
  const b=f.select('B');f.state.highlightedItems={B:[2]};await f.api.sync(f.state.selectionGuard(b));
  unblock(['g1']);await old;
  expect(f.a.model.object.visible).toBe(false);expect([...f.b.visibility.values()]).toEqual([false,true]);
});
it('a late-loaded model is immediately isolated and an old removal cannot remove its replacement',async()=>{
  const f=fixture();f.select();f.state.onlySelected=true;await f.api.sync();
  const late={...f.a.model,modelId:'late',object:new THREE.Group()};f.api.registerModel('A',late);
  expect(late.object.visible).toBe(false);f.api.removeModel('A','A');await f.api.sync();
  expect(late.object.visible).toBe(false);
  f.state.onlySelected=false;await f.api.sync();expect(late.object.visible).toBe(true);
  f.state.resetGimState();expect(f.state.selectionHighlightRequestId).toBe(null);
});
