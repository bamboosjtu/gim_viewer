import type { AppState } from '../app/state.js';
import type { CompositionBounds } from '../engineering/compositionSpatial.js';
import type { EngineeringComposition } from '../engineering/composition.js';
import type { ProjectionInput } from './compositionProjectionWorker.js';
import { categoryLabel } from '../engineering/catalogLabels.js';

/** Runtime bounds refine only the business projection. The source/entity cache
 * remains independent of rendering. Geometry enrichment is not persisted as a
 * semantic cache hit and runs again when geometry is available on warm open. */
export function installCompositionProjection(state:AppState):()=>void {
  const session=state.captureProjectSession();let timer:ReturnType<typeof setTimeout>|undefined,worker:Worker|undefined,disposed=false;
  const current=()=>!disposed&&state.isCurrentSession(session);
  const update=()=>{if(!current())return;clearTimeout(timer);timer=setTimeout(run,500);};
  function run(){
    if(!current())return;
    const snapshot=state.engineeringSnapshot,view=state.engineeringNavigation,input=view?.compositionInput;
    if(!snapshot||!view||!input||!state.ifcRegionalRuntimes.size)return;
    const owners=new Map(snapshot.memberships.map(m=>[m.sourceId,m.ownerId])),bounds:CompositionBounds[]=[];
    for(const [model,runtime]of state.ifcRegionalRuntimes)for(const object of runtime.index.objects){
      const sourceId=`ifc:${JSON.stringify([model,object.expressId])}`,owner=owners.get(sourceId),b=object.bounds;
      if(owner)bounds.push({entityId:owner,bounds:[b[0],-b[5],b[1],b[3],-b[2],b[4]],evidence:sourceId});
    }
    if(!bounds.length)return;
    worker?.terminate();const owned=worker=new Worker(new URL('./compositionProjectionWorker.ts',import.meta.url),{type:'module'});
    owned.onmessage=(event:MessageEvent<{composition:EngineeringComposition;contexts:Array<[string,string]>;error?:string}>)=>{
      if(!current()||worker!==owned||snapshot!==state.engineeringSnapshot||view!==state.engineeringNavigation){owned.terminate();return;}
      owned.terminate();worker=undefined;
      if(event.data.error){console.warn('[工程组成投影]',event.data.error);return;}
      const contexts=new Map(event.data.contexts),entities=new Map(snapshot.entities.map(e=>[e.id,e]));
      state.engineeringNavigation={...view,composition:event.data.composition,compositionSearch:view.compositionSearch.map(row=>{
        const entity=entities.get(row.key);if(!entity)return row;
        const subtitle=`${categoryLabel(entity.category)} · ${contexts.get(row.key)??'工程归属待确认'}`;
        return {...row,subtitle,searchText:`${row.searchText}\n${subtitle.toLowerCase()}`};
      })};
      state.notifyEngineeringChanged();
      const request=state.selectionRequest;
      if(request?.target?.kind==='engineering-group'&&view.composition.nodes.has(request.target.key)){
        void import('./engineeringSelection.js').then(({selectEngineeringTarget})=>{if(current()&&state.isCurrentSelection(request))return selectEngineeringTarget(state,{kind:'engineering-group',key:request.target!.key},request,{fit:false,load:false});});
      }
    };
    owned.onerror=event=>{if(current())console.warn('[工程组成投影]',event.message);owned.terminate();if(worker===owned)worker=undefined;};
    const message:ProjectionInput={snapshot:{...snapshot,entities:snapshot.entities.map(e=>({...e,sourceIds:[]})),memberships:[],relationships:[]},facts:input.facts,declarations:input.declarations,bounds};
    owned.postMessage(message);
  }
  state.engineeringGeometryEvidenceChanged=update;
  return ()=>{disposed=true;clearTimeout(timer);worker?.terminate();if(state.engineeringGeometryEvidenceChanged===update)state.engineeringGeometryEvidenceChanged=null;};
}
