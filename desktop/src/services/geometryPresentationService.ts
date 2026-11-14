import type * as THREE from 'three';
import type {AppState,ProjectLoadSession} from '../app/state.js';
import type {ViewerContext} from '../viewer/viewerEngine.js';
import {perfCurrentSession,perfMarkProductMoment,type PerfSession} from '../utils/perfTimings.js';
type Observation=ReturnType<typeof import('../viewer/modelPresentation.js')['observeModelPresentation']>;
const jobs=new WeakMap<AppState,{session:ProjectLoadSession;promise:Promise<Observation>;callbacks:Set<()=>void>;presented:boolean}>();
/** Source/semantic readiness remains independent from a submitted model frame. */
export async function observeFirstGeometry(state:AppState,ctx:ViewerContext,root:THREE.Object3D,session:ProjectLoadSession,
  onPresented?:()=>void,perf:PerfSession=perfCurrentSession()):Promise<void>{
  const current=()=>state.isCurrentSession(session);if(!current())return;
  let job=jobs.get(state);
  if(!job||job.session.generation!==session.generation||job.session.sourceSha256!==session.sourceSha256){
    if(job)void job.promise.then(observer=>observer.dispose(),()=>{});
    const owned={session,promise:null as unknown as Promise<Observation>,callbacks:new Set<()=>void>(),presented:false};jobs.set(state,owned);job=owned;
    owned.promise=import('../viewer/modelPresentation.js').then(({observeModelPresentation})=>observeModelPresentation(ctx,current,()=>{
      if(!current())return;owned.presented=true;
      perfMarkProductMoment('firstVisibleGeometryReady',{scope:'in-viewport-model-draw-submitted',gpuCompletionWaited:false},perf);
      perfMarkProductMoment('firstGeometryReady',{scope:'in-viewport-model-draw-submitted',gpuCompletionWaited:false},perf);
      perfMarkProductMoment('interactive',{scope:'in-viewport-model-draw-submitted',inputLatencyVerified:false},perf);
      for(const callback of owned.callbacks)callback();owned.callbacks.clear();
    }));
  }
  if(job.presented){onPresented?.();return;}
  if(onPresented)job.callbacks.add(onPresented);
  const observer=await job.promise;if(current())observer.watch(root);else observer.dispose();
}
