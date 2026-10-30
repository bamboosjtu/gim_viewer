import type { AppState } from '../app/state.js';
import type { BusinessShape, BusinessConnection } from '../gim/businessTree.js';

/** Reuse the displayed representation's absolute metre bounds. No parsing,
 * triangulation or scene traversal is needed to build business evidence. */
export function collectBusinessGeometry(state:AppState):{shapes:BusinessShape[];connections:BusinessConnection[];modelUnits:Map<string,number>} {
  const spatial=state.substationSpatialIndex,shapes:BusinessShape[]=[],connections:BusinessConnection[]=[],modelUnits=new Map<string,number>();
  if(!spatial)return {shapes,connections,modelUnits};
  const sources=new Map(spatial.objects.map(o=>[`${o.modelId}|${o.expressId}`,o]));
  const guids=new Map<string,string|null>();
  for(const o of spatial.objects)if(o.ifcType!=='IFCDISTRIBUTIONPORT'&&o.globalId){const key=`${o.modelId}|${o.globalId}`;guids.set(key,guids.has(key)?null:o.key);}
  for(const [modelId,runtime]of state.ifcRegionalRuntimes){
    modelUnits.set(modelId,runtime.index.unitScale);
    for(const item of runtime.index.objects){
      const source=sources.get(`${modelId}|${item.expressId}`),b=item.bounds;if(!source)continue;
      if(b.length===6&&b.every(Number.isFinite)&&b.slice(0,3).every((v,i)=>v<=b[i+3]&&b[i+3]-v<=500))
        shapes.push({objectKey:source.key,min:[b[0],-b[5],b[1]],max:[b[3],-b[2],b[4]],evidence:'geometry'});
      const endpoints=item.connectionEndpoints?.filter(e=>e.kind==='ifc-element').map(e=>guids.get(`${modelId}|${e.reference}`));
      if(endpoints?.length&&endpoints.every((key):key is string=>typeof key==='string'))connections.push({objectKey:source.key,endpointKeys:endpoints});
    }
  }
  const measured=new Set<string>();
  for(const shape of state.deviceLodRuntime?.getBusinessShapes?.()??[]){shapes.push(shape);measured.add(shape.objectKey);}
  const entries=state.deviceLodRuntime?.getBusinessOccurrences?.();
  if(entries)for(const entry of entries){
    const b=entry.sourceBounds,m=entry.placementMatrix;
    if(measured.has(entry.rootOccurrence)||!b||entry.boundsQuality==='unknown'||entry.templateStatus==='failed'||m.length!==16||!m.every(Number.isFinite))continue;
    const min:[number,number,number]=[Infinity,Infinity,Infinity],max:[number,number,number]=[-Infinity,-Infinity,-Infinity];
    for(let corner=0;corner<8;corner++)for(let axis=0;axis<3;axis++){
      const v=m[axis]*b[corner&1?3:0]+m[axis+4]*b[corner&2?4:1]+m[axis+8]*b[corner&4?5:2]+m[axis+12]/1000;
      min[axis]=Math.min(min[axis],v);max[axis]=Math.max(max[axis],v);
    }
    if([...min,...max].every(Number.isFinite)&&min.every((v,i)=>max[i]-v<=500))shapes.push({objectKey:entry.rootOccurrence,min,max,evidence:'geometry'});
  }
  return {shapes,connections,modelUnits};
}
