import type {AppState} from '../app/state.js';
import {measurementRun,measurementContext,measurementSnapshot} from './runtime.js';

export function scenarioTargets(state:AppState){
  const bases=[...(state.deviceLodRuntime?.baseRepresentationEvidence?.()??[])].sort((a,b)=>a.id.localeCompare(b.id));
  const dev=bases.slice(0,8).map(row=>({id:row.id})),devBoolean=bases.filter(row=>(row.simplifiedBooleans??0)>0).slice(0,8).map(row=>({id:row.id}));
  const ifc:Array<{source:string;expressId:number;globalId:string;kind:string}>=[];
  for(const runtime of [...state.ifcRegionalRuntimes.values()].sort((a,b)=>(state.substationEntrySizes.get(a.sourcePath)??Infinity)-(state.substationEntrySizes.get(b.sourcePath)??Infinity)||a.sourcePath.localeCompare(b.sourcePath))){
    let best:typeof runtime.index.objects[number]|undefined;
    for(const object of runtime.index.objects){
      if(object.role==='connection'||best&&object.expressId>=best.expressId||object.bounds.length!==6||!object.bounds.every(Number.isFinite))continue;
      const b=runtime.worldBounds(object);if(!b)continue;
      const extent=Math.max(b.max.x-b.min.x,b.max.y-b.min.y,b.max.z-b.min.z);
      if(extent>0&&extent<=5)best=object;
    }
    if(best)ifc.push({source:runtime.sourcePath,expressId:best.expressId,globalId:best.globalId,kind:best.ifcType});if(ifc.length===8)break;
  }
  return {dev,devBoolean,ifc};
}
export async function runScenarioAction(state:AppState,action:{kind:'dev-fine'|'ifc-fine'|'ifc-near';id?:string;source?:string;expressId?:number;globalId?:string}){
  const run=measurementRun(),context=measurementContext(run.collector),session=state.captureProjectSession();
  return run.probe.measure(context,`host.action.${action.kind}`,async()=>{
    if(action.kind==='dev-fine'){
      if(!action.id||!state.deviceLodRuntime?.refine)throw Error('dev-action-target-unavailable');
      const groups=await state.deviceLodRuntime.refine(action.id);
      if(!groups.length)throw Error('dev-fine-result-empty');
      const count=groups.length;state.deviceLodRuntime.releaseFine?.(action.id);state.deviceLodRuntime.clearSelection();
      return {kind:action.kind,objects:count,sessionValid:state.isCurrentSession(session)};
    }
    const runtime=[...state.ifcRegionalRuntimes.values()].find(row=>row.sourcePath===action.source);
    const object=runtime?.index.objects.find(row=>row.expressId===action.expressId&&row.globalId===action.globalId);
    if(!runtime||!object)throw Error('ifc-action-target-unavailable');
    if(action.kind==='ifc-fine'){
      const group=await runtime.refine(object);if(!group)throw Error('ifc-fine-result-empty');runtime.releaseFine(object.expressId);
      return {kind:action.kind,objects:1,sessionValid:state.isCurrentSession(session)};
    }
    const {peekViewerRuntime}=await import('../viewer/viewerRuntime.js');const viewer=await peekViewerRuntime();
    const bounds=runtime.worldBounds(object);if(!viewer||!bounds)throw Error('ifc-near-bounds-unavailable');
    const controls=viewer.ctx.world.camera.controls;if(!controls)throw Error('camera-controls-unavailable');
    const position=controls.getPosition(bounds.min.clone()),target=controls.getTarget(bounds.min.clone());
    try{
      await controls.fitToBox(bounds,false);
      const deadline=performance.now()+120000;
      while(performance.now()<deadline&&state.isCurrentSession(session)){
        if(runtime.hoverGroup(object.expressId))return {kind:action.kind,objects:1,sessionValid:true};
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw Error('ifc-near-action-timeout');
    }finally{if(state.isCurrentSession(session))await controls.setLookAt(position.x,position.y,position.z,target.x,target.y,target.z,false);}
  });
}
export async function projectResourceState(state:AppState){
  const measurement=measurementSnapshot();
  const {peekViewerRuntime}=await import('../viewer/viewerRuntime.js');const viewer=await peekViewerRuntime();
  return {sourceFiles:state.currentFiles?.size??0,cbmNodes:state.cbmNodeIndex.size,lineNodes:state.currentGimGraph?.nodesByPath.size??0,
    fragmentModels:viewer?.ctx.fragments.list.size??0,
    ifcModels:state.loadedModels.size,ifcRuntimes:state.ifcRegionalRuntimes.size,devRuntime:Number(!!state.deviceLodRuntime),
    modGroups:state.loadedXmlModGroups.size,stlGroups:state.loadedStlGroups.size,engineeringSources:state.engineeringSnapshot?.memberships.length??0,
    pendingTasks:measurement?.activeTasks.length??0,trackedHostBuffers:measurement?.hostResources?.uniqueAllocations??0,
    activeWorkers:Object.values(measurement?.workers??{}).filter(worker=>worker.state!=='terminated'&&worker.state!=='failed').length};
}
