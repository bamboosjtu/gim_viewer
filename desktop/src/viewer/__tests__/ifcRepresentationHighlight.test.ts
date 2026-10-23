import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { addModHighlightGroup, commitSelectionHighlight, enqueueHighlightCommit,
  highlightModGroups, removeModHighlightGroup, resetModHighlight } from '../highlight.js';
import { syncIfcRepresentationHighlight } from '../ifcRepresentationHighlight.js';
import { IfcRegionalRuntime } from '../ifcRegionalRuntime.js';
import type { ObjectFineResult } from '../ifcObjectFineData.js';

const object = {expressId:7,globalId:'g7',ifcType:'IFCWALL',name:'wall',bounds:[0,0,0,1,1,1]};
function group(id=7) {
  const root = new THREE.Group(); root.userData={modelId:'source',expressId:id,provider:'ifc-regional'};
  root.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial())); return root;
}
function fixture() {
  const state = new AppState();
  const ctx:any={fragments:{highlight:vi.fn(async()=>{}),resetHighlight:vi.fn(async()=>{})}};
  const migrate = (value:THREE.Group|undefined,local=17,current=()=>true,prepare?:()=>void) =>
    syncIfcRepresentationHighlight(ctx,state,'runtime','source',object,value,local,current,prepare);
  const select = async (regional=false) => {
    const request=state.beginSelection(regional ? {kind:'ifc-object',key:'ifc:source:object:7'}
      : {kind:'ifc-element',key:'runtime:17'});
    await commitSelectionHighlight(ctx,state,state.selectionGuard(request),()=> {
      if (!regional) state.highlightedItems={runtime:[17]};
    }); return request;
  };
  return {state,ctx,migrate,select};
}
afterEach(()=>{vi.restoreAllMocks();});

it('migrates far highlight to L2 without resetting Fragments, re-highlighting other meshes or changing selection ownership',async()=>{
  const f=fixture();await f.select(); const fine=group(),other=group(8);
  addModHighlightGroup(f.state,other); const otherMaterial=(other.children[0] as THREE.Mesh).material;
  const request=f.state.selectionRequest;
  await f.migrate(fine); const material=(fine.children[0] as THREE.Mesh).material;
  await f.migrate(fine);
  expect(f.state.highlightedModState?.groups).toEqual([other,fine]);
  expect((other.children[0] as THREE.Mesh).material).toBe(otherMaterial);
  expect((fine.children[0] as THREE.Mesh).material).toBe(material);
  expect(f.ctx.fragments.highlight).not.toHaveBeenCalled();expect(f.ctx.fragments.resetHighlight).not.toHaveBeenCalled();
  expect(f.state.selectionRequest).toBe(request);expect(f.state.highlightedItems).toEqual({runtime:[17]});
  resetModHighlight(f.state);
});

it('restores only the departing material clones, then returns a regional selection to highlighted far geometry',async()=>{
  const f=fixture();await f.select(true); const old=group(),other=group(8),fine=group();
  const original=(old.children[0] as THREE.Mesh).material;
  highlightModGroups(f.state,[old,other]);
  const clone=(old.children[0] as THREE.Mesh).material as THREE.Material,dispose=vi.spyOn(clone,'dispose');
  const otherMaterial=(other.children[0] as THREE.Mesh).material;
  removeModHighlightGroup(f.state,old);await f.migrate(fine);
  expect(dispose).toHaveBeenCalledOnce();expect((old.children[0] as THREE.Mesh).material).toBe(original);
  expect((other.children[0] as THREE.Mesh).material).toBe(otherMaterial);
  removeModHighlightGroup(f.state,fine);await f.migrate(undefined);
  expect(f.ctx.fragments.highlight).toHaveBeenCalledOnce();
  expect(f.state.highlightedItems).toEqual({runtime:[17]});
  await f.migrate(undefined);expect(f.ctx.fragments.highlight).toHaveBeenCalledOnce();
  resetModHighlight(f.state);
});

it('does no geometry traversal for unrelated replacements and rejects an obsolete representation',async()=>{
  const f=fixture();await f.select();const replacement=group(),traverse=vi.spyOn(replacement,'traverse');
  await f.migrate(replacement,18);await f.migrate(replacement,17,()=>false);
  expect(traverse).not.toHaveBeenCalled();expect(f.state.highlightedModState).toBeNull();
});

