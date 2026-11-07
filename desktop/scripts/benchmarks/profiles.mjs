import {digest} from './compare.mjs';
export function freezeProfile(registry,selection,name='commit-gate'){
  const chosen=name==='geometry'?selection.profiles['commit-gate'].filter(row=>row.sampleId==='gim-3197c03ef2c6c423'):selection.profiles[name];if(!Array.isArray(chosen)||!chosen.length)throw Error('Profile has no registered cases');
  const cases=chosen.map(row=>{
    const sample=registry.samples.find(s=>s.sampleId===row.sampleId&&s.sourceSha256===row.sourceSha256);
    if(!sample||sample.inventory.status!=='available')throw Error('Profile source/inventory missing');
    const isIndexRegression=sample.requiredRegression==='full-package-index';
    return {sampleId:sample.sampleId,sourceSha256:sample.sourceSha256,memberships:sample.memberships,
      scenario:isIndexRegression?'open-and-fidelity':'open',
      actions:name==='geometry'?[{kind:'dev-fine',selector:'canonical-first-boolean-base-v1'}]:isIndexRegression?[{kind:'dev-fine',selector:'canonical-first-base-v1'},{kind:'ifc-near',selector:'smallest-source-canonical-small-object-v1'},{kind:'ifc-fine',selector:'smallest-source-canonical-small-object-v1'}]:[],
      timeoutMs:sample.inventory.files>=50000?3600000:900000,reason:row.reason??'registered-regression'};
  });
  const body={version:'gim-benchmark-profile-v2',name,frozen:true,repetitions:3,cacheStates:['cold','warm'],mode:'benchmark',samplingPeriodMs:1000,viewProtocol:'near-inspect-and-restore-v1',
    completion:'automatic-representations-and-cache-publication',correctness:'source-invariants-and-cold-warm-base-equivalence',
    requiredWorkerFamilies:name==='commit-gate'?['dev','engineering','spatial','line','ifc-conversion','ifc-regional','ifc-fine']:[],cases};
  return {...body,digest:digest(body)};
}
export function verifyProfile(profile){const {digest:stored,...body}=profile;if(!profile.frozen||stored!==digest(body))throw Error('Frozen profile digest mismatch');return profile;}
export function coldWarmEquivalent(cold,warm){
  const reasons=[];
  for(const field of ['semanticDigest','placementDigest','baseGeometryDigest','baseArtifactDigest'])if(cold.evidence?.[field]!==warm.evidence?.[field])reasons.push(`cold-warm:${field}`);
  if(cold.conditions.sourceSha256!==warm.conditions.sourceSha256)reasons.push('cold-warm:source');
  if(JSON.stringify(cold.evidence?.progress.workload)!==JSON.stringify(warm.evidence?.progress.workload))reasons.push('cold-warm:workload');
  if(JSON.stringify(cold.actionTargetDigests)!==JSON.stringify(warm.actionTargetDigests))reasons.push('cold-warm:action-targets');
  return {outcome:reasons.length?'FAIL':'PASS',reasons};
}
export function cacheVerified(evidence,cacheState,projectType){
  if(!evidence?.cache?.sourceMatches||evidence.progress.cache.writeFailures||evidence.progress.cache.readFailures||!evidence.progress.cacheSettled)return false;
  if(projectType==='transmission_line')return evidence.cache.linePersistence==='saved'&&evidence.cache.projectTypeCommitted===true&&evidence.cache.linePackAssessment==='valid';
  if(projectType==='substation'&&(!evidence.cache.semanticValid||!['hit','saved'].includes(evidence.progress.cache.engineering)))return false;
  if(cacheState==='cold')return true;
  if(projectType==='substation'&&evidence.progress.cache.engineering!=='hit')return false;
  if(projectType==='substation'&&evidence.progress.workload.ifcSources&&(
    evidence.cache.parserMatches!==true||evidence.cache.cachedIfc!==evidence.progress.workload.ifcSources||evidence.cache.missingIfc!==0))return false;
  return !evidence.progress.workload.devSources||evidence.progress.cache.devCatalogHits>=evidence.progress.workload.devSources;
}
