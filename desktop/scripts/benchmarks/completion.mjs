/** The product can become interactive before cache and post-interactive work settle. */
import {digest} from './compare.mjs';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const progressDigest=progress=>progress?digest(canonical(progress)):null;
export function semanticStallReason(observation,idleMs){
  if(observation?.projectType!=='substation'||
    observation.progress?.semantic!==false&&observation.progress?.engineeringBuildPending!==true)return null;
  const active=observation.measurement?.activeTasks?.some(task=>task.family==='engineering')===true;
  return idleMs>=(active?60_000:120_000)?active?'product-stalled':'engineering-progress-stalled':null;
}
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

const sessionKey=snapshot=>JSON.stringify([snapshot?.measurement?.identity?.runId??null,snapshot?.session??null]);
/** The quiet window covers the same progress payload as the final guard. */
export function createSettleWindow({cacheState,quietMs=3000,now=()=>performance.now()}={}){
  let since=null,key=null;
  return {observe(snapshot){
    if(!readyForSettle(snapshot,{cacheState})){since=null;key=null;return false;}
    const next=sessionKey(snapshot)+'\0'+progressDigest(snapshot.progress),at=now();
    if(next!==key){key=next;since=at;}
    return at-since>=quietMs;
  }};
}
export function progressChanges(before,after,limit=64){
  const changes=[];let omitted=0;
  function visit(a,b,path){
    if(JSON.stringify(canonical(a))===JSON.stringify(canonical(b)))return;
    if(a&&b&&typeof a==='object'&&typeof b==='object'){
      for(const key of new Set([...Object.keys(a),...Object.keys(b)]))visit(a[key],b[key],path?path+'.'+key:key);
    }else if(changes.length<limit)changes.push({path,before:a??null,after:b??null});else omitted++;
  }
  visit(before,after,'');return {changes,omitted};
}
/** Retry only inside the captured session, with a fresh quiet window each time.
 * Every rejected evidence pair remains in the private diagnostic record. */
export async function collectFinalEvidence({readEvidence,readSnapshot,initialSnapshot,cacheState,
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>performance.now(),maxAttempts=3,timeoutMs=15000}){
  const expected=sessionKey(initialSnapshot),deadline=now()+timeoutMs,drifts=[];
  let evidence,observation=initialSnapshot,issue=null,attempts=0;
  for(;attempts<maxAttempts;){
    evidence=await readEvidence();observation=await readSnapshot();attempts++;
    issue=sessionKey(observation)!==expected?'session-mismatch':finalEvidenceIssue(evidence,observation);
    if(!issue)break;
    drifts.push({attempt:attempts,issue,evidenceAtMs:evidence?.evidenceAtMs,snapshotAtMs:observation?.snapshotAtMs,
      ...progressChanges(evidence?.progress,observation?.progress)});
    if(!['progress-drift','active-tasks'].includes(issue)||attempts>=maxAttempts)break;
    const stable=createSettleWindow({cacheState,now});let ready=false;
    while(now()<deadline){
      observation=await readSnapshot();
      if(sessionKey(observation)!==expected){issue='session-mismatch';break;}
      if(stable.observe(observation)){ready=true;break;}
      await wait(250);
    }
    if(!ready)break;
  }
  return {evidence,observation,issue,attempts,drifts};
}
