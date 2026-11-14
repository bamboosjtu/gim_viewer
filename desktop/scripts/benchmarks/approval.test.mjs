import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {benchmarkRun,acceptanceReports} from './test-fixtures.mjs';
import {runMatrix} from './matrix.mjs';
import {executeBatch} from './batch.mjs';
import {digest,approveBaseline,baselineApprovalIssue,compareSuites} from './compare.mjs';
import {bindMeasurementAcceptance,measurementAcceptanceIssue} from './measurement-acceptance.mjs';
import {createGeometryReview,geometryTransition,geometryReviewIssue} from './geometry-review.mjs';
import {assessCorrectness} from './correctness.mjs';
import {lifecycleExercise,lifecycleEvidenceEquivalent} from './lifecycle.mjs';
import {freezeProfile} from './profiles.mjs';
import {resolveOverheadPlan} from './overhead.mjs';

function setup(t){
  const parent=resolve('..','tmp','approval-protocol-tests');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'case-')),created=[];
  const save=(name,value)=>{const path=join(root,name);writeFileSync(path,JSON.stringify(value));return path;};
  const cli=(args,status=0)=>{const child=spawnSync(process.execPath,['scripts/benchmarks/cli.mjs',...args],{encoding:'utf8',windowsHide:true});
    assert.equal(child.status,status,child.stderr||child.stdout);return child;};
  // Only remove individual private approval records created by this test.
  t.after(()=>{for(const path of created)rmSync(path);});
  const record=args=>{const child=cli(args),path=child.stdout.trim().split(/\r?\n/).at(-1);
    assert.equal(resolve(path, '..'),resolve('..','tmp','gim-bench'));created.push(path);return path;};
  return {root,save,cli,record};
}
async function candidateFor(root,kind,evidence){
  const sample={inputId:'input-1',sampleId:'test-sample',sourceSha256:evidence?.sourceSha256??'2'.repeat(64),paths:[],actions:[]};let sequence=0;
  const execute=async({profileDigest,cacheState='cold'})=>({out:join(root,'private-run'),dataRoot:join(root,'cache'),
    report:benchmarkRun(`native-${++sequence}`,{conditions:{profileDigest,cacheState,sourceSha256:sample.sourceSha256},
      ...(evidence?{...assessCorrectness(evidence),evidence}:{})})});
  if(kind==='matrix'){
    const body={version:'gim-benchmark-profile-v1',frozen:true,repetitions:3,mode:'benchmark',requiredWorkerFamilies:[],
      cases:[{sampleId:sample.sampleId,sourceSha256:sample.sourceSha256,scenario:'open',actions:[],timeoutMs:1000}]};
    return (await runMatrix({root,buildManifest:'unused',registry:{samples:[sample]},profile:{...body,digest:digest(body)},execute})).result;
  }
  const build=join(root,'build.json');writeFileSync(build,JSON.stringify({sourceFingerprint:'7'.repeat(64)}));
  const out=join(root,'output','batch');mkdirSync(out,{recursive:true});
  return (await executeBatch({root,out,buildManifest:build,preset:'baseline',repetitions:3,execute,
    inputs:{entries:[{...sample,status:'READY'}],samples:[sample]}})).result;
}
function nextSuite(candidate,prefix,value){
  const {measurementAcceptance,approval,...body}=structuredClone(candidate);
  return {...body,runs:body.runs.map((run,index)=>({...run,runId:`${prefix}-${index}`,processInstanceId:`${prefix}-${index}`,
    metrics:{...run.metrics,firstResponseMs:value,automaticLoadMs:value,processPrivatePeakBytes:value}}))};
}
for(const kind of ['matrix','batch'])test(`${kind} native format completes acceptance -> approval -> gate entirely through CLI`,async t=>{
  const {root,save,cli,record}=setup(t),candidate=await candidateFor(root,kind);
  assert.equal(candidate.outcome,'PASS');
  const candidateFile=save('candidate.json',candidate);
  cli(['approve-baseline','--candidate',candidateFile,'--approver','developer'],1);
  const evidence=acceptanceReports(candidate),acceptedFile=record(['accept-measurement','--candidate',candidateFile,
    '--doctor',save('doctor.json',evidence.doctor),'--overhead',save('overhead.json',evidence.overhead),'--lifecycle',save('lifecycle.json',evidence.lifecycle)]);
  const accepted=JSON.parse(readFileSync(acceptedFile,'utf8'));
  assert.equal(measurementAcceptanceIssue(accepted),null);
  assert.deepEqual(JSON.parse(readFileSync(candidateFile,'utf8')),JSON.parse(JSON.stringify(candidate)));
  const baselineFile=record(['approve-baseline','--candidate',acceptedFile,'--approver','developer']);
  const baseline=JSON.parse(readFileSync(baselineFile,'utf8'));assert.equal(baselineApprovalIssue(baseline),null);
  const output=join(root,'output','comparison.json');
  const gate=(candidate,extra=[],status=0)=>{cli(['gate','--baseline',baselineFile,'--candidate',save('next.json',candidate),'--output',output,...extra],status);
    return JSON.parse(readFileSync(output,'utf8'));};
  assert.equal(gate(nextSuite(candidate,'next',105),[],2).outcome,'INCONCLUSIVE');
  assert.equal(gate(nextSuite(candidate,'slow',120),[],2).retestDecision,'developer');
  const retestArgs=['--retest-baseline',save('baseline-retest.json',nextSuite(candidate,'base-retest',100)),
    '--retest-candidate',save('candidate-retest.json',nextSuite(candidate,'next-retest',120))];
  assert.equal(gate(nextSuite(candidate,'slow',120),retestArgs,2).outcome,'INCONCLUSIVE');
});

