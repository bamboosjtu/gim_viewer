import type * as OBC from '@thatopen/components';
import {measurementRun,measurementContext,observeMeasurementOperationEnd} from '../measurement/runtime.js';
import {GpuTimer} from './gpuTimer.js';
/** Observe public frame boundaries without changing the renderer's reset policy. */
export function observeRenderer(renderer:OBC.SimpleRenderer){
  let frame=0,gpu:GpuTimer|undefined;
  type Frame={id:string;run:ReturnType<typeof measurementRun>;context:ReturnType<typeof measurementContext>;
    submission:ReturnType<ReturnType<typeof measurementRun>['probe']['phase']>;calls:number;triangles:number;autoReset:boolean};
  let active:Frame|undefined;
  const passes=new Map<string,Pick<Frame,'run'|'context'>>();
  const finish=(status:'completed'|'failed')=>{
    const owner=active;if(!owner)return;active=undefined;
    try{
      if(status==='completed')gpu?.end(owner.id);else gpu?.cancel(owner.id,'render-failed');
      gpu?.poll();
    }finally{
      const info=renderer.three.info.render;
      const calls=owner.autoReset?info.calls:Math.max(0,info.calls-owner.calls);
      const triangles=owner.autoReset?info.triangles:Math.max(0,info.triangles-owner.triangles);
      owner.submission.end(status,{calls,triangles});
      owner.run.probe.trace(owner.context,{type:'render',action:status==='completed'?'ended':'failed',frameId:owner.id,passId:owner.id,
        name:'draw-calls',value:calls,unit:'calls'});
    }
  };
  const safely=(work:()=>void)=>{try{work();}catch{/* Diagnostics must not alter product rendering. */}};
  const unsubscribe=observeMeasurementOperationEnd(()=>safely(()=>{finish('failed');gpu?.dispose();gpu=undefined;passes.clear();}));
  const before=()=>safely(()=>{
    finish('failed');
    const run=measurementRun();if(run.collector.mode!=='diagnostic')return;
    const context=measurementContext(run.collector),id='pass-'+ ++frame,info=renderer.three.info;
    active={id,run,context,submission:run.probe.phase(context,'render.submission'),calls:info.render.calls,
      triangles:info.render.triangles,autoReset:info.autoReset};
    const enabled=(globalThis as {__GIM_GPU_DIAGNOSTICS__?:boolean}).__GIM_GPU_DIAGNOSTICS__===true;
    if(enabled&&!gpu){const gl=renderer.three.getContext();
      if('beginQuery' in gl)gpu=new GpuTimer(gl as WebGL2RenderingContext,sample=>{
        const owner=passes.get(sample.passId);passes.delete(sample.passId);if(!owner)return;
        owner.run.probe.trace(owner.context,{type:'render',action:sample.availability,id:sample.passId,passId:sample.passId,
          name:'gpu.elapsed',value:sample.durationMs??undefined,unit:'ms',reason:sample.reason});
      });
    }
    if(gpu&&passes.size<8){passes.set(id,{run,context});gpu.begin(id);}
    run.probe.trace(context,{type:'render',action:'started',frameId:id,passId:id});
  });
  const after=()=>safely(()=>finish('completed'));
  // SimpleRenderer skips onAfterUpdate if render or another listener throws.
  const update=renderer.update;
  const wrapped:typeof update=function(this:OBC.SimpleRenderer,...args:Parameters<typeof update>){
    try{return update.apply(this,args);}finally{safely(()=>finish('failed'));}
  };
  renderer.update=wrapped;
  let disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;
    renderer.onBeforeUpdate.remove(before);renderer.onAfterUpdate.remove(after);renderer.onDisposed.remove(dispose);
    if(renderer.update===wrapped)renderer.update=update;
    unsubscribe();safely(()=>{finish('failed');gpu?.dispose();passes.clear();});
  };
  renderer.onBeforeUpdate.add(before);renderer.onAfterUpdate.add(after);renderer.onDisposed.add(dispose);
  return {dispose};
}
