import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,existsSync,unlinkSync,rmdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve,join,dirname,relative} from 'node:path';
import {artifactDirectory,loadBatchInputs} from './batch-input.mjs';
import {executeBatch,recoverInterruptedBatch} from './batch.mjs';
import {csv,summarize,writeBatchProgress,writeBatchReports} from './batch-report.mjs';
import {createPublicProjector,publicView} from './observability.mjs';
import {compareSuites,approveBaseline} from './compare.mjs';
import {spawnSync} from 'node:child_process';
import {isStartupInfrastructureFailure} from './startup-retry.mjs';
import {benchmarkRun} from './test-fixtures.mjs';
import {MEASUREMENT_VERSION} from '../../../packages/measurement-core/src/version.mjs';

const root=resolve('..');
function setup(){const parent=artifactDirectory(root,join(root,'tmp','batch-protocol-tests')),out=mkdtempSync(join(parent,'run-'));
  const buildManifest=join(out,'build.json');writeFileSync(buildManifest,JSON.stringify({sourceFingerprint:'protocol-test'}));return {root,out,buildManifest};}
function inputs(){return {entries:['a','b','c'].map((id,index)=>({inputId:id,sampleId:id,sourceSha256:id,privatePath:'private-name',status:'READY'})),
  samples:['a','b','c'].map(id=>({inputId:id,sampleId:id,sourceSha256:id,paths:[],actions:[]}))};}

test('HTML locates an incomplete heap by build, run, worker and observed delay without leaking private strings',()=>{
  const options=setup(),out=artifactDirectory(options.root,join(options.out,'output'));
  const state=publicView({version:'gim-batch-results-v1',anonymize:true,status:'COMPLETE',outcome:'PASS',preset:'baseline',repetitions:1,
    buildFingerprint:'a'.repeat(64),buildInfo:{commit:'c'.repeat(40),sourceFingerprint:'a'.repeat(64),dirty:false},
    rows:[{inputId:'input-1',sampleId:'sample-1',runId:'private-run',status:'PASS',cacheState:'cold',memoryEvidenceComplete:false,
      memoryIncompleteItems:'worker-heap:worker-heap-sampling-gap:private-worker'}],
    stages:[],workers:[{runId:'private-run',workerId:'private-worker',family:'dev',heapAvailability:'unavailable',maxSampleGapMs:2158.7,maxSampleDelayMs:1076.2,failedHeapSamples:0}]});
  writeBatchReports(out,state,{root:options.root});
  const html=readFileSync(join(out,'report.html'),'utf8');
  assert.match(html,/cccccccc/);assert.match(html,/aaaaaaaaaaaa/);assert.match(html,/堆采样覆盖间隔超限/);
  assert.match(html,/2158.7 ms/);assert.match(html,/1076.2 ms/);assert.match(html,/运行标识/);
  assert.doesNotMatch(html,/unverified-reason-omitted|private-worker|private-run/);
});
function run(sample,profileDigest){return {out:'private-run',dataRoot:'private-cache',report:benchmarkRun(sample.inputId,{version:undefined,
  conditions:{machineId:'m',runtimeSha256:'r',buildMode:'release',measurementVersion:MEASUREMENT_VERSION,detailPolicy:'task-phase-timeline-v2',lifecyclePolicy:'worker-terminal-v2',contentPolicy:'dev-l0-glb-sha256-v1',cacheProofPolicy:'source-failure-catalog-v1',webviewProfilePolicy:'paired-webview-profile-v1',mode:'benchmark',scenario:'open',cacheState:'cold',sourceSha256:sample.sourceSha256,sampleId:sample.sampleId,
    profileDigest,workloadDigest:'w',routeDigest:'r',viewportDigest:'v'},correctness:'passed',cacheVerified:true,cachePublished:true,measurementComplete:true,requiredMetrics:['firstResponseMs'],metrics:{firstResponseMs:12},
  evidence:{progress:{workload:{failed:0}}}})};}