function sourcePartialEvidence(combined=false){
  return {projectType:'substation',sourceSha256:'2'.repeat(64),passed:false,
    semanticDigest:'c'.repeat(64),placementDigest:'d'.repeat(64),baseGeometryDigest:'e'.repeat(64),baseArtifactDigest:'f'.repeat(64),
    pendingDigest:'0'.repeat(64),pendingCount:0,pendingSourceCount:0,
    checks:[{name:'source-identity',passed:true},{name:'no-failed-geometry-occurrences',passed:false}],
    progress:{workload:{ifcSources:0,shown:1,failed:1}},
    geometryDefects:{failedSourceCount:1,failedSourceSetDigest:'a'.repeat(64),failedOccurrences:1,failedVisibleRoots:0,
      failedReasons:{'source-invalid':1},sourceEvidenceComplete:true},
    engineeringCoverage:combined?{complete:false,incompleteReasons:['source-reference-unresolved'],
      referenceStatuses:{resolved:1,missing:1},graphDiagnostics:0,sourceCount:2,entityCount:1,pendingEntityCount:1}:{complete:true}};
}
async function exerciseLifecycle(root,evidence,mutate=()=>{},secondEvidence=null){
  const sample={sampleId:'test-sample',sourceSha256:evidence.sourceSha256};
  const secondSample=secondEvidence?{sampleId:'second-sample',sourceSha256:secondEvidence.sourceSha256}:undefined;
  let generation=1,current=sample,settled=true,reads=0;
  const cdp={async evaluate(expression){
    if(expression==='globalThis.__gimBenchmark.evidence()'){
      const actual=structuredClone(current===secondSample?secondEvidence:evidence);mutate(actual,++reads);return actual;
    }
    if(expression==='globalThis.__gimBenchmark.snapshot()')return {opening:false,session:{generation,sourceSha256:current.sourceSha256},
      progress:{automaticSettled:settled,cacheSettled:true,backgroundSettled:true},measurement:{activeTasks:[]}};
    if(expression==='globalThis.__gimBenchmark.resources()')return {workers:0,models:0};
    if(expression==='globalThis.__gimBenchmark.close()')return;
    const prefix='globalThis.__gimBenchmark.open(...';
    assert.ok(expression.startsWith(prefix),expression);
    const [sampleId,,config]=JSON.parse(expression.slice(prefix.length,expression.indexOf(').catch')));
    current=sampleId===sample.sampleId?sample:secondSample;generation++;
    settled=!config.runId.endsWith('-cancel')&&!config.runId.endsWith('-replace-a');
  }};
  return lifecycleExercise({sample,secondSample,wait:async()=>{}})({cdp,evidence,out:root,manifest:{nonce:'test'},
    build:{sourceFingerprint:'7'.repeat(64)},runId:'lifecycle',
    processSampler:{checkpoint:async()=>({availability:'available',bytes:1000})}});
}

