/** The product can become interactive before cache and post-interactive work settle. */
import {digest} from './compare.mjs';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const progressDigest=progress=>progress?digest(canonical(progress)):null;
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
export function finalEvidenceIssue(evidence,observation){
  if(evidence?.checks?.some(check=>check.name==='session-stable'&&check.passed===true)!==true)
    return 'session-mismatch';
  if(!Number.isFinite(evidence.evidenceAtMs)||!Number.isFinite(observation?.snapshotAtMs)||
    observation.snapshotAtMs<evidence.evidenceAtMs)return 'clock-invalid';
  if(!evidence.progress||!observation.progress)return 'evidence-missing';
  if(!Array.isArray(observation.measurement?.activeTasks))return 'task-state-missing';
  if(observation.measurement.activeTasks.length)return 'active-tasks';
  if(progressDigest(evidence.progress)!==progressDigest(observation.progress))return 'progress-drift';
  return null;
}
export const finalEvidenceAligned=(evidence,observation)=>finalEvidenceIssue(evidence,observation)===null;