test('batch continues after execution exceptions and exports every result and failure',async()=>{
  const options=setup(),called=[];
  const result=await executeBatch({...options,inputs:inputs(),execute:async({sample,profileDigest})=>{
    called.push(sample.inputId);if(sample.inputId==='b')throw Error('secret project name / user path');
    const value=run(sample,profileDigest);value.report.finalEvidenceStability={attempts:2,driftCount:1,recovered:true};return value;
  }});
  assert.deepEqual(called,['a','b','c']);assert.equal(result.result.outcome,'FAIL');
  assert.deepEqual(result.result.rows.map(row=>row.status),['PASS','ERROR','PASS']);
  assert.equal(result.result.rows[0].finalEvidenceAttempts,2);assert.equal(result.result.rows[0].finalEvidenceDrifts,1);
  const json=readFileSync(join(options.out,'results.json'),'utf8');assert.ok(!json.includes('secret'));assert.ok(!json.includes('private-name'));
  for(const name of ['results.csv','errors.csv','summary.csv','stages.csv','slow-tasks.csv','slow-phases.csv','workers.csv','report.html'])assert.ok(readFileSync(join(options.out,name),'utf8').length>0);
  const html=readFileSync(join(options.out,'report.html'),'utf8');
  assert.match(html,/id="tab-results"[^>]*role="tab"/);
  assert.match(html,/id="tab-coverage"[^>]*role="tab"/);
  assert.match(html,/id="panel-coverage"[^>]*hidden/);
  assert.match(html,/id="panel-results"[^>]*role="tabpanel"/);
});
test('frozen batch profile contains sample selection but no sample-specific correctness allowlist',async()=>{
  const options=setup();
  await executeBatch({...options,inputs:{entries:[inputs().entries[0]],samples:[inputs().samples[0]]},
    execute:async({sample,profileDigest})=>run(sample,profileDigest)});
  const profile=JSON.parse(readFileSync(join(options.out,'profile.json'),'utf8'));
  assert.equal('expectedCoverageDigest' in profile,false);
  assert.equal('expectedDefectsDigest' in profile,false);
});
test('baseline skips only unprepared warm runs, continues remaining sources and keeps all planned rows',async()=>{
  const called=[];const result=await executeBatch({...setup(),inputs:inputs(),preset:'baseline',repetitions:3,execute:async({sample,profileDigest,cacheState})=>{
    called.push(sample.inputId+cacheState);const result=run(sample,profileDigest);if(sample.inputId==='a')result.report.correctness='failed';return result;}});
  assert.equal(called.length,15);assert.equal(result.result.rows.length,18);assert.equal(result.result.rows.filter(row=>row.status==='SKIPPED').length,3);
  assert.equal(result.result.baselineEligible,false);
});
test('baseline defaults to one cold/warm pair and keeps a verified source-defect partial warm run',async()=>{
  const selected={entries:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),status:'READY'}],
    samples:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),paths:[],actions:[]}]};
  const calls=[];
  const result=await executeBatch({...setup(),inputs:selected,preset:'baseline',execute:async({sample,profileDigest,cacheState})=>{
    calls.push(cacheState);const value=run(sample,profileDigest);value.report.correctness='partial';
    value.report.runId=`s-${cacheState}`;value.report.processInstanceId=`s-${cacheState}`;value.report.conditions.cacheState=cacheState;
    value.report.defectAssessment={kind:'source-geometry',status:'evidence-backed',sourceSha256:sample.sourceSha256,sourceSetDigest:'b'.repeat(64),failedOccurrences:34};
    value.report.evidence={semanticDigest:'semantic',placementDigest:'placement',baseGeometryDigest:'geometry',baseArtifactDigest:'artifact',
      progress:{workload:{shown:2731,failed:34}}};return value;
  }});
  assert.deepEqual(calls,['cold','warm']);assert.deepEqual(result.result.rows.map(row=>row.status),['PARTIAL','PARTIAL']);
  assert.equal(result.result.pairs[0].outcome,'PARTIAL');assert.equal(result.result.outcome,'PARTIAL');
  assert.equal(result.result.baselineEligible,true);
});
test('evidence-backed engineering coverage remains partial while cold and warm use a published semantic cache',async()=>{
  const selected={entries:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),status:'READY'}],
    samples:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),paths:[],actions:[]}]};
  const calls=[],result=await executeBatch({...setup(),inputs:selected,preset:'baseline',execute:async({sample,profileDigest,cacheState})=>{
    calls.push(cacheState);const value=run(sample,profileDigest);value.report.runId=`coverage-${cacheState}`;
    value.report.processInstanceId=value.report.runId;value.report.conditions.cacheState=cacheState;
    value.report.correctness='partial';value.report.cachePublished=true;value.report.coverageComplete=false;
    value.report.defectAssessment={kind:'coverage',status:'evidence-backed',sourceSha256:sample.sourceSha256,
      coverageDigest:'b'.repeat(64)};
    value.report.evidence={semanticDigest:'semantic',placementDigest:'placement',baseGeometryDigest:'geometry',baseArtifactDigest:'artifact',
      engineeringCoverage:{incompleteReasons:['source-reference-unresolved'],referenceStatuses:{resolved:12172,missing:258}},
      progress:{workload:{shown:2944,failed:0,partial:1046}}};return value;
  }});
  assert.deepEqual(calls,['cold','warm']);assert.deepEqual(result.result.rows.map(row=>row.status),['PARTIAL','PARTIAL']);
  assert.equal(result.result.rows[0].coverageIncompleteReasons,'source-reference-unresolved');
  assert.equal(result.result.rows[0].unresolvedReferenceCount,258);
  assert.match(readFileSync(join(result.out,'report.html'),'utf8'),/未解析引用 258/);
  assert.equal(result.result.pairs[0].outcome,'PARTIAL');
});
test('measurement-only gaps do not discard a valid warm-cache opportunity',async()=>{
  const selected={entries:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),status:'READY'}],
    samples:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),paths:[],actions:[]}]};
  const calls=[],result=await executeBatch({...setup(),inputs:selected,preset:'baseline',execute:async({sample,profileDigest,cacheState})=>{
    calls.push(cacheState);const value=run(sample,profileDigest);
    value.report.runId=`measurement-${cacheState}`;value.report.processInstanceId=value.report.runId;
    value.report.conditions.cacheState=cacheState;
    if(cacheState==='cold')value.report.measurementComplete=false;
    return value;
  }});
  assert.deepEqual(calls,['cold','warm']);
  assert.deepEqual(result.result.rows.map(row=>row.status),['INCONCLUSIVE','PASS']);
  assert.equal(result.result.baselineEligible,false);
});
test('missing paired warm profile is an inconclusive measurement, not product failure',async()=>{
  const selected={entries:[inputs().entries[0]],samples:[inputs().samples[0]]};
  const result=await executeBatch({...setup(),inputs:selected,preset:'baseline',execute:async({sample,profileDigest,cacheState})=>{
    if(cacheState==='warm')throw Error('warm-webview-profile-unavailable');
    return run(sample,profileDigest);
  }});
  assert.deepEqual(result.result.rows.map(row=>row.status),['PASS','INCONCLUSIVE']);
  assert.equal(result.result.outcome,'INCONCLUSIVE');
});
test('a readable bare archive without a persistent cache reports its variant and skips unsupported warm',async()=>{
  const selected={entries:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),status:'READY'}],
    samples:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),paths:[],actions:[]}]};
  let calls=0;
  const result=await executeBatch({...setup(),inputs:selected,preset:'baseline',execute:async({sample,profileDigest})=>{
    calls++;const value=run(sample,profileDigest);value.report.correctness='partial';value.report.cacheVerified=false;
    value.report.inputVariant='bare-7z';value.report.inputVariantCode='INPUT_VARIANT';value.report.cacheFailureCode='CACHE_NOT_PERSISTABLE';
    value.report.defectAssessment={kind:'input-variant',status:'cache-not-persistable',sourceSha256:sample.sourceSha256,variant:'bare-7z'};
    return value;
  }});
  assert.equal(calls,1);assert.deepEqual(result.result.rows.map(row=>row.status),['PARTIAL','SKIPPED']);
  assert.equal(result.result.rows[1].error,'WARM_UNSUPPORTED:CACHE_NOT_PERSISTABLE');
  assert.equal(result.result.baselineEligible,false);
});
test('a corrupt archive is recorded as input error and cannot prepare a warm run',async()=>{
  const selected={entries:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),status:'READY'}],
    samples:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),paths:[],actions:[]}]};
  const result=await executeBatch({...setup(),inputs:selected,preset:'baseline',execute:async({sample,profileDigest})=>{
    const value=run(sample,profileDigest);Object.assign(value.report,{inputIntegrity:'corrupt',reason:'input-corrupt',
      correctness:'unverified',cacheVerified:false,measurementComplete:false});return value;
  }});
  assert.deepEqual(result.result.rows.map(row=>row.status),['INPUT_ERROR','SKIPPED']);
  assert.equal(result.result.rows[1].error,'WARM_UNSUPPORTED:INPUT_CORRUPT');
});
test('pre-open infrastructure failure retries with a new run and preserves cold/warm coverage',async()=>{
  const selected={entries:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),status:'READY'}],
    samples:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),paths:[],actions:[]}]};
  const calls=[],result=await executeBatch({...setup(),inputs:selected,preset:'baseline',waitRetry:async()=>{},
    execute:async({sample,profileDigest,cacheState})=>{
      calls.push(cacheState);const value=run(sample,profileDigest);
      value.report.runId=`run-${calls.length}`;value.report.processInstanceId=value.report.runId;
      value.report.conditions.cacheState=cacheState;
      if(calls.length===1)Object.assign(value.report,{reason:'native-cdp-unavailable',openAttempted:false,evidence:null,
        correctness:'unverified',cacheVerified:false,measurementComplete:false});
      return value;
    }});
  assert.deepEqual(calls,['cold','cold','warm']);
  assert.deepEqual(result.result.rows.map(row=>row.status),['PASS','PASS']);
  assert.equal(result.result.rows[0].attempts,2);
  assert.deepEqual(result.result.rows[0].startupFailures,['native-cdp-unavailable']);
  assert.equal(result.result.attempts.length,3);
  const summaries=JSON.parse(readFileSync(join(result.out,'results.json'),'utf8')).summaries;
  assert.equal(summaries[0].validRepetitions,1);
  assert.equal(summaries[0].startupRetries,1);
  assert.equal(result.result.baselineEligible,true);
  const html=readFileSync(join(result.out,'report.html'),'utf8');
  assert.ok(html.includes('有效 / 计划'));assert.ok(html.includes("table.tBodies[0]"));
});
test('startup retry exhaustion retains infrastructure cause; product failures run once',async()=>{
  const selected={entries:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),status:'READY'}],
    samples:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),paths:[],actions:[]}]};
  let calls=0;
  const exhausted=await executeBatch({...setup(),inputs:selected,preset:'baseline',waitRetry:async()=>{},execute:async({sample,profileDigest})=>{
    calls++;const value=run(sample,profileDigest);value.report.runId=`failed-${calls}`;
    Object.assign(value.report,{reason:'native-cdp-unavailable',openAttempted:false,evidence:null,
      correctness:'unverified',cacheVerified:false,measurementComplete:false});return value;
  }});
  assert.equal(calls,3);
  assert.deepEqual(exhausted.result.rows.map(row=>row.status),['INCONCLUSIVE','SKIPPED']);
  assert.match(exhausted.result.rows[1].error,/cold-startup-infrastructure-unavailable:native-cdp-unavailable/);
  calls=0;
  const product=await executeBatch({...setup(),inputs:selected,preset:'baseline',waitRetry:async()=>{},execute:async({sample,profileDigest})=>{
    calls++;const value=run(sample,profileDigest);
    Object.assign(value.report,{reason:'project-open-failed',openAttempted:true,correctness:'failed'});return value;
  }});
  assert.equal(calls,1);assert.equal(product.result.rows[0].status,'FAIL');
  assert.equal(isStartupInfrastructureFailure({reason:'native-cdp-unavailable',openAttempted:true,evidence:null}),false);
  assert.equal(isStartupInfrastructureFailure({reason:'native-cdp-unavailable',openAttempted:false,evidence:{}}),false);
});
test('cancellation during retry backoff cannot launch another native process',async()=>{
  const selected={entries:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),status:'READY'}],
    samples:[{inputId:'s',sampleId:'s',sourceSha256:'a'.repeat(64),paths:[],actions:[]}]};
  const controller=new AbortController();let calls=0;
  const result=await executeBatch({...setup(),inputs:selected,preset:'baseline',signal:controller.signal,
    waitRetry:async()=>controller.abort(),execute:async({sample,profileDigest})=>{
      calls++;const value=run(sample,profileDigest);
      Object.assign(value.report,{reason:'native-cdp-unavailable',openAttempted:false,evidence:null,
        correctness:'unverified',cacheVerified:false,measurementComplete:false});return value;
    }});
  assert.equal(calls,1);assert.equal(result.result.status,'CANCELLED');
  assert.deepEqual(result.result.rows.map(row=>row.status),['CANCELLED','CANCELLED']);
});
test('CLI accepts -repeat 3 and freezes three paired attempts',()=>{
  const options=setup(),registry=join(options.out,'missing.json');
  writeFileSync(registry,JSON.stringify({samples:[{path:'missing.gim'}]}));
  const child=spawnSync(process.execPath,['scripts/benchmarks/cli.mjs','batch','--build',options.buildManifest,
    '--registry',registry,'--preset','baseline','-repeat','3','--output',options.out],
    {cwd:join(root,'desktop'),env:process.env,encoding:'utf8',windowsHide:true});
  assert.equal(child.status,1); // INPUT_ERROR, no GIM or native process is launched.
  assert.equal(JSON.parse(readFileSync(join(options.out,'profile.json'),'utf8')).repetitions,3);
});
test('cancellation settles current run and records all remaining inputs',async()=>{
  const controller=new AbortController();let count=0;
  const result=await executeBatch({...setup(),inputs:inputs(),signal:controller.signal,execute:async({sample,profileDigest,signal})=>{count++;controller.abort();assert.ok(signal.aborted);return run(sample,profileDigest);}});
  assert.equal(count,1);assert.equal(result.result.status,'CANCELLED');assert.deepEqual(result.result.rows.map(row=>row.status),['CANCELLED','CANCELLED','CANCELLED']);
});
test('registry accepts existing workspace registries and records missing paths without reading outside workspace',async()=>{
  const options=setup(),registry=join(options.out,'input.json');writeFileSync(registry,'\uFEFF'+JSON.stringify({samples:[{path:'missing.gim'},{}]}));
  const result=await loadBatchInputs(root,{registry});assert.equal(result.entries.length,2);assert.ok(result.entries.every(entry=>entry.status==='INPUT_ERROR'));
  assert.throws(()=>artifactDirectory(root,join(root,'desktop','not-artifacts')),/tmp/);
});
test('L0/L1 committed registries require full source SHA without reading GIM files',async()=>{
  for(const tier of ['l0','l1']){
    const directory=join(root,'benchmarks',tier),files=readdirSync(directory).filter(name=>name.endsWith('.json'));
    assert.ok(files.length>0);
    for(const name of files){
      const file=join(directory,name),registry=JSON.parse(readFileSync(file,'utf8'));
      assert.equal(registry.version,'gim-batch-input-v1');
      assert.ok(registry.samples.length>0);
      for(const row of registry.samples){
        assert.equal(row.sampleTier,tier.toUpperCase());assert.match(row.sourceSha256,/^[a-f0-9]{64}$/);
        assert.ok(!relative(root,resolve(dirname(file),row.path)).startsWith('..'));
      }
    }
  }
  const options=setup(),file=join(options.out,'missing-hash.json');
  writeFileSync(file,JSON.stringify({version:'gim-batch-input-v1',samples:[{path:'missing.gim',sampleTier:'L0'}]}));
  const result=await loadBatchInputs(root,{registry:file});
  assert.equal(result.entries[0].error,'source-sha-required');
});
test('L2 directory registry reports a missing directory without per-file hashes',async()=>{
  const options=setup(),file=join(options.out,'l2.json');
  writeFileSync(file,JSON.stringify({version:'gim-batch-directories-v1',sampleTier:'L2',directories:[{group:'complex-engineering',path:'missing-directory'}]}));
  const result=await loadBatchInputs(root,{registry:file});
  assert.deepEqual(result.entries.map(row=>[row.sampleTier,row.group,row.error]),[['L2','complex-engineering','directory-missing']]);
  writeFileSync(file,JSON.stringify({version:'gim-batch-directories-v1',sampleTier:'L2',directories:[{group:'complex-engineering',path:'.'}]}));
  const empty=await loadBatchInputs(root,{registry:file});
  assert.equal(empty.entries[0].error,'directory-empty');
});
test('CSV handles delimiters/newlines/formula injection and summaries exclude failed trials',()=>{
  assert.equal(csv([{value:'=1,"x"\nnext'}],['value']),'\uFEFF"value"\r\n"\'=1,""x""\nnext"\r\n');
  const result=summarize([{inputId:'a',cacheState:'cold',status:'PASS',firstResponseMs:10},{inputId:'a',cacheState:'cold',status:'FAIL',firstResponseMs:1}]);
  assert.equal(result[0].firstResponseMsMedian,10);assert.equal(result[0].failed,1);
});
test('recovers a stopped batch without inventing settled time or cache success',()=>{
  const {root,out}=setup(),runId=`run-recover-${Date.now()}`,sampleId=`sample-${Date.now()}`,sourceSha256='a'.repeat(64);
  const runDir=join(root,'tmp','gim-bench','runs',runId);mkdirSync(runDir,{recursive:true});
  writeFileSync(join(runDir,'run.private.json'),JSON.stringify({sampleId,sourceSha256}));
  writeFileSync(join(runDir,'progress.private.json'),JSON.stringify({atMs:338600,
    progress:{cacheSettled:false,cache:{writePending:199}}}));
  writeFileSync(join(out,'results.json'),JSON.stringify({version:'gim-batch-results-v1',status:'RUNNING',
    outcome:'INCONCLUSIVE',anonymize:true,rows:[{inputId:'a',sampleId,sourceSha256,sampleLabel:'hash',cacheState:'cold',
      repetition:1,status:'RUNNING'},{inputId:'a',sampleId,sourceSha256,sampleLabel:'hash',cacheState:'warm',
      repetition:1,status:'PENDING'}],runs:[],stages:[],workers:[],slowTasks:[],slowPhases:[],pairs:[]}));
  assert.throws(()=>recoverInterruptedBatch(root,out),/batch-controller-ownership-unverified/);
  const recovered=recoverInterruptedBatch(root,out,{force:true});
  assert.equal(recovered.recovered,2);
  assert.deepEqual(recovered.result.rows.map(row=>row.status),['CANCELLED','CANCELLED']);
  assert.equal(recovered.result.rows[0].settledMs,null);
  assert.equal(recovered.result.rows[0].runId,runId);
  assert.equal(recovered.result.rows[0].interruptedWritePending,199);
  assert.equal(recovered.result.rows[0].interruptedCacheSettled,false);
  const report=JSON.parse(readFileSync(join(runDir,'report.json'),'utf8'));
  assert.equal(report.measurementComplete,false);
  assert.equal(report.recovery.kind,'controller-interruption-v1');
  assert.throws(()=>approveBaseline(recovered.result,'developer'),/Recovered interruption/);
});
test('recovery refuses to rewrite a batch whose controller PID is still alive',()=>{
  const {root,out}=setup(),privateOut=join(root,'tmp','gim-bench','batches',`batch-live-${Date.now()}`);
  mkdirSync(privateOut,{recursive:true});
  const nonce='a'.repeat(48);
  writeFileSync(join(privateOut,'output.private.json'),JSON.stringify({out,nonce}));
  const processStartedAt=new Date(Date.now()-process.uptime()*1000).toISOString();
  writeFileSync(join(privateOut,'controller.private.json'),JSON.stringify({pid:process.pid,nonce,processStartedAt}));
  writeFileSync(join(out,'results.json'),JSON.stringify({status:'RUNNING',rows:[{status:'PENDING'}]}));
  assert.throws(()=>recoverInterruptedBatch(root,out,{getProcessStartAt:()=>Date.parse(processStartedAt)}),/batch-controller-still-running/);
  assert.equal(JSON.parse(readFileSync(join(out,'results.json'),'utf8')).rows[0].status,'PENDING');
});
test('recovery accepts a reused PID with a different process start time',()=>{
  const {root,out}=setup(),privateOut=join(root,'tmp','gim-bench','batches',`batch-reused-${Date.now()}`);
  mkdirSync(privateOut,{recursive:true});
  const nonce='b'.repeat(48);
  writeFileSync(join(privateOut,'output.private.json'),JSON.stringify({out,nonce}));
  writeFileSync(join(privateOut,'controller.private.json'),JSON.stringify({pid:process.pid,nonce,
    processStartedAt:'2000-01-01T00:00:00.000Z'}));
  writeFileSync(join(out,'results.json'),JSON.stringify({version:'gim-batch-results-v1',status:'RUNNING',
    rows:[{inputId:'a',sampleLabel:'hash',cacheState:'cold',status:'PENDING'}],runs:[],stages:[],workers:[],pairs:[]}));
  const recovered=recoverInterruptedBatch(root,out,{getProcessStartAt:()=>Date.now()});
  assert.equal(recovered.recovered,1);
  assert.equal(recovered.result.rows[0].status,'CANCELLED');
});
test('summary never combines distinct PARTIAL source signatures',()=>{
  const rows=[{inputId:'a',cacheState:'cold',status:'PARTIAL',partialSignature:'coverage:a',firstResponseMs:10},
    {inputId:'a',cacheState:'cold',status:'PARTIAL',partialSignature:'coverage:b',firstResponseMs:20}];
  const summary=summarize(rows)[0];
  assert.equal(summary.coverageGroups,2);
  assert.equal(summary.firstResponseMsMedian,null);
  assert.equal(summary.partialSignatures,'coverage:a;coverage:b');
});

