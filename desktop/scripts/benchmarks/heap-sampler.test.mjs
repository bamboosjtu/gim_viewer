import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkerHeapSampler} from './cdp.mjs';
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function fixture(t){
  t.mock.timers.enable({apis:['setTimeout']});
  let now=0,listener,resolve,reject;const rows=[],calls=[];
  const cdp={onEvent(f){listener=f;return()=>{};},async send(method,params,session){calls.push([method,session]);
    if(method==='Runtime.getIsolateId')return{id:session??'main'};
    if(method==='Runtime.getHeapUsage')return session?new Promise((a,b)=>{resolve=a;reject=b;}):{usedSize:1,totalSize:2};
    return{};
  }};
  const sampler=new WorkerHeapSampler(cdp,row=>rows.push(row),1000,()=>now);
  const attach=()=>{sampler.associate('blob:owned',{workerId:'worker',runId:'run',family:'dev'});
    listener({method:'Target.attachedToTarget',params:{sessionId:'w',targetInfo:{type:'worker',targetId:'target',url:'blob:owned'}}});};
  t.after(()=>sampler.stop());
  return {sampler,rows,calls,attach,setNow:n=>{now=n;},tick:n=>t.mock.timers.tick(n),
    finish:()=>resolve({usedSize:10,totalSize:20}),fail:()=>reject(Error('CDP timeout')),
    detach:()=>listener({method:'Target.detachedFromTarget',params:{sessionId:'w'}})};
}
test('new targets have their own sampling phase and overlapping checkpoints coalesce',async t=>{
  const f=fixture(t);await f.sampler.start();await flush();f.setNow(995);f.attach();await flush();
  const a=f.sampler.checkpoint('worker','a'),b=f.sampler.checkpoint('worker','b');
  f.setNow(1000);f.tick(1000);await flush();
  assert.equal(f.calls.filter(([method,session])=>session==='w'&&method==='Runtime.getHeapUsage').length,1);
  f.setNow(1013);f.finish();await Promise.all([a,b]);await flush();
  assert.equal(f.rows.filter(row=>row.workerId==='worker'&&row.kind==='heap-sample'&&row.availability==='unavailable').length,0);
  assert.equal(f.rows.find(row=>row.workerId==='worker'&&row.kind==='heap-sample').sampleDelayMs,18);
  assert.equal(f.sampler.snapshot().coalesced,2);
});
test('normal detach cancels a pending sample without fabricating a failed sample',async t=>{
  const f=fixture(t);await f.sampler.start();f.attach();await flush();f.detach();f.fail();await flush();
  assert.equal(f.rows.some(row=>row.workerId==='worker'&&row.kind==='heap-sample'&&row.availability==='unavailable'),false);
  assert.equal(f.rows.some(row=>row.kind==='worker-target-ended'),true);
  assert.equal(f.rows.some(row=>row.kind==='heap-sample-cancelled'&&row.reason==='target-ended'),true);
});
test('live target timeouts remain failures and recording stop does not add failures',async t=>{
  const f=fixture(t);await f.sampler.start();f.attach();await flush();f.setNow(2001);f.fail();await flush();
  assert.equal(f.rows.find(row=>row.workerId==='worker'&&row.kind==='heap-sample').availability,'unavailable');
  const request=f.sampler.checkpoint('worker','end');await flush();f.sampler.stop();f.fail();await request;
  assert.equal(f.rows.filter(row=>row.workerId==='worker'&&row.kind==='heap-sample'&&row.availability==='unavailable').length,1);
});

test('late registry association samples a busy Worker without evaluating its JavaScript',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let listener,now=0;const rows=[],calls=[];
 const cdp={onEvent(fn){listener=fn;return()=>{};},evaluate(){throw Error('must not evaluate busy Worker');},
  async send(method,_params,session){calls.push([method,session]);if(method==='Runtime.getIsolateId')return{id:session??'main'};
   if(method==='Runtime.getHeapUsage')return{usedSize:12,totalSize:24};return{};}};
 const sampler=new WorkerHeapSampler(cdp,row=>rows.push(row),1000,()=>now);t.after(()=>sampler.stop());
 await sampler.start();listener({method:'Target.attachedToTarget',params:{sessionId:'w',targetInfo:{type:'worker',targetId:'target',url:'blob:owned'}}});
 await flush();assert.equal(calls.some(([method,session])=>method==='Runtime.getHeapUsage'&&session==='w'),false);
 now=40;sampler.associate('blob:owned',{workerId:'owned',runId:'run',family:'ifc-conversion'});await flush();
 const sample=rows.find(row=>row.workerId==='owned'&&row.kind==='heap-sample');
 assert.equal(sample.availability,'available');assert.equal(sample.atMs,40);assert.equal(sample.targetCreatedAtMs,0);
 assert.equal(rows.some(row=>row.availability==='unavailable'),false);
});
