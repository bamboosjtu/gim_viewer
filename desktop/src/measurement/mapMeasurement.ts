import {measurementRun,measurementContext} from './runtime.js';
export function observeMap(map:{on:(type:string,listener:()=>void)=>unknown;off:(type:string,listener:()=>void)=>unknown}){
  let previous:number|null=null,serial=0;
  const render=()=>{const run=measurementRun();if(run.collector.mode!=='diagnostic')return;
    const now=performance.now();run.probe.trace(measurementContext(),{type:'render',action:'observed',name:'map.frame-interval',
      frameId:'map-frame-'+ ++serial,value:previous===null?undefined:now-previous,unit:'ms'});previous=now;};
  const remove=()=>{map.off('render',render);map.off('remove',remove);};
  map.on('render',render);map.on('remove',remove);
}