test('multi-sample comparisons keep independent triplets and report missing cases',()=>{
  const make=(id,prefix)=>Array.from({length:3},(_,i)=>({...run({inputId:id,sampleId:id,sourceSha256:id},'frozen').report,processInstanceId:prefix+i}));
  const baseline=[...make('a','ba'),...make('b','bb')],candidate=[...make('a','ca'),...make('b','cb')];
  assert.equal(compareSuites(baseline,candidate).outcome,'PASS');
  const partial=compareSuites(baseline,candidate.slice(0,3));assert.equal(partial.outcome,'INCONCLUSIVE');assert.equal(partial.comparisons.length,2);
});

test('anonymity is a report option: full source hash or filename, with stable measurement identity',async()=>{
  const data=inputs();data.entries[0].privatePath=join(root,'demo','private-model.gim');data.entries[0].sourceSha256='a'.repeat(64);
  const execute=async({sample,profileDigest})=>run(sample,profileDigest);
  const anonymous=await executeBatch({...setup(),inputs:data,execute});
  const named=await executeBatch({...setup(),inputs:data,execute,anonymize:false});
  assert.equal(anonymous.result.rows[0].sampleLabel,'a'.repeat(64));assert.equal(anonymous.result.rows[0].sourcePath,undefined);
  assert.equal(named.result.rows[0].sampleLabel,'private-model.gim');assert.equal(named.result.rows[0].sourcePath,'demo/private-model.gim');
  assert.equal(anonymous.result.profileDigest,named.result.profileDigest);
});

