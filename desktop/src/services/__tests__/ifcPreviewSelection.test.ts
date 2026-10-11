import {beforeEach,it,expect,vi} from 'vitest';
import * as THREE from 'three';
import {AppState} from '../../app/state.js';
import type {IfcGeometryProvider,IfcPreviewObject} from '../../viewer/ifcGeometryProvider.js';
import {setupSelection} from '../../viewer/selection.js';

function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {resolve,promise};}
beforeEach(()=>{
  vi.resetModules();
  document.body.innerHTML='<div id="viewport"><canvas></canvas></div><button id="btn-toggle-props"></button><button id="btn-close-props"></button><button id="btn-export-props"></button><aside id="props-drawer"><div id="props-drawer-body"></div></aside><span id="status-selection"></span>';
});
function fixture(name='A') {
  const state=new AppState();state.activateProject(1,'source');
  const object:IfcPreviewObject={key:`ifc:model:object:${name==='A'?20:21}`,modelId:'model',sourcePath:'CBM/model.ifc',expressId:name==='A'?20:21,globalId:`GUID-${name}`,ifcType:'IFCMEMBER',name,provider:'ifc-preview'};
  const properties=deferred<any>(),root=new THREE.Group(),clearHighlight=vi.fn(),highlight=vi.fn();
  const provider:any={modelId:'model',root,level:1,data:{shapes:[{object}]},objectLOD:()=>1,canProvide:()=>true,getProperties:()=>properties.promise,
    fineState:'fineDeferred',subscribeFineState:()=>()=>{},cancelFineRequest:()=>false,setFineDeferred:vi.fn(),releaseMetadata:vi.fn(),
    findByGlobalId:()=>[object],clearHighlight,highlight,pick:()=>({object,distance:1}),loadLOD:vi.fn(async()=>{provider.level=2;provider.fineState='fineReady';}),retire:()=>{provider.level=2;},release:vi.fn()};
  state.ifcPreviewProviders.set('model',provider);
  const camera=new THREE.PerspectiveCamera(),ctx:any={world:{scene:{three:new THREE.Scene()},camera:{three:camera}},fragments:{list:new Map(),resetHighlight:vi.fn(async()=>{}),highlight:vi.fn(async()=>{}),core:{update:vi.fn()}}};
  return {state,object,provider:provider as IfcGeometryProvider,properties,ctx};
}
it('production preview inspector keeps B after A metadata finishes late',async()=>{
  const f=fixture(),b={...f.object,key:'ifc:model:object:21',expressId:21,name:'B',globalId:'GUID-B'};
  const {selectIfcPreview}=await import('../ifcPreviewService.js');
  const aReq=f.state.beginSelection({kind:'ifc-object',key:f.object.key});
  const a=selectIfcPreview(f.ctx,f.state,f.provider,f.object,aReq);
  const bProvider={...f.provider,level:1,objectLOD:()=>1,getProperties:async()=>({attributes:{Name:{value:'B-only'}},propertySets:[]})} as IfcGeometryProvider;
  const bReq=f.state.beginSelection({kind:'ifc-object',key:b.key});await selectIfcPreview(f.ctx,f.state,bProvider,b,bReq);
  f.properties.resolve({attributes:{Name:{value:'A-late'}},propertySets:[]});await a;
  expect(document.querySelector('.props-header')?.textContent).toContain('B');expect(document.body.textContent).not.toContain('A-late');
  expect(f.state.selectionRequest?.id).toBe(bReq.id);
});
it('project switch invalidates pending preview properties and releases providers',async()=>{
  const f=fixture(),{selectIfcPreview}=await import('../ifcPreviewService.js');
  const req=f.state.beginSelection({kind:'ifc-object',key:f.object.key}),pending=selectIfcPreview(f.ctx,f.state,f.provider,f.object,req);
  f.state.activateProject(2,'other');document.getElementById('props-drawer-body')!.textContent='new project';
  f.properties.resolve({attributes:{Name:{value:'obsolete'}},propertySets:[]});await pending;
  expect(document.getElementById('props-drawer-body')!.textContent).toBe('new project');expect(f.provider.release).toHaveBeenCalled();
});
it('fine status updates preserve properties already read for the current preview selection',async()=>{
  const f=fixture();let changed!:()=>void;
  f.provider.subscribeFineState=listener=>{changed=()=>listener('fineLoading');return()=>{};};
  const {selectIfcPreview}=await import('../ifcPreviewService.js');
  f.properties.resolve({attributes:{Name:{value:'retained-property'}},propertySets:[]});
  const request=f.state.beginSelection({kind:'ifc-object',key:f.object.key});
  await selectIfcPreview(f.ctx,f.state,f.provider,f.object,request);
  Object.assign(f.provider,{fineState:'fineLoading'});changed();
  (document.querySelector('[data-tab="params"]') as HTMLButtonElement)?.click();
  expect(document.getElementById('props-drawer-body')!.innerHTML).toContain('retained-property');
});
it('the real viewport entry picks preview with the canonical IFC identity',async()=>{
  const f=fixture();f.state.initialized=true;const selected=vi.fn(),canvas=document.querySelector('canvas')!,container=document.getElementById('viewport')!;
  canvas.getBoundingClientRect=()=>({left:0,top:0,width:100,height:100} as DOMRect);
  setupSelection(f.ctx,f.state,container,vi.fn(),vi.fn(),selected);
  canvas.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:50,clientY:50}));
  await vi.waitFor(()=>expect(f.provider.highlight).toHaveBeenCalledWith(f.object));
  expect(selected).toHaveBeenCalledWith(f.provider,f.object,f.state.selectionRequest);
  expect(f.state.selectionRequest?.target).toEqual({kind:'ifc-object',key:f.object.key});
});
it('actual inspector refine button retains the request and promotes through GUID to the existing fine model',async()=>{
  const f=fixture(),{selectIfcPreview}=await import('../ifcPreviewService.js');
  const runtime=f.state.getRuntimeModelId('model'),model={getLocalIdsByGuids:vi.fn(async()=>[88]),getItemsIds:async()=>[88],getGuidsByLocalIds:vi.fn(async()=>[f.object.globalId]),getItemsData:vi.fn(async()=>[{Name:{value:'Fine A'}}])};
  Object.assign(model,{getCoordinationMatrix:vi.fn(async()=>new THREE.Matrix4()),getMergedBox:vi.fn(async()=>new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(1,1,1))),getPositions:vi.fn(async()=>[new THREE.Vector3(.5,.5,.5)]),object:new THREE.Group()});
  f.ctx.fragments.baseCoordinationModel=runtime;f.ctx.fragments.baseCoordinationMatrix=new THREE.Matrix4();f.ctx.fragments.list.set(runtime,model);
  const request=f.state.beginSelection({kind:'ifc-object',key:f.object.key});
  f.properties.resolve({attributes:{Name:{value:'A'}},propertySets:[]});await selectIfcPreview(f.ctx,f.state,f.provider,f.object,request);
  (document.querySelector('[data-preview-refine]') as HTMLButtonElement).click();
  await vi.waitFor(()=>expect(f.ctx.fragments.highlight).toHaveBeenCalled());
  expect(f.provider.loadLOD).toHaveBeenCalledWith(2);expect(model.getLocalIdsByGuids).toHaveBeenCalledWith([f.object.globalId]);
  expect(f.state.selectionRequest).toBe(request);expect(request.target?.key).toBe(f.object.key);
  expect(f.state.selectionGeometry?.status).toBe('available');
});
it('late fine completion cannot highlight after another selection owns the request',async()=>{
  const f=fixture(),gate=deferred<(number|null)[]>(),runtime=f.state.getRuntimeModelId('model');
  f.ctx.fragments.list.set(runtime,{getLocalIdsByGuids:()=>gate.promise,getItemsIds:async()=>[88],getGuidsByLocalIds:async()=>[f.object.globalId]});
  const {promoteIfcPreviewSelection}=await import('../ifcPreviewService.js');
  const req=f.state.beginSelection({kind:'ifc-object',key:f.object.key}),pending=promoteIfcPreviewSelection(f.ctx,f.state,f.provider,req,f.object);
  const latest=f.state.beginSelection({kind:'cbm',key:'CBM/B.cbm'});gate.resolve([88]);await pending;
  expect(f.ctx.fragments.highlight).not.toHaveBeenCalled();expect(f.state.selectionRequest).toBe(latest);
});
it('duplicate GlobalIds keep ambiguity and never select the first fine candidate',async()=>{
  const f=fixture(),runtime=f.state.getRuntimeModelId('model'),lookup=vi.fn();f.ctx.fragments.list.set(runtime,{getLocalIdsByGuids:lookup});
  f.provider.findByGlobalId=()=>[f.object,{...f.object,expressId:21}];
  const {promoteIfcPreviewSelection}=await import('../ifcPreviewService.js');
  const req=f.state.beginSelection({kind:'ifc-object',key:f.object.key});await promoteIfcPreviewSelection(f.ctx,f.state,f.provider,req,f.object);
  expect(lookup).not.toHaveBeenCalled();expect(f.state.selectionGeometry?.status).toBe('ambiguous');
});

