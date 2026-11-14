import {digest,partialSignature} from './compare.mjs';
import {WORKER_HEAP_POLICY} from './cdp.mjs';
export function freezeProfile(registry,selection,name='commit-gate'){
  const chosen=selection.profiles[name];if(!Array.isArray(chosen)||!chosen.length)throw Error('Profile has no registered cases');
  const cases=chosen.map(row=>{
    const sample=registry.samples.find(s=>s.sampleId===row.sampleId&&s.sourceSha256===row.sourceSha256);
    if(!sample||sample.inventory.status!=='available')throw Error('Profile source/inventory missing');
    const isIndexRegression=sample.workloadProfile==='full-package-index';
    return {sampleId:sample.sampleId,sourceSha256:sample.sourceSha256,memberships:sample.memberships,
      scenario:isIndexRegression?'open-and-fidelity':'open',
      actions:name==='geometry'?[{kind:'dev-fine',selector:'canonical-first-boolean-base-v1'}]:isIndexRegression?[{kind:'dev-fine',selector:'canonical-first-base-v1'},{kind:'ifc-near',selector:'smallest-source-canonical-small-object-v1'},{kind:'ifc-fine',selector:'smallest-source-canonical-small-object-v1'}]:[],
      timeoutMs:sample.inventory.files>=50000?3600000:900000,reason:row.reason??'registered-regression'};
  });
  const body={version:'gim-benchmark-profile-v1',name,frozen:true,repetitions:3,cacheStates:['cold','warm'],mode:'benchmark',detailPolicy:'task-phase-timeline-v1',lifecyclePolicy:'worker-terminal-v1',contentPolicy:'dev-l0-glb-sha256-v1',cacheProofPolicy:'source-failure-catalog-v1',webviewProfilePolicy:'paired-webview-profile-v1',workerHeapPolicy:WORKER_HEAP_POLICY.version,samplingPeriodMs:WORKER_HEAP_POLICY.periodMs,samplingCadenceMs:WORKER_HEAP_POLICY.cadenceMs,viewProtocol:'near-inspect-and-restore-v1',
    completion:'automatic-representations-and-cache-publication',correctness:'source-invariants-and-cold-warm-base-equivalence',
    requiredWorkerFamilies:name==='commit-gate'?['dev','engineering','spatial','line','ifc-conversion','ifc-regional','ifc-fine']:[],cases};
  return {...body,digest:digest(body)};
}
export function verifyProfile(profile){const {digest:stored,...body}=profile;if(!profile.frozen||stored!==digest(body))throw Error('Frozen profile digest mismatch');return profile;}
export function coldWarmEquivalent(cold,warm){
  const reasons=[];
  if(cold.correctness!==warm.correctness)reasons.push('cold-warm:correctness');
  if(cold.correctness==='partial'||warm.correctness==='partial'){
    if(partialSignature(cold)!==partialSignature(warm))reasons.push('cold-warm:partial-coverage');
  }
  for(const field of ['semanticDigest','placementDigest','baseGeometryDigest','baseArtifactDigest'])if(cold.evidence?.[field]!==warm.evidence?.[field])reasons.push(`cold-warm:${field}`);
  for(const field of ['pendingCount','pendingSourceCount','pendingDigest'])if(cold.evidence?.[field]!==warm.evidence?.[field])reasons.push(`cold-warm:${field}`);
  if(cold.conditions.sourceSha256!==warm.conditions.sourceSha256)reasons.push('cold-warm:source');
  if(JSON.stringify(cold.evidence?.progress.workload)!==JSON.stringify(warm.evidence?.progress.workload))reasons.push('cold-warm:workload');
  if(JSON.stringify(cold.actionTargetDigests)!==JSON.stringify(warm.actionTargetDigests))reasons.push('cold-warm:action-targets');
  return {outcome:reasons.length?'FAIL':cold.correctness==='partial'?'PARTIAL':'PASS',reasons};
}
export function warmCatalogCoverage(evidence){
  const progress=evidence?.progress,required=progress?.workload?.devSources??0,hits=progress?.cache?.devCatalogHits??0;
  if(!required||hits>=required)return {valid:true,sourceFailureMisses:0};
  const proof=evidence?.catalogCacheEvidence,defects=evidence?.geometryDefects;
  const sourceBacked=defects?.sourceEvidenceComplete===true&&/^[a-f0-9]{64}$/.test(defects.failedSourceSetDigest??'')&&
    Object.keys(defects.failedReasons??{}).every(reason=>['source-invalid','missing-dependency'].includes(reason));
  const valid=proof?.available===true&&proof.accounted===true&&proof.unexplainedMissCount===0&&
    proof.sourceFailureMissCount===proof.missCount&&sourceBacked;
  return {valid,sourceFailureMisses:valid?proof.missCount:0};
}
export function cachePublicationAssessment(evidence,cacheState,projectType){
  const progress=evidence?.progress,cache=evidence?.cache;
  if(!cache?.sourceMatches||!progress?.cacheSettled||progress.cache.writeFailures||progress.cache.readFailures||
    progress.cachePersistenceStatus==='failed')return {published:false,reason:'cache-source-or-write-unverified'};
  if(projectType==='transmission_line')return cache.linePersistence==='saved'&&cache.projectTypeCommitted===true&&cache.linePackAssessment==='valid'
    ?{published:true,coverageComplete:true,derivedCacheStatus:'not-applicable'}:{published:false,reason:'line-cache-unpublished'};
  if(projectType==='substation'){
    if(!cache.semanticValid||cache.parserMatches!==true||cache.entries<1||
      cache.cachedIfc!==progress.workload.ifcSources||cache.missingIfc!==0)
      return {published:false,reason:'substation-core-cache-unpublished'};
    const coverageComplete=evidence.engineeringCoverage?.complete!==false;
    const engineering=progress.cache.engineering;
    if(['error','disabled','loading','saving'].includes(engineering)||
      (coverageComplete&&!['hit','saved'].includes(engineering))||
      (!coverageComplete&&!['partial','hit','saved'].includes(engineering)))
      return {published:false,reason:'engineering-cache-state-invalid'};
    if(cacheState==='warm'&&coverageComplete&&engineering!=='hit')
      return {published:false,reason:'engineering-derived-cache-miss'};
    const catalog=cacheState==='warm'?warmCatalogCoverage(evidence):{valid:true,sourceFailureMisses:0};
    if(!catalog.valid)
      return {published:false,reason:'dev-catalog-warm-miss'};
    return {published:true,coverageComplete,derivedCacheStatus:engineering,
      catalogSourceFailureMisses:catalog.sourceFailureMisses};
  }
  if(cacheState==='warm'&&!warmCatalogCoverage(evidence).valid)
    return {published:false,reason:'dev-catalog-warm-miss'};
  return {published:true,coverageComplete:true,derivedCacheStatus:'not-applicable'};
}
export const cacheVerified=(evidence,cacheState,projectType)=>cachePublicationAssessment(evidence,cacheState,projectType).published;