test('named public output root keeps filenames and diagnostic CSV rows but never becomes authority',async()=>{
  const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
  const data=inputs();data.entries[0].privatePath=join(fixtureRoot,'demo','standard-A1.gim');
  const result=await executeBatch({...options,root:fixtureRoot,out,inputs:data,anonymize:false,execute:async({sample,profileDigest})=>{
    const value=run(sample,profileDigest);
    value.report.measurement={phases:{'host:host.cacheRead':{count:1,totalMs:12,maxMs:12}},workers:{worker:{family:'dev'}}};
    value.report.workerMemory=[{workerId:'worker',samples:3,observedPeakBytes:1024}];
    value.report.templateDiagnostics=[{kind:'queue',sourceId:'source-1',queueWaitMs:10,outputBytes:64}];return value;
  }});
  const json=JSON.parse(readFileSync(join(out,'results.json'),'utf8')),profile=JSON.parse(readFileSync(join(out,'profile.json'),'utf8'));
  assert.equal(json.artifactRole,'public-derived');assert.equal(json.authority,false);assert.equal(json.anonymize,false);
  assert.equal(json.rows[0].sampleLabel,'standard-A1.gim');assert.equal(json.rows[0].sourcePath,undefined);assert.equal(json.rows[0].sourceSha256,undefined);
  assert.equal(json.rows[0].sampleId,profile.cases[0].sampleId);assert.equal(json.profileDigest,profile.profileDigest);
  assert.match(readFileSync(join(out,'stages.csv'),'utf8'),/host:host.cacheRead/);
  assert.match(readFileSync(join(out,'workers.csv'),'utf8'),/available/);
  assert.ok(readFileSync(join(out,'slow-templates.csv'),'utf8').split('\r\n').length>2);
  assert.equal(JSON.parse(readFileSync(result.privateResults,'utf8')).artifactRole,undefined);
});

