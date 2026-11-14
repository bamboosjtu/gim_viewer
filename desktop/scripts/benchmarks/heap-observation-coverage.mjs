/** Coverage of real heap observations. A confirmed, fully recorded stop-the-
 * world GC is a measured interval, not an unexplained sampling hole. Raw wall
 * gaps and failed RPCs stay visible independently. */
export function heapObservationCoverage({samples,pauses=[],createdMs,endedMs,uncertaintyMs=0,maxGapMs=2000}){
  if(!Number.isFinite(createdMs)||!Number.isFinite(endedMs)||endedMs<createdMs||!Number.isFinite(uncertaintyMs)||uncertaintyMs<0)
    return {complete:false,reason:'heap-lifetime-unverified'};
  const points=samples.filter(r=>Number.isFinite(r.atMs)&&Number.isFinite(r.bytes)&&r.bytes>=0&&r.atMs>=createdMs&&r.atMs<=endedMs).sort((a,b)=>a.atMs-b.atMs);
  if(!points.length)return {complete:false,reason:'heap-observations-missing'};
  const intervals=pauses.filter(p=>p.verified===true&&Number.isFinite(p.startMs)&&Number.isFinite(p.endMs)&&p.startMs>=createdMs&&p.endMs<=endedMs&&p.endMs>p.startMs
    &&Number.isFinite(p.beforeBytes)&&p.beforeBytes>=0&&Number.isFinite(p.afterBytes)&&p.afterBytes>=0)
    .map(p=>({startMs:p.startMs+uncertaintyMs,endMs:p.endMs-uncertaintyMs})).filter(p=>p.endMs>p.startMs).sort((a,b)=>a.startMs-b.startMs);
  const merged=[];for(const interval of intervals){const last=merged[merged.length-1];if(last&&interval.startMs<=last.endMs)last.endMs=Math.max(last.endMs,interval.endMs);else merged.push({...interval});}
  const all=[{atMs:createdMs,earliestAtMs:createdMs,latestAtMs:createdMs},...points,{atMs:endedMs,earliestAtMs:endedMs,latestAtMs:endedMs}];
  let maxWallGapMs=0,maxUnobservedGapMs=0,observedPeakBytes=0;
  for(const point of points)observedPeakBytes=Math.max(observedPeakBytes,point.bytes);
  for(let i=1;i<all.length;i++){
    const from=all[i-1].earliestAtMs??all[i-1].atMs-uncertaintyMs,to=all[i].latestAtMs??all[i].atMs+uncertaintyMs;let recordedGc=0;
    let low=0,high=merged.length;
    while(low<high){const middle=(low+high)>>>1;if(merged[middle].endMs<=from)low=middle+1;else high=middle;}
    for(let j=low;j<merged.length;j++){const pause=merged[j];if(pause.startMs>=to)break;if(pause.endMs>from)recordedGc+=Math.max(0,Math.min(to,pause.endMs)-Math.max(from,pause.startMs));}
    maxWallGapMs=Math.max(maxWallGapMs,all[i].atMs-all[i-1].atMs);maxUnobservedGapMs=Math.max(maxUnobservedGapMs,to-from-recordedGc);
  }
  return {complete:maxUnobservedGapMs<=maxGapMs,reason:maxUnobservedGapMs<=maxGapMs?null:'worker-heap-observation-gap',
    samples:points.length,observedPeakBytes,maxWallGapMs,maxUnobservedGapMs,
    confirmedGcPauses:intervals.length,uncertaintyMs,maxGapMs,scope:'isolate-observable-heap; process peak includes GC allocation capacity separately'};
}
