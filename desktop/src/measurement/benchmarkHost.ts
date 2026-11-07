import measuredWorkerAsset from './capabilityWorker.ts?worker&url';
import type { AppState } from '../app/state.js';
import { measurementSnapshot, drainMeasurementEvents } from './runtime.js';
import { perfProductMomentSnapshot, perfCurrentSession } from '../utils/perfTimings.js';
import { createMeasuredWorker, measurementWorkerUrl } from './hostWorker.js';
import { resetMeasurementRun } from './runtime.js';
import {installMeasurementStream} from './stream.js';
import {benchmarkEvidence,benchmarkProgress} from './modelEvidence.js';
import {scenarioTargets,runScenarioAction,projectResourceState} from './scenarios.js';

/** Only loaded by an explicit benchmark build; normal release does not expose this API. */
export function installBenchmarkHost(state:AppState):void {
  let opening=false,openError=false,openStarted:number|null=null,openSequence=0;
  let capabilityWorker:Worker|undefined;
  let capabilityResult:unknown=null;
  let stream:ReturnType<typeof installMeasurementStream>|undefined;
  const host={
    stream(){if(stream)return;const binding=(globalThis as {__gimMeasurementEmit?:(value:string)=>void}).__gimMeasurementEmit;if(!binding)throw Error('measurement-binding-unavailable');stream=installMeasurementStream(binding);},
    ack(runId:string,batchId:number){stream?.acknowledge(runId,batchId);},
    transport(){return stream?.status()??[];},
    capabilityProbe(){
      capabilityWorker?.terminate();
      capabilityResult=null;
      (globalThis as {__GIM_MEASUREMENT_CONFIG__?:unknown}).__GIM_MEASUREMENT_CONFIG__={mode:'benchmark',runId:'capability-probe'};
      resetMeasurementRun({});
      capabilityWorker=createMeasuredWorker('measurement-probe',identity => new Worker(measurementWorkerUrl(measuredWorkerAsset,identity), {type:'module',...(identity?{name:identity}:{})}));
      capabilityWorker.onmessage=({data})=>{if(data.kind==='probe-read'){
        const bytes=new Uint8Array([7,11]).buffer;capabilityWorker!.postMessage({kind:'read-result',id:data.id,bytes},[bytes]);
      }else if(data.ready)capabilityResult=data;};
      capabilityWorker.postMessage({type:'allocate'});
    },
    endCapabilityProbe(){capabilityWorker?.terminate();capabilityWorker=undefined;},
    async open(sampleId:string,nonce:string,config:{runId:string;sourceSha256:string;buildId:string;mode:'off'|'summary'|'benchmark'|'diagnostic'}){
      const sequence=++openSequence;
      opening=true;openError=false;
      try{
        const {invoke}=await import('@tauri-apps/api/core');
        const path=await invoke<string>('benchmark_authorize_sample',{sampleId,nonce});
        if(sequence!==openSequence)return;
        (globalThis as {__GIM_MEASUREMENT_CONFIG__?:unknown}).__GIM_MEASUREMENT_CONFIG__={...config,sampleId};
        const {openGimForBenchmark}=await import('../services/openGimService.js');
        if(sequence!==openSequence)return;
        openStarted=performance.now();
        await openGimForBenchmark(state,path);
      }catch(error){if(sequence===openSequence)openError=true;throw error;}finally{if(sequence===openSequence)opening=false;}
    },
    snapshot(){return {opening,openError,projectType:state.currentProjectType,session:perfCurrentSession(),measurement:measurementSnapshot(),
      capabilityResult,
      openElapsedMs:openStarted===null?null:performance.now()-openStarted,visibility:document.visibilityState,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
      progress:benchmarkProgress(state),
      moments:Object.fromEntries(Object.entries(perfProductMomentSnapshot()).map(([key,value])=>[key,value?.atMs??null])),
      cachePersistence:((moment)=>({observed:moment!==null,available:moment?.meta?.available!==false}))
        (perfProductMomentSnapshot().cachePersistenceReady),
      engineering:{status:state.engineeringStatus,cacheStatus:state.engineeringCacheStatus,complete:state.engineeringSources?.complete??false}};},
    evidence(){return benchmarkEvidence(state);},
    targets(){return scenarioTargets(state);},
    action(action:Parameters<typeof runScenarioAction>[1]){return runScenarioAction(state,action);},
    resources(){return projectResourceState(state);},
    drain:drainMeasurementEvents,
    async close(){openSequence++;opening=false;const {cleanupBeforeOpenNewProject}=await import('../services/projectCleanupService.js');await cleanupBeforeOpenNewProject(state);},
    async memory(){const {getProcessMemory}=await import('@desktop/database.js');return getProcessMemory();},
  };
  (globalThis as {__gimBenchmark?:unknown}).__gimBenchmark=host;
}
