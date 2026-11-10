import{it,expect}from'vitest';
import{resetMeasurementRun,measurementRun,measurementContext,openMeasurementContext,beginMeasurementOperation,finishMeasurementOperation,updateMeasurementIdentity}from'../runtime.js';
it('keeps the root operation across overlapping actions and out-of-order completion',()=>{
  const global=globalThis as typeof globalThis&{__GIM_MEASUREMENT_CONFIG__?:{mode:string}};
  const previous=global.__GIM_MEASUREMENT_CONFIG__;global.__GIM_MEASUREMENT_CONFIG__={mode:'diagnostic'};
  try{
    resetMeasurementRun({runId:'overlap-run'});const run=measurementRun(),root=openMeasurementContext()!;
    const a=beginMeasurementOperation('dev-fine'),b=beginMeasurementOperation('ifc-fine');
    expect(a.context.operationTraceId).toBe(root.operationTraceId);expect(b.context.operationTraceId).toBe(root.operationTraceId);
    expect(a.context.scopeId).not.toBe(root.scopeId);expect(a.context.scopeId).not.toBe(b.context.scopeId);
    expect(measurementContext().operationTraceId).toBe(root.operationTraceId);
    a.end();expect(measurementContext().scopeId).toBe(root.scopeId);b.end();b.end();
    expect(measurementContext().operationTraceId).toBe(root.operationTraceId);finishMeasurementOperation();
    expect(measurementContext().operationTraceId).toBeUndefined();
    const events=run.collector.drain();expect(events.filter(e=>e.trace?.type==='operation'&&e.trace.action==='started')).toHaveLength(1);
    expect(events.filter(e=>e.trace?.type==='operation'&&e.trace.action==='ended')).toHaveLength(1);
    expect(events.filter(e=>e.trace?.type==='scope'&&e.trace.action==='declared'&&e.trace.scope?.parentScopeId===root.scopeId)).toHaveLength(4);
  }finally{finishMeasurementOperation();global.__GIM_MEASUREMENT_CONFIG__=previous;resetMeasurementRun({});}
});
it('rejects run identity rewrites without changing the archived run',()=>{
  resetMeasurementRun({runId:'identity-run'});const run=measurementRun();
  expect(()=>updateMeasurementIdentity({runId:'other-run'})).toThrow('measurement-run-identity-changed');
  expect(run.collector.identity.runId).toBe('identity-run');updateMeasurementIdentity({runId:'identity-run',generation:2});expect(run.collector.identity.generation).toBe(2);
});
