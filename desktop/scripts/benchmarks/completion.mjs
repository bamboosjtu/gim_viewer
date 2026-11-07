/** The product can become interactive before cache and post-interactive work settle. */
export function readyForSettle(observation,{cacheState}={}){
  const progress=observation?.progress,measurement=observation?.measurement;
  const coldSubstation=cacheState==='cold'&&observation?.projectType==='substation';
  return progress?.automaticSettled===true&&progress.cacheSettled===true&&progress.backgroundSettled===true
    &&(!coldSubstation||observation.cachePersistence?.observed===true)
    &&Array.isArray(measurement?.activeTasks)&&measurement.activeTasks.length===0;
}
export function cachePublicationMoment(observation){
  if(observation?.progress?.cache?.linePersistence==='failed'||observation?.cachePersistence?.available===false)return null;
  return observation?.projectType==='transmission_line'
    ?observation.moments?.lineCachePersistenceReady??observation.openElapsedMs
    :observation?.projectType==='substation'
      ?observation?.cachePersistence?.observed?observation.moments?.cachePersistenceReady??null:null
      :observation?.openElapsedMs??null;
}
