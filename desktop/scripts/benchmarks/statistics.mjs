/** Shared value calculations; no application state or approval logic. */
export function median(values){
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}
export function retainedMemory(cycles){
  const early=cycles.slice(1,4).map(row=>row.memory?.bytes),late=cycles.slice(-3).map(row=>row.memory?.bytes);
  if(early.length!==3||late.length!==3||[...early,...late].some(value=>!Number.isFinite(value)||value<=0))
    return {earlyMedianBytes:null,lateMedianBytes:null,growth:null};
  const earlyMedianBytes=median(early),lateMedianBytes=median(late);
  return {earlyMedianBytes,lateMedianBytes,growth:lateMedianBytes/earlyMedianBytes-1};
}