for(const combined of [false,true])test(`${combined?'combined':'source-geometry'} PARTIAL completes actual lifecycle -> acceptance -> review -> approval`,async t=>{
  const {root,save,record}=setup(t),evidence={...sourcePartialEvidence(combined),sourceSha256:digest(root)};
  const candidate=await candidateFor(root,'matrix',evidence);
  assert.equal(candidate.outcome,'PARTIAL');assert.equal(candidate.runs[0].defectAssessment.kind,combined?'combined':'source-geometry');
  const exercise=await exerciseLifecycle(root,evidence);
  assert.equal(evidence.passed,false);assert.equal(exercise.outcome,'PASS');assert.equal(exercise.cycles.length,10);
  assert.ok(exercise.cycles.every(row=>row.correctness==='partial'&&row.equivalent));
  const reports=acceptanceReports(candidate);reports.lifecycle.exercise=exercise;
  const acceptedFile=record(['accept-measurement','--candidate',save('partial-candidate.json',candidate),
    '--doctor',save('doctor.json',reports.doctor),'--overhead',save('overhead.json',reports.overhead),
    '--lifecycle',save('lifecycle.json',reports.lifecycle)]);
  const reviewFile=record(['review-partial','--candidate',acceptedFile,'--reviewer','source-auditor',
    '--reason',combined?'combined-source':'source-geometry']);
  const baselineFile=record(['approve-baseline','--candidate',acceptedFile,'--approver','developer',
    '--accept-partial','--partial-review',reviewFile,'--first-partial']);
  const baseline=JSON.parse(readFileSync(baselineFile,'utf8'));
  assert.equal(baseline.outcome,'PARTIAL');assert.equal(baselineApprovalIssue(baseline),null);
});

test('lifecycle permits stable PARTIAL replacement but rejects changing defects and product failures',async t=>{
  const {root}=setup(t),evidence=sourcePartialEvidence(),second={...sourcePartialEvidence(true),sourceSha256:'9'.repeat(64)};
  const replaced=await exerciseLifecycle(root,evidence,()=>{},second);
  assert.equal(replaced.outcome,'PASS');assert.equal(replaced.replacement.correctness,'partial');
  for(const change of [
    row=>{row.geometryDefects.failedSourceSetDigest='b'.repeat(64);},
    row=>{row.geometryDefects.failedOccurrences=2;},
    row=>{row.geometryDefects.sourceEvidenceComplete=false;},
    row=>{row.geometryDefects.failedReasons={'parse-failed':1};},
    row=>{row.checks.push({name:'session-stable',passed:false});},
    row=>{row.sourceSha256='9'.repeat(64);},
    row=>{row.semanticDigest='9'.repeat(64);},
  ]){
    const actual=structuredClone(evidence);change(actual);assert.equal(lifecycleEvidenceEquivalent(evidence,actual),false);
    const result=await exerciseLifecycle(root,evidence,(row,cycle)=>{if(cycle===5)change(row);});
    assert.equal(result.cycles[4].equivalent,false);assert.equal(result.outcome,'FAIL');
  }
});

test('acceptance cannot waive a changed or missing PARTIAL lifecycle reference',async t=>{
  const {root}=setup(t),candidate=await candidateFor(root,'matrix',sourcePartialEvidence());
  for(const change of [
    reports=>{delete reports.lifecycle.exercise.reference;},
    reports=>{reports.lifecycle.exercise.reference.defectAssessment.sourceSetDigest='b'.repeat(64);},
    reports=>{reports.lifecycle.exercise.cycles[4].correctness='failed';},
    reports=>{reports.lifecycle.correctness='failed';},
  ]){
    const reports=structuredClone(acceptanceReports(candidate));change(reports);
    assert.throws(()=>bindMeasurementAcceptance(candidate,reports),/Lifecycle correctness or partial coverage/);
  }
});

