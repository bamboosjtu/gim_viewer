import {candidateDigest,digest,sha} from './evidence.mjs';
import {MEASUREMENT_VERSION} from '../../../packages/measurement-core/src/version.mjs';
import {performanceComparison,lifecycleRetention,PERFORMANCE_POLICY} from './performance-policy.mjs';
import {retainedMemory} from './statistics.mjs';

const identityKeys=['machineId','runtimeSha256','buildMode','measurementVersion','detailPolicy','lifecyclePolicy',
  'contentPolicy','cacheProofPolicy','webviewProfilePolicy'];
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const identity=run=>({...pick(run.conditions,identityKeys),buildFingerprint:run.buildFingerprint});
const same=(a,b)=>digest(a)===digest(b);
const check=(value,message)=>{if(!value)throw Error(message);};

// Keep the approval portable and anonymous: no raw events, paths, profiles or logs.
function compactRun(run){
  return {...pick(run,['version','kind','runId','processInstanceId','buildFingerprint','conditions','correctness','defectAssessment',
    'cacheVerified','measurementComplete','measurementLifecycleComplete','memoryEvidenceComplete','reason','crashed','recovery',
    'processSampling','metrics','capabilityOutcome','capabilityResult','cleanupComplete','workerMemory','exercise']),
    measurement:pick(run.measurement,['detailComplete','aggregateComplete','lifecycleComplete','activeTasks'])};
}
function compactOverhead(report){
  return {...pick(report,['kind','outcome','profileDigest','independentProcesses','alternatingOrder']),
    runs:(report.runs??[]).map(compactRun),...(report.retest?{retest:compactOverhead(report.retest)}:{})};
}
function commonRun(run,expected){
  check(run?.version==='gim-benchmark-v1'&&same(identity(run),expected),'Acceptance build or environment differs from candidate');
  check(!run.recovery&&!run.reason&&!run.crashed&&run.cleanupComplete===true&&run.processSampling?.complete===true,
    'Acceptance run is incomplete');
}
function checkOverhead(report,candidate,expected,allowRetest=true){
  check(report?.kind==='same-build-probe-overhead'&&['PASS','PARTIAL','INCONCLUSIVE','FAIL'].includes(report.outcome)&&
    report.independentProcesses===true&&report.alternatingOrder===true&&report.profileDigest===candidate.profileDigest,
  'Probe overhead evidence is incomplete or belongs to another profile');
  const runs=report.runs??[],off=runs.filter(run=>run.conditions?.mode==='off'),on=runs.filter(run=>run.conditions?.mode==='benchmark');
  check(off.length>=3&&off.length===on.length&&runs.length===off.length*2&&
    new Set(runs.map(run=>run.processInstanceId)).size===runs.length&&runs.every(run=>run.processInstanceId),
  'Probe overhead requires independent off/benchmark processes');
  const first=runs[0];
  check(candidate.runs.some(run=>['sourceSha256','sampleId','scenario','profileDigest','workloadDigest','routeDigest','viewportDigest']
    .every(key=>run.conditions?.[key]===first.conditions?.[key])&&run.correctness===first.correctness&&
    same(run.defectAssessment??null,first.defectAssessment??null)),'Probe overhead sample or coverage does not belong to candidate');
  for(const [index,run] of runs.entries()){
    commonRun(run,expected);
    const expectedMode=Math.floor(index/2)%2?['benchmark','off'][index%2]:['off','benchmark'][index%2];
    check(run.conditions.mode===expectedMode&&['passed','partial'].includes(run.correctness)&&run.correctness===first.correctness&&
      same(run.defectAssessment??null,first.defectAssessment??null)&&run.cacheVerified===true&&
      ['sourceSha256','sampleId','scenario','cacheState','profileDigest','workloadDigest','routeDigest','viewportDigest']
        .every(key=>run.conditions[key]!=null&&run.conditions[key]===first.conditions[key]),'Probe overhead workload or coverage differs');
    check(run.conditions.mode==='off'||run.measurementComplete===true&&run.measurementLifecycleComplete===true&&
      run.memoryEvidenceComplete===true,'Probe overhead measurement is incomplete');
  }
  const metrics=['firstResponseMs','automaticLoadMs','processPrivatePeakBytes'];
  check(runs.every(run=>metrics.every(key=>Number.isFinite(run.metrics?.[key])&&run.metrics[key]>0)),
    'Probe overhead metrics are missing');
  if(report.retest){
    check(allowRetest,'Nested probe overhead retests are not allowed');
    checkOverhead(report.retest,candidate,expected,false);
    check(['sourceSha256','sampleId','scenario','cacheState','profileDigest','workloadDigest','routeDigest','viewportDigest']
      .every(key=>report.retest.runs[0].conditions[key]===first.conditions[key]),'Probe overhead retest changed the sample or workload');
    check(new Set([...runs,...report.retest.runs].map(run=>run.processInstanceId)).size===runs.length+report.retest.runs.length,
      'Probe overhead retest reused a process');
  }
  return performanceComparison(off,on);
}
function closed(row){
  return row?.passed===true&&row.memory?.availability==='available'&&Number.isFinite(row.memory.bytes)&&row.memory.bytes>0&&
    row.resources&&Object.keys(row.resources).length>0&&Object.values(row.resources).every(value=>value===0);
}
function validate(candidate,evidence){
  check(['PASS','PARTIAL'].includes(candidate.outcome)&&candidate.selectionFrozen===true&&candidate.runs?.length&&
    candidate.runs.every(run=>run.version==='gim-benchmark-v1'&&!run.recovery),
    'Frozen native benchmark candidate required');
  const expected=identity(candidate.runs[0]);
  check(expected.measurementVersion===MEASUREMENT_VERSION,'Unsupported measurement version');
  check(sha(candidate.profileDigest)&&candidate.runs.every(run=>run.conditions?.profileDigest===candidate.profileDigest),
    'Candidate profile identity is incomplete');
  check(identityKeys.every(key=>expected[key]!=null)&&sha(expected.buildFingerprint), 'Candidate build identity is incomplete');
  check(candidate.runs.every(run=>same(identity(run),expected)), 'Candidate mixes builds or environments');
  const {doctor,overhead,lifecycle}=evidence;
  commonRun(doctor,expected);
  check(doctor.kind==='native-capability-probe'&&doctor.capabilityOutcome==='PASS'&&doctor.cleanupComplete===true&&
    doctor.capabilityResult?.moduleExecutions===1&&doctor.capabilityResult?.roundTripValue===18&&
    doctor.measurement?.detailComplete===true&&doctor.measurement?.aggregateComplete===true&&
    doctor.measurement?.lifecycleComplete===true&&doctor.measurement?.activeTasks?.length===0&&
    doctor.workerMemory?.some(worker=>worker.family==='measurement-probe'&&worker.samples>0),
  'Doctor capability evidence did not pass');
  const probePerformance=checkOverhead(overhead,candidate,expected);
  commonRun(lifecycle,expected);
  const exercise=lifecycle.exercise,cycles=exercise?.cycles??[];
  check(candidate.runs.some(run=>run.conditions.sourceSha256===lifecycle.conditions?.sourceSha256),
    'Lifecycle sample does not belong to candidate');
  const matchingRuns=candidate.runs.filter(run=>run.conditions.sourceSha256===lifecycle.conditions?.sourceSha256);
  const reference=exercise?.reference;
  if(reference||matchingRuns.some(run=>run.correctness==='partial')){
    check(reference?.sourceSha256===lifecycle.conditions.sourceSha256&&
      lifecycle.correctness===reference.correctness&&same(lifecycle.defectAssessment??null,reference.defectAssessment??null)&&
      matchingRuns.some(run=>run.correctness===reference.correctness&&same(run.defectAssessment??null,reference.defectAssessment??null))&&
      cycles.every(row=>row.correctness===reference.correctness&&same(row.defectAssessment??null,reference.defectAssessment??null)),
    'Lifecycle correctness or partial coverage differs from candidate');
  }
  check(lifecycle.kind==='native-scene'&&lifecycle.conditions.mode==='benchmark'&&
    exercise?.kind==='same-process-ten-open-close'&&cycles.length===10&&
    cycles.every((row,index)=>row.cycle===index+1&&row.equivalent===true&&closed(row))&&closed(exercise.cancellation)&&
    (!exercise.replacement||closed(exercise.replacement)&&exercise.replacement.sourceMatches===true&&exercise.replacement.evidencePassed===true),
  'Lifecycle evidence did not pass all ten cycles and cancellation');
  const {growth}=retainedMemory(cycles);
  check(lifecycleRetention(growth).withinLimit&&Math.abs(growth-exercise.retainedGrowth)<1e-9,
    'Lifecycle retained memory exceeds 50% or disagrees with evidence');
  const processes=[...candidate.runs,doctor,...overhead.runs,...(overhead.retest?.runs??[]),lifecycle].map(run=>run.processInstanceId);
  check(processes.every(Boolean)&&new Set(processes).size===processes.length,'Acceptance evidence reused a candidate or acceptance process');
  return {policyVersion:PERFORMANCE_POLICY.version,probe:probePerformance,retention:lifecycleRetention(growth),approval:'PENDING'};
}

