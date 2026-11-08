/** A target that ended before two sampling periods has an explicit gap, not a zero-byte heap. */
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
export function classifyWorkerHeapEvidence(workers,availableIds,records,periodMs=1000){
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
  return {missing,unavailable,shortLived,notApplicable};
}
