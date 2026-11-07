/** The product can become interactive before cache and post-interactive work settle. */
export function readyForSettle(observation){
  const progress=observation?.progress,measurement=observation?.measurement;
  return progress?.automaticSettled===true&&progress.cacheSettled===true&&progress.backgroundSettled===true
    &&Array.isArray(measurement?.activeTasks)&&measurement.activeTasks.length===0;
}
export function cachePublicationMoment(observation){
  if(observation?.progress?.cache?.linePersistence==='failed')return null;
  return observation?.projectType==='transmission_line'
    ?observation.moments?.lineCachePersistenceReady??observation.openElapsedMs
    :observation?.openElapsedMs??null;
}
