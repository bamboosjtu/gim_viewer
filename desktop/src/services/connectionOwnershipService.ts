import type { AppState, ProjectLoadSession } from '../app/state.js';
import { discoverSubstationGlSidecars } from '../gim/substationEvidence.js';
import { GlConnectionPortIndex } from '../gim/glConnectionPorts.js';
import { batchReadCachedFiles } from '@desktop/database.js';
import { isTauri } from '@desktop/runtime.js';
import { perfCurrentSession, perfMark } from '../utils/perfTimings.js';

/** Optional small sidecar metadata, independent of connection visibility.
 * No geometric source is parsed and no IFC/DEV compute gate is held. */
export async function prepareConnectionOwnership(state: AppState, session: ProjectLoadSession): Promise<void> {
  const current=()=>state.isCurrentSession(session),perf=perfCurrentSession();
  const sidecars=discoverSubstationGlSidecars(state.substationEntryPaths,state.currentCbmTree);
  if(!sidecars.length||!current())return;
  const paths:string[]=[];let budget=0;
  for(const sidecar of sidecars){
    const file=state.currentFiles?.get(sidecar.path),size=state.substationEntrySizes.get(sidecar.path)??file?.size??0;
    if(!Number.isSafeInteger(size)||size<=0||size>1024*1024||budget+size>4*1024*1024)continue;
    budget+=size;paths.push(sidecar.path);
  }
  if(!paths.length)return;
  const work=async():Promise<Map<string,string>>=>{
    const texts=new Map<string,string>();
    if(isTauri()&&session.projectId!=null){
      const values=await batchReadCachedFiles(session.projectId,paths);
      for(const path of paths){const bytes=values.get(path);if(bytes?.length&&bytes.length<=1024*1024)texts.set(path,new TextDecoder().decode(bytes));}
    }else for(const path of paths){
      if(!current())break;const file=state.currentFiles?.get(path);if(file)texts.set(path,await file.text());
    }
    return texts;
  };
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const texts=await Promise.race([work(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Connection sidecar metadata timed out')),5000);})]);
    if(!current())return;
    state.substationConnectionPorts=new GlConnectionPortIndex(state.currentCbmTree,state.substationEntryPaths,texts);
    perfMark('Connection sidecar evidence ready',{...state.substationConnectionPorts.diagnostics,admittedBytes:budget},perf);
  }catch(error){if(current())perfMark('Connection sidecar evidence unavailable',{reason:String(error)},perf);}
  finally{if(timer)clearTimeout(timer);}
}
