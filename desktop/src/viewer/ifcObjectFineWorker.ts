import { IfcAPI } from 'web-ifc';
import { createWorkerProbe, sampleWasmCapacity } from '../measurement/workerProbe.js';
import { extractIfcObjectFine } from './ifcObjectFineData.js';

const api=new IfcAPI();let model:number|null=null;
self.onmessage=createWorkerProbe().wrap(async({data},trace)=>{
  try {
    if(data.type==='open'){
      if(model!==null)throw new Error('Object worker already open');
      const init=performance.now();api.SetWasmPath(data.wasm.path,data.wasm.absolute);await trace.measure('ifc.wasm-init', () => api.Init(undefined,true));
      const opened=performance.now();model=trace.sync('ifc.open-model', () => api.OpenModel(data.bytes,{...data.webIfcSettings,COORDINATE_TO_ORIGIN:false}));
      sampleWasmCapacity(trace,api);trace.produced({ inputBytes: data.bytes.byteLength });
      trace.reply({id:data.id,data:{initMs:opened-init,openMs:performance.now()-opened,
        inputBytes:data.bytes.byteLength,wasmHeapBytes:(api as any).wasmModule.HEAPU8.byteLength}});
    } else if(data.type==='object'){
      if(model===null)throw new Error('Object worker not open');
      const result=trace.sync('ifc.mesh-extraction', () => extractIfcObjectFine(api,model!,data.expressId,data.globalId));
      sampleWasmCapacity(trace,api);trace.produced({ parts: result.parts.length });
      trace.reply({id:data.id,data:result},{transfer:result.parts.flatMap(p=>[p.vertices.buffer,p.indices.buffer])});
    } else if(data.type==='properties'){
      if(model===null)throw new Error('Object worker not open');
      const attributes=await api.properties.getItemProperties(model,data.expressId,false),propertySets=await api.properties.getPropertySets(model,data.expressId,true);
      const result=JSON.parse(JSON.stringify({attributes,propertySets},(_key,value)=>{
        if(value&&typeof value==='object'&&value.constructor?.name==='NumberHandle')return {type:value.type,value:value.value};return value;
      }));trace.produced();trace.reply({id:data.id,data:result});
    } else throw new Error('Unknown object fine request');
  } catch(error){trace.fail(error);self.postMessage({id:data.id,error:error instanceof Error?error.message:String(error)});}
});
