// Protocol fixtures only: no GIM input and no claim of native performance acceptance.
import {MEASUREMENT_VERSION} from '../../../packages/measurement-core/src/version.mjs';
export function benchmarkRun(id,overrides={}){
  const conditions={machineId:'test-machine',runtimeSha256:'1'.repeat(64),buildMode:'release',
    measurementVersion:MEASUREMENT_VERSION,geometryTimingPolicy:'in-viewport-model-draw-submitted-v1',detailPolicy:'task-phase-timeline-v1',lifecyclePolicy:'worker-terminal-v1',
    contentPolicy:'dev-l0-glb-sha256-v1',cacheProofPolicy:'source-failure-catalog-v1',webviewProfilePolicy:'paired-webview-profile-v1',
    mode:'benchmark',scenario:'open',cacheState:'cold',sourceSha256:'2'.repeat(64),sampleId:'test-sample',
    profileDigest:'3'.repeat(64),workloadDigest:'4'.repeat(64),routeDigest:'5'.repeat(64),viewportDigest:'6'.repeat(64),
    environmentCalibration:{version:'gim-batch-calibration-v1',availability:'available',method:'test',checksum:1,cpuMs:10,writeSyncMs:10,readWarmMs:10}};
  const contentEvidence={scope:'DEV-L0-GLB-artifacts',method:'worker-output-or-validated-cache-sha256',
    availability:'available',coveredOccurrences:1,expectedShownOccurrences:1,missingArtifactSha:0,duplicateArtifactIds:0,
    digest:'a'.repeat(64),placementFingerprint:'b'.repeat(64),complete:true};
  const evidence={semanticDigest:'c'.repeat(64),placementDigest:'d'.repeat(64),baseGeometryDigest:'e'.repeat(64),baseArtifactDigest:'f'.repeat(64),
    pendingDigest:'0'.repeat(64),pendingCount:0,pendingSourceCount:0,progress:{workload:{shown:1,failed:0}}};
  return structuredClone({version:'gim-benchmark-v1',kind:'native-scene',runId:id,processInstanceId:id,buildFingerprint:'7'.repeat(64),
    projectType:'substation',correctness:'passed',cacheVerified:true,cachePublished:true,measurementComplete:true,
    measurementLifecycleComplete:true,memoryEvidenceComplete:true,semanticDigestScope:'engineering-with-pending-v1',
    semanticDigest:evidence.semanticDigest,pendingDigest:evidence.pendingDigest,pendingCount:0,pendingSourceCount:0,
    processSampling:{complete:true,samples:3,available:3},cleanupComplete:true,reason:null,crashed:false,
    measurement:{version:MEASUREMENT_VERSION,detailComplete:true,aggregateComplete:true,lifecycleComplete:true,activeTasks:[],workers:{}},
    requiredMetrics:['firstResponseMs','automaticLoadMs','processPrivatePeakBytes'],
    actionTargetDigests:[],...overrides,conditions:{...conditions,...overrides.conditions},
    metrics:{firstResponseMs:100,automaticLoadMs:100,processPrivatePeakBytes:100,...overrides.metrics},
    contentEvidence:{...contentEvidence,...overrides.contentEvidence},evidence:{...evidence,...overrides.evidence}});
}

export function acceptanceReports(candidate){
  const first=candidate.runs[0],base={conditions:first.conditions,buildFingerprint:first.buildFingerprint,
    correctness:first.correctness,defectAssessment:first.defectAssessment??null};
  const doctor=benchmarkRun('doctor',{...base,kind:'native-capability-probe',capabilityOutcome:'PASS',
    capabilityResult:{moduleExecutions:1,roundTripValue:18},workerMemory:[{family:'measurement-probe',samples:2}]});
  const runs=Array.from({length:6},(_,index)=>benchmarkRun(`overhead-${index}`,{...base,
    conditions:{...base.conditions,cacheState:'cold',mode:['off','benchmark','benchmark','off','off','benchmark'][index]}}));
  const overhead={kind:'same-build-probe-overhead',outcome:first.correctness==='partial'?'PARTIAL':'PASS',profileDigest:candidate.profileDigest,
    independentProcesses:true,alternatingOrder:true,runs};
  const closed=()=>({resources:{workers:0,models:0},memory:{availability:'available',bytes:1000},passed:true});
  const lifecycle=benchmarkRun('lifecycle',{...base,exercise:{kind:'same-process-ten-open-close',outcome:'PASS',
    reference:{sourceSha256:first.conditions.sourceSha256,correctness:first.correctness,defectAssessment:first.defectAssessment??null},
    cycles:Array.from({length:10},(_,index)=>({cycle:index+1,equivalent:true,correctness:first.correctness,
      defectAssessment:first.defectAssessment??null,...closed()})),
    cancellation:closed(),replacement:null,retainedGrowth:0}});
  return {doctor,overhead,lifecycle};
}