test('matrix overhead requires its matching Profile and preserves geometry/full-package actions and timeout',()=>{
  for(const name of ['geometry','commit-gate']){
    const sample={sampleId:'test-sample',sourceSha256:'2'.repeat(64),workloadProfile:'full-package-index',
      inventory:{status:'available',files:name==='geometry'?1:50001}};
    const profile=freezeProfile({samples:[sample]},{profiles:{[name]:[sample]}},name);
    const candidate={version:'gim-benchmark-candidate-v1',profileDigest:profile.digest,
      runs:[benchmarkRun('matrix',{conditions:{profileDigest:profile.digest,scenario:profile.cases[0].scenario}})]};
    assert.equal(sample.actions,undefined);
    assert.throws(()=>resolveOverheadPlan({candidate,sample}),/--profile is required/);
    const plan=resolveOverheadPlan({candidate,profile,sample});
    assert.equal(plan.profile.digest,candidate.profileDigest);assert.deepEqual(plan.caseSpec,profile.cases[0]);
    assert.equal(plan.caseSpec.actions.length,name==='geometry'?1:3);assert.equal(plan.caseSpec.timeoutMs,name==='geometry'?900000:3600000);
    assert.deepEqual(resolveOverheadPlan({profile,sample}).caseSpec,profile.cases[0]);
    const other=freezeProfile({samples:[sample]},{profiles:{[name]:[sample]}},name);
    other.cases[0].timeoutMs++;const {digest:oldDigest,...body}=other;other.digest=digest(body);
    assert.throws(()=>resolveOverheadPlan({candidate,profile:other,sample}),/does not match candidate/);
    assert.throws(()=>resolveOverheadPlan({candidate,profile,sample:{...sample,sourceSha256:'9'.repeat(64)}}),/must belong/);
  }
  const sample={sampleId:'test-sample',sourceSha256:'2'.repeat(64),actions:[{kind:'dev-fine',selector:'canonical-first-base-v1'}]};
  const run=benchmarkRun('batch',{conditions:{scenario:'open-and-fidelity'}});
  const plan=resolveOverheadPlan({candidate:{version:'gim-batch-results-v1',profileDigest:run.conditions.profileDigest,runs:[run]},sample});
  assert.deepEqual(plan.caseSpec.actions,sample.actions);assert.equal(plan.caseSpec.scenario,'open-and-fidelity');
});

test('overhead CLI accepts candidate plus Profile and rejects missing or mismatched matrix Profile before launch',t=>{
  const {save,cli}=setup(t),sample={sampleId:'test-sample',sourceSha256:'2'.repeat(64),inventory:{status:'available',files:1}};
  const profile=freezeProfile({samples:[sample]},{profiles:{geometry:[sample]}},'geometry');
  const candidateFile=save('matrix.json',{version:'gim-benchmark-candidate-v1',profileDigest:profile.digest,runs:[]});
  // An unavailable path exercises argument handling without a GIM fixture or native launch.
  const registry=save('registry.json',{samples:[{path:'unavailable.gim'}]}),build=save('build.json',{});
  const args=['overhead','--build',build,'--candidate',candidateFile,'--sample',sample.sampleId,'--registry',registry];
  assert.match(cli(args,1).stderr,/--profile is required with a matrix candidate/);
  const {digest:stored,...body}=profile;
  const other={...body,name:'another-profile'};other.digest=digest(other);
  assert.match(cli([...args,'--profile',save('different-profile.json',other)],1).stderr,/Frozen profile does not match candidate/);
});

