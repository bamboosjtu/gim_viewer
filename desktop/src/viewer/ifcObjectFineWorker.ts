import { IfcAPI } from 'web-ifc';
import { extractIfcObjectFine } from './ifcObjectFineData.js';

const api=new IfcAPI();let model:number|null=null;
self.onmessage=async({data})=>{
  try {
    if(data.type==='open'){
      if(model!==null)throw new Error('Object worker already open');
      const init=performance.now();api.SetWasmPath(data.wasm.path,data.wasm.absolute);await api.Init(undefined,true);
      const opened=performance.now();model=api.OpenModel(data.bytes,{...data.webIfcSettings,COORDINATE_TO_ORIGIN:false});
      self.postMessage({id:data.id,data:{initMs:opened-init,openMs:performance.now()-opened,
        inputBytes:data.bytes.byteLength,wasmHeapBytes:(api as any).wasmModule.HEAPU8.byteLength}});
    } else if(data.type==='object'){
      if(model===null)throw new Error('Object worker not open');
      const result=extractIfcObjectFine(api,model,data.expressId,data.globalId);
      self.postMessage({id:data.id,data:result},{transfer:result.parts.flatMap(p=>[p.vertices.buffer,p.indices.buffer])});
    } else if(data.type==='properties'){
      if(model===null)throw new Error('Object worker not open');
      const attributes=await api.properties.getItemProperties(model,data.expressId,false),propertySets=await api.properties.getPropertySets(model,data.expressId,true);
      const result=JSON.parse(JSON.stringify({attributes,propertySets},(_key,value)=>{
        if(value&&typeof value==='object'&&value.constructor?.name==='NumberHandle')return {type:value.type,value:value.value};return value;
      }));self.postMessage({id:data.id,data:result});
    } else throw new Error('Unknown object fine request');
  } catch(error){self.postMessage({id:data.id,error:error instanceof Error?error.message:String(error)});}
};