test('recovery durably updates private authority, preserves mapping, and refuses a public-only recovery',async()=>{
  const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
  const result=await executeBatch({...options,root:fixtureRoot,out,inputs:inputs(),execute:async({sample,profileDigest})=>run(sample,profileDigest)});
  const privateOut=dirname(result.privateResults),state=JSON.parse(readFileSync(result.privateResults,'utf8'));
  state.status='RUNNING';state.rows[0].status='RUNNING';state.rows[1].status='PENDING';
  writeFileSync(result.privateResults,JSON.stringify(state));
  const nonce='a'.repeat(48);writeFileSync(join(privateOut,'output.private.json'),JSON.stringify({out,nonce,exportId:state.exportId}));
  writeFileSync(join(privateOut,'controller.private.json'),JSON.stringify({pid:process.pid,nonce,processStartedAt:'2000-01-01T00:00:00Z'}));
  const recovered=recoverInterruptedBatch(fixtureRoot,out,{getProcessStartAt:()=>Date.now()});
  const authority=JSON.parse(readFileSync(result.privateResults,'utf8'));
  assert.equal(authority.status,'CANCELLED');assert.equal(authority.recovery.recoveredRows,2);
  assert.deepEqual(authority.rows.slice(0,2).map(row=>row.status),['CANCELLED','CANCELLED']);
  assert.equal(recovered.privateResults,result.privateResults);assert.equal(existsSync(join(privateOut,'controller.private.json')),false);
  assert.equal(recoverInterruptedBatch(fixtureRoot,out).recovered,0);
  const isolated=artifactDirectory(fixtureRoot,join(fixtureRoot,'output','public-only'));
  writeFileSync(join(isolated,'results.json'),readFileSync(join(out,'results.json')));
  assert.throws(()=>recoverInterruptedBatch(fixtureRoot,isolated,{force:true}),/public-derived-is-not-authoritative/);
});