export function bindMeasurementAcceptance(candidate,{doctor,overhead,lifecycle}){
  check(!candidate.approval&&!candidate.recovery,'Approved or recovered candidates cannot bind acceptance evidence');
  const evidence={doctor:compactRun(doctor),overhead:compactOverhead(overhead),lifecycle:compactRun(lifecycle)};
  const performanceAssessment=validate(candidate,evidence);
  const acceptance={version:'gim-measurement-acceptance-v1',outcome:'PASS',candidateDigest:candidateDigest(candidate),
    acceptedAt:new Date().toISOString(),scope:'measurement-evidence-only',performanceAssessment,evidence};
  const {approval,measurementAcceptance,...body}=candidate;
  return {...body,measurementAcceptance:{...acceptance,evidenceDigest:digest(acceptance)}};
}
export function measurementAcceptanceIssue(candidate){
  const acceptance=candidate.measurementAcceptance;
  if(!acceptance)return 'measurement-acceptance-required';
  const {evidenceDigest,...body}=acceptance;
  if(body.version!=='gim-measurement-acceptance-v1'||body.outcome!=='PASS'||digest(body)!==evidenceDigest)
    return 'measurement-acceptance-digest-mismatch';
  if(body.candidateDigest!==candidateDigest(candidate))return 'measurement-acceptance-candidate-mismatch';
  try{validate(candidate,body.evidence);}catch(error){return `measurement-acceptance-invalid:${error.message}`;}
  return null;
}
