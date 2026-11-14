/** A target that ended before two sampling periods has an explicit gap, not a zero-byte heap. */
export function recordWorkerHeapSample(previous,row){
  const previousAt=previous?.lastSuccessfulSampleAtMs??previous?.targetCreatedAtMs??row.targetCreatedAtMs;
  return {workerId:row.workerId,family:row.family??previous?.family??null,
    availability:row.availability,reason:row.availability==='available'?null:row.reason??'unknown',
    lastFailureReason:row.availability==='available'?previous?.lastFailureReason??null:row.reason??'unknown',
    lastFailureMethod:row.availability==='available'?previous?.lastFailureMethod??null:row.failureMethod??null,
    samples:(previous?.samples??0)+1,successfulSamples:(previous?.successfulSamples??0)+(row.availability==='available'?1:0),
    failedSamples:(previous?.failedSamples??0)+(row.availability==='available'?0:1),
    targetCreatedAtMs:previous?.targetCreatedAtMs??row.targetCreatedAtMs,
    lastSuccessfulSampleAtMs:row.availability==='available'?row.atMs:previous?.lastSuccessfulSampleAtMs,
    maxSampleGapMs:Math.max(previous?.maxSampleGapMs??0,Number.isFinite(previousAt)&&Number.isFinite(row.atMs)?Math.max(0,row.atMs-previousAt):0),
    maxSampleDelayMs:Math.max(previous?.maxSampleDelayMs??0,row.sampleDelayMs??0),lastSampleAtMs:row.atMs};
}
export function classifyWorkerHeapCoverage(workers,observedIds,periodMs=1000){
  const required=[],shortLived=[],notApplicable=[];
  for(const [workerId,worker] of Object.entries(workers??{})){
    if(observedIds.has(workerId))continue;
    if(worker.family==='host'||worker.family==='external'){
      notApplicable.push({workerId,reason:'no-standalone-js-isolate'});continue;
    }
    if(worker.state==='terminated'&&worker.tasks===0){
      notApplicable.push({workerId,reason:'never-executed'});continue;
    }
    const lifetimeMs=worker.endedMs-worker.createdMs;
    if(worker.state==='terminated'&&Number.isFinite(lifetimeMs)&&
      lifetimeMs>=0&&lifetimeMs<=periodMs*2&&worker.tasks<=1){
      shortLived.push({workerId,reason:'ended-before-heap-sample',lifetimeMs});
    }else required.push(workerId);
  }
  return {required,shortLived,notApplicable};
}
export function classifyWorkerHeapEvidence(workers,availableIds,records,periodMs=1000,observations){
  const {required,shortLived,notApplicable}=classifyWorkerHeapCoverage(workers,availableIds,periodMs);
  const missing=required.filter(id=>!records.has(id));
  const unavailable=required.filter(id=>records.has(id)).map(id=>records.get(id));
  for(const [workerId,worker] of Object.entries(workers??{})){
    if(!availableIds.has(workerId)||worker.family==='host'||worker.family==='external'||
      worker.state==='terminated'&&worker.tasks===0)continue;
    const lifetimeMs=worker.endedMs-worker.createdMs;
    if(worker.state==='terminated'&&Number.isFinite(lifetimeMs)&&
      lifetimeMs>=0&&lifetimeMs<=periodMs*2&&worker.tasks<=1)continue;
    const record=records.get(workerId);
    if(!record){missing.push(workerId);continue;}
    if((record.failedSamples??0)>0||record.availability==='unavailable'||
      (record.maxSampleGapMs??0)>periodMs*2||(record.maxSampleDelayMs??0)>periodMs*2)
      unavailable.push({...record,availability:'unavailable',reason:record.lastFailureReason??'worker-heap-sampling-gap'});
  }
  if(observations)for(const [workerId,coverage] of observations){
    const worker=workers?.[workerId];if(!worker||worker.family==='host'||worker.family==='external'||
      notApplicable.some(r=>r.workerId===workerId)||shortLived.some(r=>r.workerId===workerId))continue;
    const absent=missing.indexOf(workerId);if(absent>=0)missing.splice(absent,1);
    for(let i=unavailable.length-1;i>=0;i--)if(unavailable[i].workerId===workerId)unavailable.splice(i,1);
    if(!coverage.complete)unavailable.push({...records.get(workerId),workerId,family:worker.family,availability:'unavailable',reason:coverage.reason??'worker-heap-observation-gap',observationCoverage:coverage});
  }
  return {missing,unavailable,shortLived,notApplicable};
}