test('a reused output selects its interrupted controller ahead of historical completed mappings',async()=>{
  const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
  const execute=async({sample,profileDigest})=>run(sample,profileDigest);
  const old=await executeBatch({...options,root:fixtureRoot,out,inputs:inputs(),execute});
  const oldBytes=readFileSync(old.privateResults,'utf8');
  const oldMapping=JSON.parse(readFileSync(join(dirname(old.privateResults),'output.private.json'),'utf8'));
  writeFileSync(join(dirname(old.privateResults),'controller.private.json'),JSON.stringify({pid:process.pid,nonce:oldMapping.nonce,processStartedAt:'2000-01-01T00:00:00Z'}));
  const current=await executeBatch({...options,root:fixtureRoot,out,inputs:inputs(),execute});
  const dir=dirname(current.privateResults),state=JSON.parse(readFileSync(current.privateResults,'utf8'));
  state.status='RUNNING';state.rows[0].status='RUNNING';state.rows[1].status='PENDING';
  writeFileSync(current.privateResults,JSON.stringify(state));
  const mapping=JSON.parse(readFileSync(join(dir,'output.private.json'),'utf8'));
  writeFileSync(join(dir,'controller.private.json'),JSON.stringify({pid:process.pid,nonce:mapping.nonce,processStartedAt:'2000-01-01T00:00:00Z'}));
  const result=recoverInterruptedBatch(fixtureRoot,out,{getProcessStartAt:()=>Date.now()});
  assert.equal(result.privateResults,current.privateResults);assert.equal(result.recovered,2);
  assert.equal(readFileSync(old.privateResults,'utf8'),oldBytes);
  assert.equal(JSON.parse(readFileSync(current.privateResults,'utf8')).status,'CANCELLED');
  assert.equal(recoverInterruptedBatch(fixtureRoot,out).privateResults,current.privateResults);
  assert.equal(recoverInterruptedBatch(fixtureRoot,out,{force:true}).recovered,0);
});

