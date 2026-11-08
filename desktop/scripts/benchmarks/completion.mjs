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
/** Final runtime evidence must describe the same settled state as the final snapshot. */
export function finalEvidenceAligned(evidence,observation){
  return evidence?.checks?.some(check=>check.name==='session-stable'&&check.passed===true)===true&&
    Number.isFinite(evidence.evidenceAtMs)&&Number.isFinite(observation?.snapshotAtMs)&&
    observation.snapshotAtMs>=evidence.evidenceAtMs&&!!evidence.progress&&!!observation.progress&&
    observation.measurement?.activeTasks?.length===0&&
    JSON.stringify(evidence.progress)===JSON.stringify(observation.progress);
}
