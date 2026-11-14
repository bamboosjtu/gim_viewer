import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareRuns,compareSuites,approveBaseline,baselineApprovalIssue,runReadiness,digest,createPartialReview} from './compare.mjs';
import {selectSamples} from './samples.mjs';
import {CdpConnection} from './cdp.mjs';
import {cacheVerified,coldWarmEquivalent,freezeProfile,verifyProfile,warmCatalogCoverage} from './profiles.mjs';
import {readyForSettle,cachePublicationMoment,finalEvidenceAligned,finalEvidenceIssue,semanticStallReason} from './completion.mjs';
import {prepareFixedRuntimeSecurity} from '../fixed-runtime-security.mjs';
import {warmPreparation} from './warm-preparation.mjs';
import {bareContainerKind} from './container-magic.mjs';
import {runMatrix} from './matrix.mjs';
import {nativeExitCode} from './cli-outcome.mjs';
import {pairedWebviewProfile,checkedWebviewProfile} from './cache-roots.mjs';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join,dirname} from 'node:path';
import {benchmarkRun} from './test-fixtures.mjs';
import {MEASUREMENT_VERSION} from '../../../packages/measurement-core/src/version.mjs';
import {createSettleWindow,collectFinalEvidence,progressChanges} from './completion.mjs';
test('quiet window resets when progress counters change despite settled flags',()=>{
  let now=0;const stable=createSettleWindow({now:()=>now});
  const snapshot=value=>({session:{generation:1},progress:{automaticSettled:true,cacheSettled:true,backgroundSettled:true,cache:{hits:value}},measurement:{activeTasks:[]}});
  assert.equal(stable.observe(snapshot(1)),false);now=2999;assert.equal(stable.observe(snapshot(1)),false);
  now=3000;assert.equal(stable.observe(snapshot(2)),false);now=6000;assert.equal(stable.observe(snapshot(2)),true);
});
test('final evidence retries within one session and retains the rejected field differences',async()=>{
  let now=0,reads=0;
  const progress={automaticSettled:true,cacheSettled:true,backgroundSettled:true,cache:{hits:2}};
  const snapshot=()=>({session:{generation:1},snapshotAtMs:now+1,progress,measurement:{activeTasks:[]}});
  const result=await collectFinalEvidence({initialSnapshot:snapshot(),now:()=>now,wait:async ms=>{now+=ms;},readSnapshot:async()=>snapshot(),
    readEvidence:async()=>({evidenceAtMs:now,checks:[{name:'session-stable',passed:true}],progress:++reads===1?{...progress,cache:{hits:1}}:progress})});
  assert.equal(result.issue,null);assert.equal(result.attempts,2);
  assert.deepEqual(result.drifts[0].changes,[{path:'cache.hits',before:1,after:2}]);
});
test('persistent drift is bounded and a changed session cannot be retried into success',async()=>{
  let now=0;
  const progress={automaticSettled:true,cacheSettled:true,backgroundSettled:true,cache:{hits:2}};
  const snapshot={session:{generation:1},snapshotAtMs:10000,progress,measurement:{activeTasks:[]}};
  const readEvidence=async()=>({evidenceAtMs:0,checks:[{name:'session-stable',passed:true}],progress:{...progress,cache:{hits:1}}});
  const options={initialSnapshot:snapshot,now:()=>now,wait:async ms=>{now+=ms;},readSnapshot:async()=>snapshot,readEvidence};
  const permanent=await collectFinalEvidence(options);assert.equal(permanent.issue,'progress-drift');assert.equal(permanent.attempts,3);
  const changed=await collectFinalEvidence({...options,readSnapshot:async()=>({...snapshot,session:{generation:2}})});
  assert.equal(changed.issue,'session-mismatch');assert.equal(changed.attempts,1);
  assert.equal(progressChanges({a:1,b:2},{a:2,b:3},1).omitted,1);
});
const conditions={machineId:'machine',runtimeSha256:'runtime',buildMode:'release',measurementVersion:MEASUREMENT_VERSION,detailPolicy:'task-phase-timeline-v1',lifecyclePolicy:'worker-terminal-v1',contentPolicy:'dev-l0-glb-sha256-v1',cacheProofPolicy:'source-failure-catalog-v1',webviewProfilePolicy:'paired-webview-profile-v1',mode:'benchmark',scenario:'open',cacheState:'cold',sourceSha256:'source',sampleId:'sample',profileDigest:'profile',workloadDigest:'workload',routeDigest:'route',viewportDigest:'viewport'};
// These value-level tests also exercise historical reports without native version tags.
const runs=(prefix,value)=>Array.from({length:3},(_,i)=>benchmarkRun(`${prefix}-${i}`,{
  version:undefined,conditions,requiredMetrics:['openMs'],metrics:{openMs:value+i}}));