test('acceptance rejects stale builds, environments, missing/failed probes and candidate tampering',async t=>{
  const {root}=setup(t),candidate=await candidateFor(root,'matrix');
  const mutate=[
    e=>{e.doctor.buildFingerprint='8'.repeat(64);},
    e=>{e.lifecycle.conditions.machineId='another-machine';},
    e=>{e.doctor.capabilityOutcome='INCONCLUSIVE';},
    e=>{e.doctor.measurement.detailComplete=false;},
    e=>{e.overhead.runs[0].correctness='failed';},
    e=>{delete e.overhead.runs[0].metrics.processPrivatePeakBytes;},
    e=>{e.overhead.profileDigest='wrong-profile';},
    e=>{e.overhead.runs[0].conditions.sourceSha256='9'.repeat(64);},
    e=>{e.lifecycle.exercise.cycles.pop();},
    e=>{e.lifecycle.exercise.cycles[2].resources.workers=1;},
    e=>{for(const row of e.lifecycle.exercise.cycles.slice(-3))row.memory.bytes=3000;e.lifecycle.exercise.retainedGrowth=0;},
    e=>{e.lifecycle.exercise.cancellation.passed=false;},
    e=>{e.doctor.processInstanceId=candidate.runs[0].processInstanceId;},
  ];
  for(const change of mutate){const evidence=acceptanceReports(candidate);change(evidence);
    assert.throws(()=>bindMeasurementAcceptance(candidate,evidence),change.toString());}
  assert.throws(()=>approveBaseline({...candidate,measurementAcceptance:{outcome:'PASS'}},'developer'),/measurement-acceptance-digest-mismatch/);
  const accepted=bindMeasurementAcceptance(candidate,acceptanceReports(candidate));
  accepted.runs[0].metrics.automaticLoadMs++;
  assert.equal(measurementAcceptanceIssue(accepted),'measurement-acceptance-candidate-mismatch');
  assert.throws(()=>approveBaseline(accepted,'developer'),/candidate-mismatch/);
});

test('bare PASS flags cannot substitute for native acceptance evidence',()=>{
  // Deliberately independent of the shared fixture builder.
  const candidate={outcome:'PASS',selectionFrozen:true,runs:[{version:'gim-benchmark-v1'}]};
  assert.throws(()=>bindMeasurementAcceptance(candidate,{
    doctor:{capabilityOutcome:'PASS'},overhead:{outcome:'PASS'},lifecycle:{exercise:{outcome:'PASS'}},
  }));
});

test('matching unknown measurement versions cannot pass comparison or acceptance',async t=>{
  const {root}=setup(t),candidate=await candidateFor(root,'matrix');
  const unknown=structuredClone(candidate);
  for(const run of unknown.runs)run.conditions.measurementVersion='unknown-measurement-version';
  assert.equal(compareSuites(unknown.runs,unknown.runs).outcome,'INCONCLUSIVE');
  assert.throws(()=>bindMeasurementAcceptance(unknown,acceptanceReports(unknown)),/Unsupported measurement version/);
});

test('probe overhead acceptance preserves a full independent retest and rejects process reuse',async t=>{
  const {root}=setup(t),candidate=await candidateFor(root,'matrix'),evidence=acceptanceReports(candidate);
  const retest=structuredClone(evidence.overhead);
  retest.runs.forEach((run,index)=>{run.processInstanceId=`retest-${index}`;run.runId=run.processInstanceId;});
  for(const run of evidence.overhead.runs)if(run.conditions.mode==='benchmark')run.metrics.automaticLoadMs=120;
  evidence.overhead.retest=retest;
  assert.equal(measurementAcceptanceIssue(bindMeasurementAcceptance(candidate,evidence)),null);
  evidence.overhead.retest.runs[0].processInstanceId=evidence.overhead.runs[0].processInstanceId;
  assert.throws(()=>bindMeasurementAcceptance(candidate,evidence),/reused a process/);
});

