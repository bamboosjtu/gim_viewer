import {afterEach,expect,it} from 'vitest';
import {OutputResources} from '../outputResources.js';
import {measurementRun,measurementSnapshot,resetMeasurementRun,trackHostBuffers} from '../runtime.js';
afterEach(()=>{delete (globalThis as any).__GIM_MEASUREMENT_CONFIG__;resetMeasurementRun({});});
it('shared output/cache ownership is counted once, copy is distinct and late release stays in its run',()=>{
  (globalThis as any).__GIM_MEASUREMENT_CONFIG__={mode:'benchmark'};resetMeasurementRun({generation:1});
  const run=measurementRun(),outputs=new OutputResources(),bytes=new Uint8Array(128);
  outputs.hold('result',bytes,{taskId:'task',sourcePath:'private-source'},'output');
  const releaseCache=trackHostBuffers('cache-prepared',[bytes.subarray(0,64),bytes.subarray(64)],run);
  const releaseCopy=trackHostBuffers('ipc-wire-copy',[bytes.slice()],run);
  expect(run.buffers.bytes).toBe(256);outputs.release('result');expect(run.buffers.bytes).toBe(256);releaseCopy();expect(run.buffers.bytes).toBe(128);
  resetMeasurementRun({generation:2});releaseCache();releaseCache();outputs.clear();
  expect(run.buffers.bytes).toBe(0);expect(measurementSnapshot()?.hostResources?.uniqueAllocations).toBe(0);
  expect(measurementSnapshot(run.collector.identity.runId)?.hostResources?.peakUniqueBytesByKind['buffer-capacity']).toBe(256);
});
it('a large transfer preserves exact buffer ownership without flooding detail events',()=>{
  (globalThis as any).__GIM_MEASUREMENT_CONFIG__={mode:'benchmark'};resetMeasurementRun({generation:1});
  const run=measurementRun(),buffers=Array.from({length:12000},()=>new ArrayBuffer(4));
  const release=trackHostBuffers('in-flight',buffers,run);
  expect(run.buffers.bytes).toBe(48000);
  expect(measurementSnapshot()?.counters['host:resource.acquire']).toMatchObject({buffers:12000,referencedBytes:48000});
  release('worker');
  expect(run.buffers.bytes).toBe(0);
  const snapshot=measurementSnapshot()!;
  expect(snapshot.counters['host:resource.transfer']).toMatchObject({buffers:12000,referencedBytes:48000});
  expect(snapshot.loss.detailEvents).toBe(0);
  expect(snapshot.detailComplete).toBe(true);
});