it('waits for the far selection commit before migrating its representation',async()=>{
  const f=fixture();const request=f.state.beginSelection({kind:'ifc-element',key:'runtime:17'});
  let finish!:()=>void;
  const commit=commitSelectionHighlight(f.ctx,f.state,f.state.selectionGuard(request),async()=>{
    await new Promise<void>(resolve=>{finish=resolve;});f.state.highlightedItems={runtime:[17]};
  });
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  const replacement=group(),migration=f.migrate(replacement);finish();await Promise.all([commit,migration]);
  expect(f.state.highlightedModState?.groups).toEqual([replacement]);resetModHighlight(f.state);
});

it('does not apply a queued A migration after selection moves to B or the project changes',async()=>{
  const f=fixture();const a=await f.select();let finish!:()=>void;
  const blocking=enqueueHighlightCommit(f.state,f.state.selectionGuard(a),()=>new Promise<void>(resolve=>{finish=resolve;}));
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  const old=f.migrate(group());f.state.beginSelection({kind:'ifc-element',key:'runtime:18'});
  finish();await Promise.all([blocking,old]);expect(f.state.highlightedModState).toBeNull();
  f.state.activateProject(2,'new');await f.migrate(group());expect(f.state.highlightedModState).toBeNull();
});

it('keeps an in-flight far restore resettable by the next selection',async()=>{
  const f=fixture();await f.select(true);let finish!:()=>void;
  f.ctx.fragments.highlight.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const old=f.migrate(undefined);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  const b=f.state.beginSelection({kind:'ifc-element',key:'runtime:18'});
  const next=commitSelectionHighlight(f.ctx,f.state,f.state.selectionGuard(b),()=>{f.state.highlightedItems={runtime:[18]};});
  finish();await Promise.all([old,next]);
  expect(f.ctx.fragments.resetHighlight).toHaveBeenCalledWith({runtime:[17]});
  expect(f.state.highlightedItems).toEqual({runtime:[18]});
});

function runtimeFixture() {
  const f=fixture();
  Object.assign(f.ctx,{world:{scene:{three:new THREE.Scene()},camera:{controls:{addEventListener:vi.fn(),removeEventListener:vi.fn()}}}});
  f.ctx.fragments.list={onBeforeDelete:{add:vi.fn(),remove:vi.fn()}};
  f.ctx.ifcLoader={settings:{wasm:{path:'/',absolute:true}}};
  const model={modelId:'runtime',object:new THREE.Group(),setVisible:vi.fn(async()=>{})};
  const runtime=new IfcRegionalRuntime('source','CBM/source.ifc',{objects:[object],unitScale:1,openingRelations:[]},{
    ctx:f.ctx,model,readBytes:vi.fn(),cacheKey:'key',sourceToViewer:new THREE.Matrix4(),isCurrent:()=>true,
    onBeforeDisposeGroup:g=>removeModHighlightGroup(f.state,g),
    onRepresentationChanged:(_object,g,local,current,prepare)=>f.migrate(g,local,current,prepare),
  });
  const internal=runtime as any;internal.schedule=vi.fn();if(internal.timer)clearTimeout(internal.timer);
  const result:ObjectFineResult={...object,parts:[{vertices:new Float32Array([0,0,0,0,0,1,1,0,0,0,0,1,0,1,0,0,0,1]),
    indices:new Uint32Array([0,1,2]),matrix:new THREE.Matrix4().toArray(),color:[1,1,1,1]}],geometryMs:1,wasmHeapBytes:0,coordinationMatrix:new THREE.Matrix4().toArray()};
  const fine={load:vi.fn(async()=>result),forget:vi.fn(),cancel:vi.fn(),release:vi.fn()};
  internal.fineRuntime=fine;internal.guidIds=Promise.resolve(new Map([['g7',[17]]]));
  return {...f,runtime,internal,model,fine,result};
}