test('a completed current export cannot be overwritten by an older interrupted controller',async()=>{
  const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
  const execute=async({sample,profileDigest})=>run(sample,profileDigest);
  const old=await executeBatch({...options,root:fixtureRoot,out,inputs:inputs(),execute});
  const oldDir=dirname(old.privateResults),oldState=JSON.parse(readFileSync(old.privateResults,'utf8'));
  oldState.status='RUNNING';oldState.rows[0].status='RUNNING';writeFileSync(old.privateResults,JSON.stringify(oldState));
  const mapping=JSON.parse(readFileSync(join(oldDir,'output.private.json'),'utf8'));
  writeFileSync(join(oldDir,'controller.private.json'),JSON.stringify({pid:process.pid,nonce:mapping.nonce,processStartedAt:'2000-01-01T00:00:00Z'}));
  const current=await executeBatch({...options,root:fixtureRoot,out,inputs:inputs(),execute});
  const publicBytes=readFileSync(join(out,'results.json'),'utf8'),oldBytes=readFileSync(old.privateResults,'utf8');
  const recovered=recoverInterruptedBatch(fixtureRoot,out,{getProcessStartAt:()=>Date.now()});
  assert.equal(recovered.recovered,0);assert.equal(recovered.privateResults,current.privateResults);
  assert.equal(readFileSync(join(out,'results.json'),'utf8'),publicBytes);assert.equal(readFileSync(old.privateResults,'utf8'),oldBytes);
});

test('running batches checkpoint private authority and generate derived tables only at termination',async()=>{
  const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
  let checked=0;
  const result=await executeBatch({...options,root:fixtureRoot,out,inputs:inputs(),execute:async({sample,profileDigest})=>{
    const batches=join(fixtureRoot,'tmp','gim-bench','batches'),privateDir=join(batches,readdirSync(batches)[0]);
    const checkpoint=JSON.parse(readFileSync(join(privateDir,'results.json'),'utf8'));
    assert.equal(checkpoint.status,'RUNNING');assert.equal(checkpoint.rows.find(row=>row.inputId===sample.inputId).status,'RUNNING');
    for(const dir of [out,privateDir])for(const file of ['results.csv','stages.csv'])assert.equal(existsSync(join(dir,file)),false);
    assert.equal(existsSync(join(privateDir,'report.html')),false);
    const progress=JSON.parse(readFileSync(join(out,'status.json'),'utf8'));
    assert.equal(progress.artifactRole,'public-derived');assert.equal(progress.reportReady,false);
    assert.equal(progress.completed,checked);assert.equal(progress.running,1);
    const html=readFileSync(join(out,'report.html'),'utf8');
    assert.match(html,/recover-batch/);assert.match(html,/id="results"/);assert.match(html,/id="tab-coverage"/);
    assert.match(html,/id="search"/);assert.match(html,/data-status="RUNNING"/);
    assert.doesNotMatch(html,/private-name|protocol-test|sourceSha256|href="results.csv"/);
    if(checked)assert.match(html,/data-status="PASS"[\s\S]*?<td>0\.012<\/td>/);
    assert.doesNotMatch(readFileSync(join(out,'status.json'),'utf8'),/sourceSha256|private-name|sourcePath|protocol-test/);
    assert.equal(existsSync(join(out,'results.json')),false);checked++;
    return run(sample,profileDigest);
  }});
  assert.equal(checked,3);assert.equal(JSON.parse(readFileSync(result.privateResults,'utf8')).status,'COMPLETE');
  for(const dir of [out,dirname(result.privateResults)])for(const file of ['results.csv','stages.csv','report.html'])assert.equal(existsSync(join(dir,file)),true);
  assert.equal(JSON.parse(readFileSync(join(out,'status.json'),'utf8')).reportReady,true);
});

test('live HTML uses export aliases or explicit sample labels without traversing diagnostic tables',()=>{
  for(const anonymize of [true,false]){
    const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
    const project=createPublicProjector({anonymize});
    const row={inputId:'private-input',sampleId:'private-sample',sourceSha256:'private-sha',sourcePath:'C:/private',
      sampleLabel:'standard-A1.gim',repetition:1,cacheState:'cold',status:'PARTIAL',error:'source-reference-unresolved;private-reason',
      firstResponseMs:1234,firstGeometryMs:2345,allGeometryReadyMs:3456,settledMs:4567};
    const profile=project({cases:[row]}),state={version:'gim-batch-results-v1',anonymize,status:'RUNNING',outcome:'INCONCLUSIVE',updatedAt:'2026-11-12T01:00:00.000Z',rows:[row]};
    for(const key of ['stages','workers','slowTasks','slowPhases','templateDiagnostics','runs'])
      Object.defineProperty(state,key,{enumerable:true,get(){throw Error('diagnostic table visited: '+key);}});
    writeBatchProgress(out,state,{root:fixtureRoot,project});
    const html=readFileSync(join(out,'report.html'),'utf8');
    assert.ok(html.includes(`<td>${profile.cases[0].inputId}</td>`));
    if(anonymize)assert.ok(html.includes(`<td>${profile.cases[0].sampleId}</td>`));
    for(const value of ['1.234','2.345','3.456','4.567'])assert.ok(html.includes(`<td>${value}</td>`));
    assert.match(html,/来源引用未解析/);assert.match(html,/其他未验证文本已隐藏/);
    assert.doesNotMatch(html,/private-input|private-sample|private-sha|C:\/private|private-reason/);
    assert.equal(html.includes('standard-A1.gim'),!anonymize);
    assert.match(html,/2026-11-12T01:00:00\.000Z/);
    assert.equal(existsSync(join(out,'results.csv')),false);
  }
});

