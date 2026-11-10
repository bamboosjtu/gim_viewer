import type * as OBC from '@thatopen/components';
import {measurementRun,measurementContext,observeMeasurementOperationEnd} from '../measurement/runtime.js';
import {GpuTimer} from './gpuTimer.js';
/** Public renderer lifecycle, one frame/pass today; supports explicit multi-pass totals. */
export function observeRenderer(renderer:OBC.SimpleRenderer){
  let frame=0,autoReset=true,run=measurementRun(),context=measurementContext();
  let gpu:GpuTimer|undefined;
  let submission:ReturnType<ReturnType<typeof measurementRun>['probe']['phase']>|undefined;
  const passes=new Map<string,{run:ReturnType<typeof measurementRun>;context:ReturnType<typeof measurementContext>}>();
  const unsubscribe=observeMeasurementOperationEnd(()=>{gpu?.dispose();gpu=undefined;passes.clear();});
  const before=()=>{
    run=measurementRun();if(run.collector.mode!=='diagnostic')return;
    context=measurementContext(run.collector);frame++;
    submission=run.probe.phase(context,'render.submission');
    autoReset=renderer.three.info.autoReset;renderer.three.info.autoReset=false;renderer.three.info.reset();
    const enabled=(globalThis as {__GIM_GPU_DIAGNOSTICS__?:boolean}).__GIM_GPU_DIAGNOSTICS__===true;
    if(enabled&&!gpu){const gl=renderer.three.getContext();
      if('beginQuery' in gl)gpu=new GpuTimer(gl as WebGL2RenderingContext,sample=>{
        const owner=passes.get(sample.passId);passes.delete(sample.passId);if(!owner)return;
        owner.run.probe.trace(owner.context,{type:'render',action:sample.availability,id:sample.passId,passId:sample.passId,
          name:'gpu.elapsed',value:sample.durationMs??undefined,unit:'ms',reason:sample.reason});
      });
    }
    if(gpu&&passes.size<8){passes.set('pass-'+frame,{run,context});gpu.begin('pass-'+frame);}
    run.probe.trace(context,{type:'render',action:'started',frameId:'frame-'+frame,passId:'pass-'+frame});
  };
  const after=()=>{
    if(run.collector.mode!=='diagnostic')return;
    gpu?.end();gpu?.poll();renderer.three.info.autoReset=autoReset;
    const info=renderer.three.info.render;
    submission?.end('completed',{calls:info.calls,triangles:info.triangles});
    run.probe.trace(context,{type:'render',action:'ended',frameId:'frame-'+frame,passId:'pass-'+frame,
      name:'draw-calls',value:info.calls,unit:'calls'});
  };
  const dispose=()=>{renderer.onBeforeUpdate.remove(before);renderer.onAfterUpdate.remove(after);
    renderer.onDisposed.remove(dispose);unsubscribe();gpu?.dispose();};
  renderer.onBeforeUpdate.add(before);renderer.onAfterUpdate.add(after);renderer.onDisposed.add(dispose);
  return {dispose};
}