it.each([false,true])('runtime swaps far/regional=%s to highlighted L2 and returns without recomputing precision',async regional=>{
  const f=runtimeFixture();await f.select(regional);
  if(regional){const old=group();f.runtime.root.add(old);f.internal.groups.set(7,old);f.internal.localIds.set(7,17);highlightModGroups(f.state,[old]);}
  try {
    const [a,b]=await Promise.all([f.runtime.refine(object),f.runtime.refine(object)]);
    expect(a).toBe(b);expect(a?.userData.lod).toBe(2);expect(f.fine.load).toHaveBeenCalledOnce();
    expect(f.state.highlightedModState?.groups).toEqual([a]);
    f.runtime.releaseFine(7);
    await vi.waitFor(()=>expect(f.state.highlightedItems).toEqual({runtime:[17]}));
    expect(f.state.highlightedModState).toBeNull();expect(f.fine.load).toHaveBeenCalledOnce();
    expect(f.model.setVisible).toHaveBeenLastCalledWith([17],true);
  } finally {f.runtime.release();}
});

it('cancel and failure preserve browse highlight and reject late L2 without highlighting B',async()=>{
  const f=runtimeFixture();await f.select();let finish!:(value:ObjectFineResult)=>void;
  try {
    f.fine.load.mockRejectedValueOnce(Error('precision failed'));
    await expect(f.runtime.refine(object)).rejects.toThrow('precision failed');
    expect(f.state.highlightedItems).toEqual({runtime:[17]});expect(f.internal.groups.size).toBe(0);
    f.fine.load.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const late=f.runtime.refine(object);f.runtime.releaseFine(7);
    f.state.beginSelection({kind:'ifc-element',key:'runtime:18'});finish(f.result);
    await expect(late).resolves.toBeUndefined();expect(f.internal.groups.size).toBe(0);
    expect(f.state.highlightedModState).toBeNull();
  } finally {f.runtime.release();}
});

it('adds only the selected instanced L1 overlay when a far representation is replaced',async()=>{
  const f=runtimeFixture();await f.select();
  const coarse=new THREE.Group();coarse.userData={modelId:'source',expressId:7,provider:'ifc-regional',lod:1};
  f.runtime.root.add(coarse);f.internal.groups.set(7,coarse);
  f.internal.instances.add({...f.result,ifcType:'IFCFASTENER',parts:f.result.parts.map(p=>({...p,geometryId:9}))});
  try {
    await f.internal.representationChanged(object,coarse,17);
    expect(coarse.children).toHaveLength(1);expect(f.state.highlightedModState?.originalMaterials.size).toBe(1);
    const material=(coarse.children[0] as THREE.Mesh).material;
    await f.internal.representationChanged(object,coarse,17);
    expect((coarse.children[0] as THREE.Mesh).material).toBe(material);
  } finally {f.runtime.release();}
});

it('retains the old highlighted L1 when a precision commit fails',async()=>{
  const f=runtimeFixture();await f.select(true);const old=group();old.userData.lod=1;
  f.runtime.root.add(old);f.internal.groups.set(7,old);f.internal.localIds.set(7,17);
  highlightModGroups(f.state,[old]);const material=(old.children[0] as THREE.Mesh).material;
  f.model.setVisible.mockRejectedValueOnce(Error('visibility failed'));
  try {
    await expect(f.runtime.refine(object)).rejects.toThrow('visibility failed');
    expect(f.internal.groups.get(7)).toBe(old);expect(old.parent).toBe(f.runtime.root);
    expect(f.state.highlightedModState?.groups).toEqual([old]);
    expect((old.children[0] as THREE.Mesh).material).toBe(material);
  } finally {f.runtime.release();}
});

it('a cancelled commit cannot remove or unhighlight a newer retry of the same object',async()=>{
  const f=runtimeFixture();await f.select();let finish!:()=>void;
  f.model.setVisible.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
  try {
    const old=f.runtime.refine(object);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    f.runtime.releaseFine(7);
    const replacement=await f.runtime.refine(object);finish();
    await expect(old).resolves.toBeUndefined();
    expect(f.internal.groups.get(7)).toBe(replacement);
    expect(f.state.highlightedModState?.groups).toEqual([replacement]);
    expect(f.model.setVisible).toHaveBeenLastCalledWith([17],false);
    expect(f.fine.load).toHaveBeenCalledTimes(2);
  } finally {f.runtime.release();}
});