test('a controller callback exception exports saved results before propagating the failure',async()=>{
  const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
  await assert.rejects(executeBatch({...options,root:fixtureRoot,out,inputs:inputs(),onProgress(){throw Error('controller-stopped');}}),/controller-stopped/);
  const result=JSON.parse(readFileSync(join(out,'results.json'),'utf8'));
  assert.equal(result.status,'CANCELLED');assert.equal(result.outcome,'INCONCLUSIVE');
  assert.deepEqual(result.rows.map(row=>row.status),['CANCELLED','CANCELLED','CANCELLED']);
  const batches=join(fixtureRoot,'tmp','gim-bench','batches'),privateDir=join(batches,readdirSync(batches)[0]);
  assert.equal(existsSync(join(privateDir,'controller.private.json')),false);
  assert.equal(JSON.parse(readFileSync(join(privateDir,'controller-error.private.json'),'utf8')).message,'controller-stopped');
  assert.equal(recoverInterruptedBatch(fixtureRoot,out).recovered,0);
});

test('a failed public progress write cannot stop private checkpointing or sample execution',async()=>{
  const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
  const obstruction=join(out,'status.json.next');mkdirSync(obstruction);
  let calls=0;
  const result=await executeBatch({...options,root:fixtureRoot,out,inputs:inputs(),execute:async({sample,profileDigest})=>{
    if(calls++===0){
      const batches=join(fixtureRoot,'tmp/gim-bench/batches'),dir=join(batches,readdirSync(batches)[0]);
      assert.equal(JSON.parse(readFileSync(join(dir,'results.json'),'utf8')).status,'RUNNING');
      assert.ok(existsSync(join(dir,'progress-export-error.private.json')));
      rmdirSync(obstruction);
    }
    return run(sample,profileDigest);
  }});
  assert.equal(calls,3);assert.equal(result.result.status,'COMPLETE');
  assert.equal(JSON.parse(readFileSync(join(out,'status.json'),'utf8')).reportReady,true);
});

test('a fatal asynchronous controller error preserves its checkpoint and can recover before public results exist',()=>{
  const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
  const privateOut=artifactDirectory(fixtureRoot,join(fixtureRoot,'tmp/gim-bench/batches/fatal'));
  const script=join(fixtureRoot,'fatal-controller.mjs');
  writeFileSync(script,`import{executeBatch}from${JSON.stringify(pathToFileURL(resolve('scripts/benchmarks/batch.mjs')).href)};
await executeBatch({...${JSON.stringify({...options,root:fixtureRoot,out,privateOut,inputs:inputs()})},
 execute:async()=>new Promise(()=>{}),onProgress:()=>setTimeout(()=>{throw Error('anonymous-controller-crash')},1)});
`);
  const child=spawnSync(process.execPath,[script],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.notEqual(child.status,0);assert.match(child.stderr,/anonymous-controller-crash/);
  assert.equal(existsSync(join(out,'results.json')),false);
  assert.equal(JSON.parse(readFileSync(join(out,'status.json'),'utf8')).reportReady,false);
  assert.equal(JSON.parse(readFileSync(join(privateOut,'controller-error.private.json'),'utf8')).origin,'uncaughtException');
  const recovered=recoverInterruptedBatch(fixtureRoot,out);
  assert.equal(recovered.recovered,3);assert.equal(recovered.privateResults,join(privateOut,'results.json'));
  assert.equal(JSON.parse(readFileSync(join(out,'results.json'),'utf8')).artifactRole,'public-derived');
  assert.equal(JSON.parse(readFileSync(join(out,'status.json'),'utf8')).reportReady,true);
  for(const name of ['results.csv','stages.csv','workers.csv','slow-templates.csv','report.html'])assert.ok(existsSync(join(out,name)));
});

test('recovery regenerates missing completed exports without changing private authority',async()=>{
  const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
  const result=await executeBatch({...options,root:fixtureRoot,out,inputs:inputs(),execute:async({sample,profileDigest})=>run(sample,profileDigest)});
  const authority=readFileSync(result.privateResults,'utf8'),profile=readFileSync(join(out,'profile.json'),'utf8');
  unlinkSync(join(out,'results.csv'));unlinkSync(join(out,'report.html'));
  const recovered=recoverInterruptedBatch(fixtureRoot,out);
  assert.equal(recovered.recovered,0);assert.equal(recovered.reportsRegenerated,true);
  assert.equal(readFileSync(result.privateResults,'utf8'),authority);
  assert.equal(readFileSync(join(out,'profile.json'),'utf8'),profile);
  assert.ok(existsSync(join(out,'results.csv'))&&existsSync(join(out,'report.html')));
  writeFileSync(join(out,'status.json'),JSON.stringify({reportReady:false}));
  assert.equal(recoverInterruptedBatch(fixtureRoot,out).reportsRegenerated,true);
  assert.equal(JSON.parse(readFileSync(join(out,'status.json'),'utf8')).reportReady,true);
  assert.equal(recoverInterruptedBatch(fixtureRoot,out).reportsRegenerated,false);
});

test('completed export repair refuses to race its still-running finalizer',async()=>{
  const options=setup(),fixtureRoot=options.out,out=artifactDirectory(fixtureRoot,join(fixtureRoot,'output'));
  const result=await executeBatch({...options,root:fixtureRoot,out,inputs:inputs(),execute:async({sample,profileDigest})=>run(sample,profileDigest)});
  const privateOut=dirname(result.privateResults),mapping=JSON.parse(readFileSync(join(privateOut,'output.private.json'),'utf8'));
  const processStartedAt=new Date().toISOString();
  writeFileSync(join(privateOut,'controller.private.json'),JSON.stringify({pid:process.pid,nonce:mapping.nonce,processStartedAt}));
  unlinkSync(join(out,'report.html'));
  assert.throws(()=>recoverInterruptedBatch(fixtureRoot,out,{getProcessStartAt:()=>Date.parse(processStartedAt)}),/still-running/);
});