it('completed fine replacement releases metadata even after selection changes during conversion',async()=>{
  const f=fixture(),gate=deferred<void>(),started=deferred<void>();
  f.provider.loadLOD=vi.fn(async()=>{started.resolve();await gate.promise;Object.assign(f.provider,{level:2,fineState:'fineReady'});});
  const {selectIfcPreview}=await import('../ifcPreviewService.js');
  f.properties.resolve({attributes:{Name:{value:'A'}},propertySets:[]});
  const request=f.state.beginSelection({kind:'ifc-object',key:f.object.key});
  await selectIfcPreview(f.ctx,f.state,f.provider,f.object,request);
  (document.querySelector('[data-preview-refine]') as HTMLButtonElement).click();await started.promise;
  const latest=f.state.beginSelection({kind:'cbm',key:'CBM/B.cbm'});
  document.getElementById('props-drawer-body')!.textContent='B inspector';gate.resolve();
  await vi.waitFor(()=>expect(f.provider.releaseMetadata).toHaveBeenCalledTimes(1));
  expect(f.ctx.fragments.highlight).not.toHaveBeenCalled();
  expect(document.getElementById('props-drawer-body')!.textContent).toBe('B inspector');
  expect(f.state.selectionRequest).toBe(latest);
});
it.each([0,2])('inverse Fragments lookup preserves %s candidates despite its lossy forward Map',async(count)=>{
  const f=fixture(),runtime=f.state.getRuntimeModelId('model');
  const model={getLocalIdsByGuids:vi.fn(async()=>count?[88]:[null]),getItemsIds:async()=>count?[88,99]:[],
    getGuidsByLocalIds:vi.fn(async()=>[f.object.globalId,f.object.globalId]),getMergedBox:vi.fn(),getCoordinationMatrix:vi.fn()};
  f.ctx.fragments.list.set(runtime,model);
  const {promoteIfcPreviewSelection,captureIfcPreviewReplacementDiagnostic}=await import('../ifcPreviewService.js');
  const req=f.state.beginSelection({kind:'ifc-object',key:f.object.key});
  await promoteIfcPreviewSelection(f.ctx,f.state,f.provider,req,f.object);
  expect(f.state.selectionGeometry?.status).toBe(count?'ambiguous':'unlinked');
  expect(f.ctx.fragments.highlight).not.toHaveBeenCalled();
  expect(await captureIfcPreviewReplacementDiagnostic(f.ctx,f.state,f.provider,req,f.object)).toBeNull();
  expect(model.getCoordinationMatrix).not.toHaveBeenCalled();expect(model.getMergedBox).not.toHaveBeenCalled();
  expect(model.getLocalIdsByGuids).toHaveBeenCalledTimes(1);
});
