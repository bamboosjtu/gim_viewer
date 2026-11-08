/** A target that ended before two sampling periods has an explicit gap, not a zero-byte heap. */
export function classifyWorkerHeapCoverage(workers,observedIds,mappedIds,periodMs=1000){
  const required=[],shortLived=[];
  for(const [workerId,worker] of Object.entries(workers??{})){
    if(observedIds.has(workerId))continue;
    const lifetimeMs=worker.endedMs-worker.createdMs;
    if(mappedIds.has(workerId)&&worker.state==='terminated'&&Number.isFinite(lifetimeMs)&&
      lifetimeMs>=0&&lifetimeMs<=periodMs*2&&worker.tasks<=1){
      shortLived.push({workerId,reason:'ended-before-heap-sample',lifetimeMs});
    }else required.push(workerId);
  }
  return {required,shortLived};
}
export function classifyWorkerHeapEvidence(workers,availableIds,records,mappedIds,periodMs=1000){
  const {required,shortLived}=classifyWorkerHeapCoverage(workers,availableIds,mappedIds,periodMs);
  return {missing:required.filter(id=>!records.has(id)),
    unavailable:required.filter(id=>records.has(id)).map(id=>records.get(id)),shortLived};
}
