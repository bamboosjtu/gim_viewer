/** CDP sample weights are estimates, never Span CPU accounting. */
export function cpuHotspots(profile,limit=20){
  if(!Array.isArray(profile.nodes)||!Array.isArray(profile.samples)||!Array.isArray(profile.timeDeltas)||
    profile.samples.length!==profile.timeDeltas.length)return {availability:'unavailable',reason:'profile-samples-invalid'};
  const nodes=new Map(profile.nodes.map(n=>[n.id,n])),weights=new Map();
  for(let i=0;i<profile.samples.length;i++){
    const id=profile.samples[i],delta=profile.timeDeltas[i];
    if(!nodes.has(id)||!Number.isFinite(delta)||delta<0)return {availability:'unavailable',reason:'profile-weight-invalid'};
    weights.set(id,(weights.get(id)??0)+delta/1000);
  }
  return {availability:'available',method:'CDP-sample-delta-estimate',unit:'ms',cpuTimeAvailable:false,
    samples:profile.samples.length,window:{start:profile.startTime,end:profile.endTime,unit:'us',clockId:'cdp-profile'},
    hotspots:[...weights].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([id,estimatedMs])=>({
      id:'node-'+id,estimatedMs,samples:profile.samples.filter(s=>s===id).length,callFrame:nodes.get(id).callFrame}))};
}
