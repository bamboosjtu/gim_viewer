import {afterEach,expect,it,vi} from 'vitest';
import type {SimpleRenderer} from '@thatopen/components';
import {observeRenderer} from '../../viewer/renderMeasurement.js';
import {resetMeasurementRun,measurementSnapshot} from '../runtime.js';

function event(){const handlers=new Set<()=>void>();return {add:(f:()=>void)=>handlers.add(f),remove:(f:()=>void)=>handlers.delete(f),trigger:()=>{for(const f of handlers)f();}};}
function renderer(autoReset:boolean){
  const info={autoReset,render:{calls:10,triangles:20},reset:vi.fn()};
  const object={three:{info,getContext:()=>({}),render:vi.fn(()=>{if(info.autoReset){info.render.calls=0;info.render.triangles=0;}info.render.calls+=2;info.render.triangles+=3;})},
    onBeforeUpdate:event(),onAfterUpdate:event(),onDisposed:event(),update(){this.onBeforeUpdate.trigger();this.three.render();this.onAfterUpdate.trigger();}};
  return object;
}
afterEach(()=>{delete (globalThis as {__GIM_MEASUREMENT_CONFIG__?:unknown}).__GIM_MEASUREMENT_CONFIG__;resetMeasurementRun({});vi.restoreAllMocks();});
it.each([true,false])('preserves autoReset=%s and original render errors while closing failed phases',autoReset=>{
  (globalThis as {__GIM_MEASUREMENT_CONFIG__?:unknown}).__GIM_MEASUREMENT_CONFIG__={mode:'diagnostic'};resetMeasurementRun({});
  const target=renderer(autoReset),update=target.update,observed=observeRenderer(target as unknown as SimpleRenderer);
  target.three.render.mockImplementationOnce(()=>{throw Error('render-error');});
  expect(()=>target.update()).toThrow('render-error');expect(target.three.info.autoReset).toBe(autoReset);
  expect(measurementSnapshot()?.phases['host:render.submission']).toMatchObject({count:1,failed:1});
  target.update();expect(target.three.info.autoReset).toBe(autoReset);expect(target.three.info.reset).not.toHaveBeenCalled();
  expect(measurementSnapshot()?.phases['host:render.submission']).toMatchObject({count:2,workload:{calls:autoReset?12:2,triangles:autoReset?23:3}});
  observed.dispose();expect(target.update).toBe(update);
});
