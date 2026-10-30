import { buildBusinessTree } from '../gim/businessTree.js';
import type { BusinessBuildInput } from './businessTreeService.js';
self.onmessage=(event:MessageEvent<BusinessBuildInput>)=>{
  const input=event.data;
  const result=buildBusinessTree(input.root,input.families,{objects:input.objects,objectByKey:new Map(input.objects.map(o=>[o.key,o])),nodeByKey:new Map(input.nodes.map(n=>[n.key,n])),linksByIfcObjectKey:input.links,...input.geometry});
  result.cbmByPath=new Map();self.postMessage(result);
};
