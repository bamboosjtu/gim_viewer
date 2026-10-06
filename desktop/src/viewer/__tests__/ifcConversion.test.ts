import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AppState } from '../../app/state.js';
import { loadIfcEntry } from '../ifcEntryLoader.js';
import { registerModelEvents } from '../ifcLoader.js';
import { cancelIfcConversions } from '../ifcConversion.js';
import type { IfcConversionInput, IfcConversionOutput } from '../ifcConversionWorker.js';

class ConversionWorker {
  static instances: ConversionWorker[]=[];
  onmessage: ((event: MessageEvent<IfcConversionOutput>)=>void) | null=null;
  onerror: ((event: {message:string})=>void) | null=null;
  onmessageerror: (()=>void) | null=null;
  terminate=vi.fn(); input?: IfcConversionInput;
  constructor(public url:URL,public options:unknown) { ConversionWorker.instances.push(this); }
  postMessage(input:IfcConversionInput,transfer:Transferable[]) {
    this.input=structuredClone(input,{transfer});
  }
  reply(data:IfcConversionOutput) { this.onmessage?.({data} as MessageEvent<IfcConversionOutput>); }
}
function event<T>() {
  const listeners: ((value:T)=>void)[]=[];
  return {add:(handler:(value:T)=>void)=>listeners.push(handler),emit:(value:T)=>listeners.forEach(handler=>handler(value))};
}
function context(state:AppState) {
  const onItemSet=event<{value:any}>(),onBeforeDelete=event<{value:any}>(),onItemDeleted=event<string>();
  const models=Object.assign(new Map<string,any>(),{onItemSet,onBeforeDelete,onItemDeleted});
  const scene=new THREE.Scene();
  const ctx:any={world:{scene:{three:scene},camera:{three:{}}},ifcLoader:{
    settings:{wasm:{path:'http://tauri.localhost/wasm/',absolute:true},webIfc:{COORDINATE_TO_ORIGIN:false}},load:vi.fn()},
    fragments:{list:models,core:{settings:{autoCoordinate:false},update:vi.fn(),
      models:{materials:{list:{onItemSet:event()}}},
      load:vi.fn(async (bytes:Uint8Array,{modelId}:{modelId:string})=>{
        const model={modelId,object:new THREE.Group(),useCamera:vi.fn(),getBuffer:async()=>bytes.buffer};
        models.set(modelId,model);onItemSet.emit({value:model});return model;
      }),disposeModel:vi.fn((id:string)=>{const model=models.get(id);if(model){onBeforeDelete.emit({value:model});models.delete(id);onItemDeleted.emit(id);}})}}};
  registerModelEvents(ctx,state,{onModelAdded:vi.fn(),onModelRemoved:vi.fn()});
  return {ctx,models,scene};
}
const entry={name:'model.ifc',path:'CBM/model.ifc',modelId:'ifc-test'};
beforeEach(()=>{
  ConversionWorker.instances=[];vi.stubGlobal('Worker',ConversionWorker);
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{callback(0);return 0;});
  localStorage.setItem('gim-debug-fragments-cache','false');
});
afterEach(()=>{cancelIfcConversions();vi.unstubAllGlobals();localStorage.clear();});

it('raw entry transfers a dedicated input copy, preserves identity/settings and commits through real model events',async()=>{
  const state=new AppState(),session=state.activateProject(1,'sha'),{ctx,scene}=context(state);
  const input=new Uint8Array([1,2,3]),progress=vi.fn();
  const loading=loadIfcEntry(ctx,state,entry,async()=>input,progress,{session});
  await vi.waitFor(()=>expect(ConversionWorker.instances).toHaveLength(1));
  const worker=ConversionWorker.instances[0];
  expect(worker.options).toEqual({type:'module'});
  expect(Array.from(worker.input!.bytes)).toEqual(Array.from(input));expect(input.byteLength).toBe(3);
  expect(worker.input!.webIfcSettings).toEqual(ctx.ifcLoader.settings.webIfc);
  worker.reply({type:'progress',progress:0.4});expect(progress).toHaveBeenCalledWith(0.4);
  state.beginSelection({kind:'cbm',key:'B'}); // Selection cannot cancel reusable project resources.
  worker.reply({type:'complete',bytes:new Uint8Array([9,8]),conversionMs:123});await loading;
  expect(ctx.ifcLoader.load).not.toHaveBeenCalled();
  expect(ctx.fragments.core.load).toHaveBeenCalledWith(new Uint8Array([9,8]),{modelId:state.getRuntimeModelId(entry.modelId,session)});
  expect(ctx.fragments.core.settings.autoCoordinate).toBe(true);
  expect(state.loadedModels.has(entry.modelId)).toBe(true);expect(scene.children).toHaveLength(1);
  expect(worker.terminate).toHaveBeenCalledTimes(1);expect(input).toEqual(new Uint8Array([1,2,3]));
});

it('project cleanup terminates pending WASM and old messages cannot register into the new project',async()=>{
  const state=new AppState(),session=state.activateProject(1,'A'),{ctx,scene}=context(state);
  const loading=loadIfcEntry(ctx,state,entry,async()=>new Uint8Array([1]),undefined,{session});
  const settled=expect(loading).rejects.toThrow('obsolete project');
  await vi.waitFor(()=>expect(ConversionWorker.instances).toHaveLength(1));
  const worker=ConversionWorker.instances[0],late=worker.onmessage!;
  state.activateProject(2,'B');cancelIfcConversions();await settled;
  late({data:{type:'complete',bytes:new Uint8Array([9]),conversionMs:1}} as MessageEvent<IfcConversionOutput>);
  expect(ctx.fragments.core.load).not.toHaveBeenCalled();expect(scene.children).toHaveLength(0);
  expect(state.loadedModels.size).toBe(0);
});

it('a conversion failure remains a failed file; the next IFC can load without a blocking fallback',async()=>{
  const state=new AppState(),session=state.activateProject(1,'sha'),{ctx}=context(state);
  const failed=loadIfcEntry(ctx,state,entry,async()=>new Uint8Array([1]),undefined,{session});
  const rejected=expect(failed).rejects.toThrow('unsupported source');
  await vi.waitFor(()=>expect(ConversionWorker.instances).toHaveLength(1));
  ConversionWorker.instances[0].reply({type:'error',message:'unsupported source'});await rejected;
  const next={...entry,modelId:'ifc-next',path:'CBM/next.ifc'};
  const loaded=loadIfcEntry(ctx,state,next,async()=>new Uint8Array([2]),undefined,{session});
  await vi.waitFor(()=>expect(ConversionWorker.instances).toHaveLength(2));
  ConversionWorker.instances[1].reply({type:'complete',bytes:new Uint8Array([8]),conversionMs:1});await loaded;
  expect(state.loadedModels.has(entry.modelId)).toBe(false);expect(state.loadedModels.has(next.modelId)).toBe(true);
  expect(ctx.ifcLoader.load).not.toHaveBeenCalled();
});

it('worker startup failure reports failure instead of retrying synchronous conversion',async()=>{
  vi.stubGlobal('Worker',class {constructor(){throw new Error('worker unavailable');}});
  const state=new AppState(),session=state.activateProject(1,'sha'),{ctx}=context(state);
  await expect(loadIfcEntry(ctx,state,entry,async()=>new Uint8Array([1]),undefined,{session})).rejects.toThrow('worker unavailable');
  expect(ctx.ifcLoader.load).not.toHaveBeenCalled();expect(state.loadedModels.size).toBe(0);
});