test('content changes require independent geometry evidence and explicit CLI approval',async t=>{
  const {root,save,cli,record}=setup(t),candidate=await candidateFor(root,'matrix');
  const baseline=approveBaseline(bindMeasurementAcceptance(candidate,acceptanceReports(candidate)),'developer');
  const next=nextSuite(candidate,'geometry-next',95);
  for(const run of next.runs){run.contentEvidence.digest='8'.repeat(64);run.buildFingerprint='9'.repeat(64);}
  const baselineFile=save('baseline.json',baseline),candidateFile=save('next.json',next),output=join(root,'output','comparison.json');
  const gate=(extra=[],status=0)=>{cli(['gate','--baseline',baselineFile,'--candidate',candidateFile,'--output',output,...extra],status);
    return JSON.parse(readFileSync(output,'utf8'));};
  assert.equal(gate([],2).outcome,'INCONCLUSIVE');
  const changes=['cold','warm'].map(cache=>geometryTransition(baseline.runs.find(run=>run.conditions.cacheState===cache),next.runs.find(run=>run.conditions.cacheState===cache)));
  const verification={version:'gim-geometry-equivalence-v1',outcome:'PASS',verifier:'mesh-auditor',
    method:'independent-mesh-equivalence-v1',baselineDigest:digest(baseline),candidateDigest:digest(next),
    checks:changes.map(change=>({transitionDigest:digest(change),coveredOccurrences:1,evidenceSha256:'0'.repeat(64),
      positions:true,topology:true,normals:true,materials:true,transforms:true,sourceBindings:true}))};
  const reviewFile=record(['approve-geometry-change','--baseline',baselineFile,'--candidate',candidateFile,
    '--verification',save('verification.json',verification),'--approver','developer']);
  const review=JSON.parse(readFileSync(reviewFile,'utf8'));
  assert.equal(geometryReviewIssue(review,baseline,next),null);
  assert.equal(gate(['--geometry-review',reviewFile]).outcome,'PASS');
  for(const change of [v=>{v.checks.pop();},v=>{v.checks[0].topology=false;},v=>{v.verifier='developer';},
    v=>{v.method='bounding-box-only';},v=>{v.candidateDigest='0'.repeat(64);}]){
    const invalid=structuredClone(verification);change(invalid);
    assert.throws(()=>createGeometryReview(baseline,next,invalid,'developer'));
  }
  const changed=structuredClone(next);changed.runs[0].contentEvidence.placementFingerprint='1'.repeat(64);
  assert.ok(geometryReviewIssue(review,baseline,changed));
  const different=structuredClone(review);different.changes[0].candidate.digest='a'.repeat(64);
  assert.equal(geometryReviewIssue(different,baseline,next),'geometry-review-digest-mismatch');
  // The waiver covers bytes only; workload, memory and timing checks still run.
  const slower=nextSuite(next,'slow-geometry',120);
  assert.equal(compareSuites(baseline.runs,slower.runs,{requireContentEvidence:true,geometryChanges:review.changes}).retestDecision,'developer');
  assert.equal(compareSuites(baseline.runs,slower.runs,{requireContentEvidence:true,geometryChanges:review.changes,
    retestBaseline:nextSuite(candidate,'geometry-base-retest',100).runs,retestCandidate:nextSuite(next,'geometry-retest',120).runs}).outcome,'INCONCLUSIVE');
});

test('technical acceptance re-evaluates retention under the new cap but leaves benefit and approval pending',async t=>{
  const {root}=setup(t),candidate=await candidateFor(root,'matrix'),evidence=acceptanceReports(candidate);
  evidence.lifecycle.exercise.outcome='FAIL';
  evidence.lifecycle.exercise.cycles.slice(-3).forEach(row=>row.memory.bytes=1300);
  evidence.lifecycle.exercise.retainedGrowth=0.3;
  evidence.overhead.outcome='FAIL';
  evidence.overhead.runs.filter(r=>r.conditions.mode==='benchmark').forEach(r=>r.metrics.automaticLoadMs=200);
  const accepted=bindMeasurementAcceptance(candidate,evidence);
  assert.equal(accepted.measurementAcceptance.performanceAssessment.retention.evidenceComplete,true);
  assert.equal(accepted.measurementAcceptance.performanceAssessment.probe.requiresHumanReview,true);
  assert.equal(accepted.measurementAcceptance.performanceAssessment.approval,'PENDING');
  assert.equal(accepted.approval,undefined);assert.equal(evidence.lifecycle.exercise.outcome,'FAIL');
});
