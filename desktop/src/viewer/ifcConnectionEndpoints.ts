import type { IfcAPI } from 'web-ifc';
import { normalizeConnectionPointGuid, type ConnectionEndpointEvidence } from '../gim/connectionEndpoints.js';
import { CONNECTION_IFC_TYPES, isRegionalConnectionObject } from './ifcRegionalData.js';

/** Supported standard IFC connectivity plus explicit connection-point GUID
 * property sets. Names describe fields/capabilities, never vendors or files. */
export function readConnectionEndpointEvidence(api: IfcAPI, model: number): Map<number, ConnectionEndpointEvidence[]> {
  const result = new Map<number, ConnectionEndpointEvidence[]>();
  const lines = (type: string, visit: (id: number, row: any) => void): void => {
    const code = api.GetTypeCodeFromName(type); if (!code) return;
    const ids = api.GetLineIDsWithType(model, code);
    try { for (let i=0;i<ids.size();i++) { const id=ids.get(i); visit(id,api.GetLine(model,id,false)); } }
    finally { (ids as any).delete?.(); }
  };
  const ref = (value: any): number => Number(value?.value ?? value);
  const text = (value: any): string => String(value?.value ?? '');
  for (const type of [...CONNECTION_IFC_TYPES,'IFCBUILDINGELEMENTPROXY']) lines(type,(id,row)=>{
    if (isRegionalConnectionObject({expressId:id,globalId:text(row.GlobalId),ifcType:type,name:text(row.Name),bounds:[]})) result.set(id,[]);
  });
  if (!result.size) return result;
  const append = (id: number, evidence: ConnectionEndpointEvidence): void => {
    const rows=result.get(id); if (!rows) return;
    if (rows.length === 128) throw Error(`IFC endpoint evidence exceeds per-object budget: ${id}`);
    rows.push(evidence);
  };
  const guid = (id: number): string => text(api.GetLine(model,id,false)?.GlobalId);
  lines('IFCRELDEFINESBYPROPERTIES',(id,row)=>{
    const targets=(row.RelatedObjects ?? []).map(ref).filter((value:number)=>result.has(value));
    if (!targets.length) return;
    const set=api.GetLine(model,ref(row.RelatingPropertyDefinition),false),setName=text(set.Name);
    if (!/(?:关联模型接线点GUID|connection\s*point.*guid|terminal.*guid|endpoint.*guid)/i.test(setName)) return;
    for(const property of set.HasProperties ?? []){
      const item=api.GetLine(model,ref(property),false),name=text(item.Name);
      if(!/^(?:接线点\d*|connection\s*point\s*\d*|terminal\s*\d*|endpoint\s*\d*)$/i.test(name))continue;
      const value=normalizeConnectionPointGuid(item.NominalValue?.value);
      if (!value) continue; // A prose Description alone is not a reference.
      for (const target of targets) append(target,{kind:'gim-connect-guid',reference:value,relationId:id,
        propertyId:ref(property),propertySet:setName,propertyName:name});
    }
  });
  const portOwners=new Map<number,Set<number>>();
  lines('IFCRELCONNECTSPORTTOELEMENT',(_id,row)=>{
    const port=ref(row.RelatingPort),element=ref(row.RelatedElement);
    if(!port||!element)return;const owners=portOwners.get(port)??new Set<number>();owners.add(element);portOwners.set(port,owners);
  });
  const connect=(id:number,a:number,b:number,ports?:number[]):void=>{
    if(!a||!b||a===b)return;
    if(result.has(a)){const target=guid(b);if(target)append(a,{kind:'ifc-element',reference:target,relationId:id,...(ports?{viaPortIds:ports}:{})});}
    if(result.has(b)){const target=guid(a);if(target)append(b,{kind:'ifc-element',reference:target,relationId:id,...(ports?{viaPortIds:[...ports].reverse()}:{})});}
  };
  lines('IFCRELCONNECTSPORTS',(id,row)=>{
    const a=ref(row.RelatingPort),b=ref(row.RelatedPort);
    for(const ownerA of portOwners.get(a)??[])for(const ownerB of portOwners.get(b)??[])connect(id,ownerA,ownerB,[a,b]);
  });
  lines('IFCRELCONNECTSELEMENTS',(id,row)=>connect(id,ref(row.RelatingElement),ref(row.RelatedElement)));
  return result;
}