test('warm preparation follows cache publication for both batch and matrix',()=>{
  const cold={correctness:'partial',cachePublished:true,cacheFailureCount:0,reason:null,crashed:false};
  assert.equal(warmPreparation(cold).ready,true);
  assert.equal(warmPreparation({...cold,reason:'final-evidence-drift'}).ready,true);
  assert.equal(warmPreparation({...cold,cachePublished:false,cacheFailureCode:'CACHE_NOT_PERSISTABLE'}).reason,
    'WARM_UNSUPPORTED:CACHE_NOT_PERSISTABLE');
  assert.equal(warmPreparation({...cold,cachePublished:false}).ready,false);
});
test('bare archive variant probe covers ZIP local, empty and split signatures',()=>{
  for(const suffix of ['0304','0506','0708'])assert.equal(bareContainerKind(Buffer.from(`504b${suffix}`,'hex')),'zip');
  assert.equal(bareContainerKind(Buffer.from('377abcaF271c','hex')),'7z');
});
test('single native run returns success for evidence-backed PARTIAL',()=>{
  assert.equal(nativeExitCode('run','PARTIAL'),0);
  assert.equal(nativeExitCode('run','FAIL'),1);
  assert.equal(nativeExitCode('run','INCONCLUSIVE'),2);
  assert.equal(nativeExitCode('doctor','PARTIAL'),2);
});
test('cold and warm processes reuse the same WebView2 IndexedDB profile',()=>{
  const dataRoot=join(resolve('..','tmp','profile-protocol'), 'cache');
  assert.equal(pairedWebviewProfile(dataRoot),join(resolve('..','tmp','profile-protocol'),'webview-profile'));
});
test('cold rejects an existing WebView2 profile even when SQLite root is empty',()=>{
  const parent=resolve('..','tmp','profile-protocol-tests');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'case-')),dataRoot=join(root,'cache');mkdirSync(dataRoot);
  const profile=checkedWebviewProfile(root,dataRoot,'cold');mkdirSync(profile);
  writeFileSync(join(profile,'IndexedDB-marker'),'cached');
  assert.throws(()=>checkedWebviewProfile(root,dataRoot,'cold'),/Cold WebView2 profile/);
  assert.equal(checkedWebviewProfile(root,dataRoot,'warm'),profile);
});
test('warm refuses a missing or empty paired WebView2 profile',()=>{
  const parent=resolve('..','tmp','profile-protocol-tests');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'warm-')),dataRoot=join(root,'cache');mkdirSync(dataRoot);
  assert.throws(()=>checkedWebviewProfile(root,dataRoot,'warm'),/warm-webview-profile-unavailable/);
  const profile=pairedWebviewProfile(dataRoot);mkdirSync(profile);
  assert.throws(()=>checkedWebviewProfile(root,dataRoot,'warm'),/warm-webview-profile-unavailable/);
  writeFileSync(join(profile,'state'),'cached');
  assert.equal(checkedWebviewProfile(root,dataRoot,'warm'),profile);
});
test('matrix never attempts warm for a non-persistable input variant',async()=>{
  const workspace=resolve('..','tmp','matrix-protocol-tests');mkdirSync(workspace,{recursive:true});
  const root=mkdtempSync(join(workspace,'case-'));
  const sample={sampleId:'sample',sourceSha256:'a'.repeat(64)};
  const body={frozen:true,repetitions:1,mode:'benchmark',requiredWorkerFamilies:[],
    cases:[{sampleId:sample.sampleId,sourceSha256:sample.sourceSha256,scenario:'open',actions:[],timeoutMs:1000}]};
  const profile={...body,digest:digest(body)};let calls=0;
  const result=await runMatrix({root,buildManifest:'unused',registry:{samples:[sample]},profile,
    execute:async()=>{calls++;return {dataRoot:'unused',report:{...runs('cold',10)[0],
      cachePublished:false,cacheFailureCode:'CACHE_NOT_PERSISTABLE',correctness:'partial',
      defectAssessment:{kind:'input-variant',variant:'bare-zip'}}};}});
  assert.equal(calls,1);
  assert.deepEqual(result.result.pairs[0].reasons,['WARM_UNSUPPORTED:CACHE_NOT_PERSISTABLE']);
});
test('final evidence rejects a task that changes progress during tail drain',()=>{
  const evidence={evidenceAtMs:10,checks:[{name:'session-stable',passed:true}],progress:{workload:{shown:1}}};
  const snapshot={snapshotAtMs:11,measurement:{activeTasks:[]},progress:{workload:{shown:2}}};
  assert.equal(finalEvidenceAligned(evidence,snapshot),false);
  assert.equal(finalEvidenceIssue(evidence,snapshot),'progress-drift');
  assert.equal(finalEvidenceIssue(evidence,{...snapshot,measurement:{activeTasks:[{family:'spatial'}]}}),'active-tasks');
  assert.equal(finalEvidenceIssue({...evidence,checks:[{name:'session-stable',passed:false}]},snapshot),'session-mismatch');
  assert.equal(finalEvidenceAligned({...evidence,progress:snapshot.progress},snapshot),true);
  assert.equal(finalEvidenceAligned({...evidence,progress:{cache:{b:2,a:1},workload:{shown:2}}},
    {...snapshot,progress:{workload:{shown:2},cache:{a:1,b:2}}}),true);
  assert.equal(finalEvidenceAligned({...evidence,evidenceAtMs:12,progress:snapshot.progress},snapshot),false);
});
test('semantic stall distinguishes an active engineering task from an idle missing result',()=>{
  const active={projectType:'substation',progress:{semantic:false},measurement:{activeTasks:[{family:'engineering'}]}};
  assert.equal(semanticStallReason(active,59_999),null);
  assert.equal(semanticStallReason(active,60_000),'product-stalled');
  assert.equal(semanticStallReason({...active,measurement:{activeTasks:[]}},60_000),null);
  assert.equal(semanticStallReason({...active,measurement:{activeTasks:[]}},120_000),'engineering-progress-stalled');
  assert.equal(semanticStallReason({...active,progress:{semantic:true,engineeringBuildPending:true},
    measurement:{activeTasks:[]}},120_000),'engineering-progress-stalled');
});
test('missing evidence is inconclusive, explicit correctness failure is fail',()=>{
  const b=runs('base',100),c=runs('candidate',100);c[0].measurementComplete=false;assert.equal(compareRuns(b,c).outcome,'INCONCLUSIVE');c[0].correctness='failed';assert.equal(compareRuns(b,c).outcome,'FAIL');
});
test('changed Worker heap acquisition policies cannot be mixed into a comparable suite',()=>{
 const before=runs('before-policy',100),after=runs('after-policy',100);
 for(const row of after)row.conditions.workerHeapPolicy='isolated-cdp-heap-v1';
 const comparison=compareRuns(before,after);
 assert.equal(comparison.outcome,'INCONCLUSIVE');assert.ok(comparison.reasons.includes('incomparable:workerHeapPolicy'));
 for(const row of before)row.conditions.workerHeapPolicy='isolated-cdp-heap-v1';
 assert.equal(compareRuns(before,after).outcome,'PASS');
});
test('product pass remains visible when memory is unavailable, but comparison and approval reject it',()=>{
  const run={...runs('memory',100)[0],version:'gim-benchmark-v1',projectType:'transmission_line',
    requiredMetrics:['openMs','processPrivatePeakBytes'],metrics:{openMs:100,processPrivatePeakBytes:null},
    measurementLifecycleComplete:true,processSampling:{complete:false},memoryEvidenceComplete:false,
    memoryIncompleteItems:['process-tree:process-query-failed:5:20']};
  assert.equal(runReadiness(run).outcome,'PASS');
  const other={...run,processInstanceId:'other'};
  assert.equal(compareRuns([run],[other]).outcome,'INCONCLUSIVE');
  assert.throws(()=>approveBaseline({outcome:'PASS',selectionFrozen:true,runs:[run]},'developer'),/memory evidence is incomplete/);
});
test('CLI gate rejects a matrix missing a required Worker family before comparing matching runs',()=>{
  const parent=resolve('..','tmp','benchmark-gate-tests');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'case-'));
  try{
    const cold={...runs('baseline',100)[0],projectType:'transmission_line',repetition:0};
    const warm={...cold,processInstanceId:'baseline-warm',conditions:{...cold.conditions,cacheState:'warm'}};
    const baseline=approveBaseline({outcome:'PASS',selectionFrozen:true,runs:[cold,warm]},'developer');
    const candidate={version:'gim-benchmark-candidate-v1',outcome:'INCONCLUSIVE',selectionFrozen:true,
      profileDigest:'profile',requiredRuns:2,missingFamilies:['line'],
      pairs:[{sampleId:'sample',repetition:0,outcome:'PASS'}],
      runs:[{...cold,processInstanceId:'candidate-cold'},
        {...warm,processInstanceId:'candidate-warm'}]};
    assert.equal(compareSuites(baseline.runs,candidate.runs,{requireContentEvidence:true}).outcome,'PASS');
    const baselinePath=join(root,'baseline.json'),candidatePath=join(root,'candidate.json'),out=join(root,'comparison.json');
    writeFileSync(baselinePath,JSON.stringify(baseline));writeFileSync(candidatePath,JSON.stringify(candidate));
    const child=spawnSync(process.execPath,['scripts/benchmarks/cli.mjs','gate','--baseline',baselinePath,
      '--candidate',candidatePath,'--output',out],{cwd:resolve('.'),encoding:'utf8',timeout:10000,
      env:{...process.env,TEMP:root,TMP:root,TMPDIR:root}});
    assert.equal(child.status,2,child.stderr);
    const result=JSON.parse(readFileSync(out,'utf8'));
    assert.equal(result.outcome,'INCONCLUSIVE');
    assert.ok(result.reasons.some(reason=>reason.startsWith('matrix-worker-families-missing:')));
    candidate.outcome='PASS';candidate.missingFamilies=[];candidate.pairs=[];
    writeFileSync(candidatePath,JSON.stringify(candidate));
    const missingPair=spawnSync(process.execPath,['scripts/benchmarks/cli.mjs','gate','--baseline',baselinePath,
      '--candidate',candidatePath,'--output',out],{cwd:resolve('.'),encoding:'utf8',timeout:10000,
      env:{...process.env,TEMP:root,TMP:root,TMPDIR:root}});
    assert.equal(missingPair.status,2,missingPair.stderr);
    assert.ok(JSON.parse(readFileSync(out,'utf8')).reasons.includes('matrix-cold-warm-pairs-incomplete'));
  }finally{assert.equal(dirname(root),parent);rmSync(root,{recursive:true,force:true});}
});
test('interrupted lifecycle cannot pass even after active tasks are settled',()=>{
  const b=runs('base',100),c=runs('candidate',100);
  c[0].measurementLifecycleComplete=false;
  c[0].measurement={lifecycleComplete:false,lifecycleIssues:['worker-interrupted-tasks'],activeTasks:[]};
  c[0].measurementComplete=false;
  const result=compareRuns(b,c);
  assert.equal(result.outcome,'INCONCLUSIVE');
  assert.ok(result.reasons.includes('measurement-lifecycle-incomplete'));
});
test('native evidence requires a lifecycle verdict and a pending-aware semantic digest',()=>{
  const run={...runs('native',100)[0],version:'gim-benchmark-v1',
    semanticDigestScope:'engineering-with-pending-v1',pendingDigest:'c'.repeat(64),
    pendingCount:0,pendingSourceCount:0,measurementLifecycleComplete:true,
    evidence:{semanticDigest:'d'.repeat(64)}};
  assert.equal(runReadiness(run).reasons.includes('pending-evidence-missing'),false);
  assert.equal(runReadiness(run).reasons.includes('measurement-lifecycle-incomplete'),false);
  assert.ok(runReadiness({...run,measurementLifecycleComplete:undefined}).reasons.includes('measurement-lifecycle-incomplete'));
  assert.ok(runReadiness({...run,semanticDigestScope:'format-projection-v1'}).reasons.includes('pending-evidence-missing'));
});
test('confirmed archive corruption is an input error rather than a product invariant failure',()=>{
  const report={...runs('input',1)[0],inputIntegrity:'corrupt',correctness:'unverified',reason:'input-corrupt'};
  assert.deepEqual(runReadiness(report),{outcome:'INPUT_ERROR',reasons:['INPUT_CORRUPT']});
});
test('confirmed environment suspend is inconclusive rather than a product crash',()=>{
  const report={...runs('suspended',1)[0],crashed:false,
    environmentSuspend:{code:'INFRA_SUSPEND',observationGapMs:90000}};
  assert.deepEqual(runReadiness(report),{outcome:'INCONCLUSIVE',reasons:['INFRA_SUSPEND']});
});
test('detail truncation is visible even when aggregate counters survive',()=>{
  const b=runs('base',100),c=runs('candidate',100);
  c[0].measurementDetailDropped=10888;c[0].measurementDetailStatus='aggregate-only';
  const result=compareRuns(b,c);
  assert.equal(result.outcome,'PASS');
  assert.equal(c[0].measurementDetailDropped,10888);
});
test('different metric sets cannot pass by comparing missing values',()=>{
  const b=runs('base',100),c=runs('candidate',100);for(const run of c){run.requiredMetrics=['otherMs'];run.metrics={otherMs:1};}
  assert.equal(compareRuns(b,c).outcome,'INCONCLUSIVE');
});
test('adverse tradeoffs remain for human review after independent retest and cannot hide a mode change',()=>{
  const b=runs('b',100),c=runs('c',120);assert.equal(compareRuns(b,c).retestDecision,'developer');assert.equal(compareRuns(b,c).requiresRetest,undefined);
  assert.equal(compareRuns(b,c,{retestBaseline:runs('br',100),retestCandidate:runs('cr',120)}).outcome,'INCONCLUSIVE');
  c[0].conditions.mode='diagnostic';assert.equal(compareRuns(b,c).outcome,'INCONCLUSIVE');
});
test('baseline promotion is explicit and refuses incomplete or unfrozen candidates',()=>{
  const candidate={outcome:'PASS',selectionFrozen:true,runs:runs('base',100)};
  assert.throws(()=>approveBaseline(candidate,''));assert.throws(()=>approveBaseline({...candidate,selectionFrozen:false},'developer'));
  assert.ok(approveBaseline(candidate,'developer').approval.candidateDigest);
  assert.throws(()=>approveBaseline({...candidate,runs:candidate.runs.map(({contentEvidence,...run})=>run)},'developer'),/dev-content-evidence-incomplete/);
});
test('formal content gate detects byte changes hidden by the structural fingerprint',()=>{
  const baseline=runs('base',100).slice(0,1),candidate=runs('candidate',100).slice(0,1);
  assert.equal(compareRuns(baseline,candidate,{requireContentEvidence:true}).outcome,'PASS');
  candidate[0].contentEvidence.digest='c'.repeat(64);
  const result=compareRuns(baseline,candidate,{requireContentEvidence:true});
  assert.equal(result.outcome,'INCONCLUSIVE');
  assert.ok(result.reasons.includes('dev-content-digest-differs'));
});
test('single paired process is comparable; partial coverage needs explicit baseline acceptance',()=>{
  const b=runs('base',100).slice(0,1),c=runs('candidate',100).slice(0,1);
  assert.equal(compareRuns(b,c).outcome,'PASS');
  const partial=row=>({...row,correctness:'partial',defectAssessment:{kind:'source-geometry',status:'evidence-backed',sourceSha256:'source',sourceSetDigest:'a'.repeat(64),failedOccurrences:34}});
  assert.equal(compareRuns(b.map(partial),c.map(partial)).outcome,'PARTIAL');
  assert.equal(compareRuns(b,c.map(partial)).outcome,'INCONCLUSIVE');
  assert.equal(compareRuns(b.map(partial),c.map(row=>({...partial(row),evidence:{progress:{cache:{writeFailures:1}}}}))).outcome,'FAIL');
  const candidate={outcome:'PARTIAL',selectionFrozen:true,runs:b.map(partial)};
  assert.throws(()=>approveBaseline(candidate,'developer'),/explicit approver/);
  assert.throws(()=>approveBaseline(candidate,'developer',{acceptPartial:true}),/partial-review-required/);
  assert.throws(()=>createPartialReview(candidate,'auditor','free text with a private path'),/controlled source limitation/);
  const review=createPartialReview(candidate,'auditor','source-geometry');
  assert.throws(()=>approveBaseline(candidate,'developer',{acceptPartial:true,partialReview:{...review,partialReason:'engineering-coverage'},firstPartial:true}),/partial-review-digest-mismatch/);
  assert.throws(()=>approveBaseline(candidate,'auditor',{acceptPartial:true,partialReview:review,firstPartial:true}),/distinct source reviewer/);
  assert.throws(()=>approveBaseline(candidate,'developer',{acceptPartial:true,partialReview:review}),/first-partial review or a previous approved baseline/);
  assert.throws(()=>approveBaseline({...candidate,selectionFrozen:false},'developer',{acceptPartial:true,partialReview:review,firstPartial:true}));
  const approved=approveBaseline(candidate,'developer',{acceptPartial:true,partialReview:review,firstPartial:true});
  assert.equal(approved.approval.partialAccepted,true);
  assert.equal(baselineApprovalIssue(approved),null);
  assert.equal(baselineApprovalIssue({...approved,approval:{...approved.approval,partialReason:'changed'}}),
    'baseline-approval-metadata-mismatch');
  const previous=approveBaseline({outcome:'PASS',selectionFrozen:true,runs:b},'developer');
  assert.ok(approveBaseline(candidate,'developer',{acceptPartial:true,partialReview:review,
    previousBaseline:approved}).approval.previousBaselineDigest);
  assert.throws(()=>approveBaseline(candidate,'developer',{acceptPartial:true,partialReview:review,
    previousBaseline:previous}),/differs from the previous approved baseline/);
  assert.equal(baselineApprovalIssue({...approved,approval:{...approved.approval,partialAccepted:false}}),'baseline-approval-metadata-mismatch');
  assert.equal(baselineApprovalIssue({...approved,outcome:'PASS'}),'baseline-approval-digest-mismatch');
});
test('warm cache proof is domain-specific and misses cannot masquerade as a warm run',()=>{
  const evidence={cache:{sourceMatches:true,semanticValid:true,entries:10,ifcFarHits:2,cachedIfc:2,missingIfc:0,parserMatches:true,
    linePack:'valid',linePackAssessment:'valid',linePersistence:'saved',projectTypeCommitted:true},progress:{cacheSettled:true,
    workload:{devSources:3,ifcSources:2},cache:{engineering:'hit',devCatalogHits:3,devLodMisses:[0,280,0],writeFailures:0,readFailures:0}}};
  assert.equal(cacheVerified(evidence,'warm','substation'),true);evidence.cache.ifcFarHits=0;assert.equal(cacheVerified(evidence,'warm','substation'),true);
  evidence.cache.cachedIfc=1;assert.equal(cacheVerified(evidence,'warm','substation'),false);evidence.cache.cachedIfc=2;
  evidence.progress.workload.ifcSources=0;evidence.progress.cache.engineering='none';assert.equal(cacheVerified(evidence,'warm','equipment'),true);
  evidence.cache.linePackAssessment='uncommitted';assert.equal(cacheVerified(evidence,'warm','transmission_line'),false);
  evidence.cache.linePackAssessment='valid';evidence.cache.linePersistence='saving';assert.equal(cacheVerified(evidence,'cold','transmission_line'),false);
  evidence.cache.linePersistence='saved';evidence.progress.workload.ifcSources=2;evidence.progress.cache.engineering='partial';
  evidence.engineeringCoverage={complete:false};
  assert.equal(cacheVerified(evidence,'cold','substation'),true);
  evidence.progress.cache.devCatalogHits=3;assert.equal(cacheVerified(evidence,'warm','substation'),true);
  evidence.cache.semanticValid=false;assert.equal(cacheVerified(evidence,'warm','substation'),false);
  assert.throws(()=>verifyProfile({frozen:true,digest:'edited'}),/digest mismatch/);
  const run={conditions:{sourceSha256:'sha'},evidence:{semanticDigest:'semantic',baseArtifactDigest:'a',progress:{workload:{shown:1}}},actionTargetDigests:[]};
  assert.equal(coldWarmEquivalent(run,{...run,evidence:{...run.evidence,baseArtifactDigest:'b'}}).outcome,'FAIL');
  const pending={...run,evidence:{...run.evidence,pendingCount:1,pendingSourceCount:2,pendingDigest:'a'}};
  assert.equal(coldWarmEquivalent(pending,{...pending,evidence:{...pending.evidence,pendingDigest:'b'}}).outcome,'FAIL');
});
test('warm catalog excludes only proven failed sources and rejects other misses',()=>{
  const evidence={progress:{workload:{devSources:3},cache:{devCatalogHits:2}},
    catalogCacheEvidence:{available:true,accounted:true,missCount:1,sourceFailureMissCount:1,unexplainedMissCount:0},
    geometryDefects:{sourceEvidenceComplete:true,failedSourceSetDigest:'a'.repeat(64),failedReasons:{'missing-dependency':1}}};
  assert.deepEqual(warmCatalogCoverage(evidence),{valid:true,sourceFailureMisses:1});
  evidence.catalogCacheEvidence.unexplainedMissCount=1;
  assert.equal(warmCatalogCoverage(evidence).valid,false);
});
test('completion waits for background and line publication, then uses the actual finish moment',()=>{
  const observation={projectType:'transmission_line',openElapsedMs:2300,moments:{lineCachePersistenceReady:2100},
    progress:{automaticSettled:true,cacheSettled:false,backgroundSettled:true,cache:{linePersistence:'saving'}},
    measurement:{activeTasks:[]}};
  assert.equal(readyForSettle(observation),false);
  observation.progress.cacheSettled=true;assert.equal(readyForSettle(observation),true);
  assert.equal(cachePublicationMoment(observation),2100);
  observation.progress.backgroundSettled=false;assert.equal(readyForSettle(observation),false);
  observation.progress.backgroundSettled=true;observation.measurement.activeTasks=[{taskId:'spatial'}];assert.equal(readyForSettle(observation),false);
  observation.measurement.activeTasks=[];observation.progress.cache.linePersistence='failed';assert.equal(cachePublicationMoment(observation),null);
  const substation={...observation,projectType:'substation',progress:{...observation.progress,cache:{linePersistence:'idle'}},
    cachePersistence:{observed:false,available:true}};
  assert.equal(readyForSettle(substation,{cacheState:'cold'}),false);
  substation.cachePersistence.observed=true;assert.equal(readyForSettle(substation,{cacheState:'cold'}),true);
  const warm={...substation,cachePersistence:{observed:false,available:true}};
  assert.equal(readyForSettle(warm,{cacheState:'warm'}),true);
  assert.equal(cachePublicationMoment(warm),null);
  substation.cachePersistence.available=false;assert.equal(cachePublicationMoment(substation),null);
});
test('selection is deterministic, mandatory regression survives and no timing is consulted',()=>{
  const s=(id,tier,group,extra={})=>({sampleId:id,sourceSha256:id,bytes:100,container:{payload:'7z',magic:'GIMPKGS'},memberships:[{sampleTier:tier,group}],inventory:{status:'available',files:10,extensions:{cbm:1,dev:1,mod:1}},...extra});
  const registry={samples:[s('a','L1','development-regression',{workloadProfile:'full-package-index',timing:999}),s('b','L0','common-model',{timing:1}),s('c','L2','complex-equipment')]};
  const first=selectSamples(registry);registry.samples.reverse();assert.deepEqual(selectSamples(registry),first);assert.equal(first.profiles['commit-gate'][0].sampleId,'a');assert.equal(first.frozen,false);
});
test('geometry profile uses registered feature selection rather than a fixed sample identity',()=>{
  const sample={sampleId:'any-dev-source',sourceSha256:'a'.repeat(64),memberships:[],
    inventory:{status:'available',files:10}};
  const selection={profiles:{geometry:[{sampleId:sample.sampleId,sourceSha256:sample.sourceSha256}]}};
  const profile=freezeProfile({samples:[sample]},selection,'geometry');
  assert.equal(profile.cases[0].sampleId,sample.sampleId);
  assert.equal(profile.cases[0].actions[0].kind,'dev-fine');
});
test('CDP timeouts do not enqueue another heap request until the old response arrives',async()=>{
  const original=globalThis.WebSocket;let socket;
  class FakeSocket extends EventTarget {
    sent=[];
    constructor(){super();socket=this;queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
    send(text){this.sent.push(JSON.parse(text));}
    reply(id,result={}){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id,result})}));}
    close(){this.dispatchEvent(new Event('close'));}
  }
  globalThis.WebSocket=FakeSocket;let cdp;
  try{
    cdp=await CdpConnection.connect('ws://127.0.0.1:12345/owned',12345);
    await assert.rejects(cdp.send('Runtime.getHeapUsage',{},'worker',5),/timeout/);
    await assert.rejects(cdp.send('Runtime.getHeapUsage',{},'worker',5),/outstanding/);assert.equal(socket.sent.length,1);
    socket.reply(socket.sent[0].id,{usedSize:12});
    const next=cdp.send('Runtime.getHeapUsage',{},'worker');socket.reply(socket.sent[1].id,{usedSize:24});assert.equal((await next).usedSize,24);
    const pending=cdp.send('Runtime.getIsolateId',{},'worker');cdp.close();await assert.rejects(pending,/closed/);
  }finally{cdp?.close();globalThis.WebSocket=original;}
});
test('portable runtime preparation includes image integrity and restricts recursive operations to owned files',()=>{
  const workspace=resolve('..'),base=join(workspace,'tmp','runtime-security-unit');mkdirSync(base,{recursive:true});
  const root=mkdtempSync(join(base,'run-')),runtime=join(root,'webview2-fixed-runtime');mkdirSync(runtime);writeFileSync(join(runtime,'msedgewebview2.exe'),'unit-protocol-only');writeFileSync(join(root,'GIM-Reader.exe'),'unit-protocol-only');
  const calls=[];prepareFixedRuntimeSecurity(workspace,runtime,(_exe,args)=>{calls.push(args);return {status:0};});
  if(process.platform==='win32'){
    assert.ok(calls.some(args=>args[1]==='/setintegritylevel'&&args[2]==='(OI)(CI)M'));
    assert.ok(calls.some(args=>args[0]===join(root,'GIM-Reader.exe')&&args[2]==='M'));
    assert.throws(()=>prepareFixedRuntimeSecurity(workspace,runtime,()=>({status:1})),/preparation failed/);
  }
  assert.throws(()=>prepareFixedRuntimeSecurity(runtime,root,()=>({status:0})),/outside/);
});
