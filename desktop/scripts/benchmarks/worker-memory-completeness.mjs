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
  return {missing:required.filter(id=>!records.has(id)),
    unavailable:required.filter(id=>records.has(id)).map(id=>records.get(id)),shortLived,notApplicable};
}
