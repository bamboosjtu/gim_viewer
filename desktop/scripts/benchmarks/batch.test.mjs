import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {artifactDirectory,loadBatchInputs} from './batch-input.mjs';
import {executeBatch,recoverInterruptedBatch} from './batch.mjs';
import {csv,summarize} from './batch-report.mjs';
import {compareSuites,approveBaseline} from './compare.mjs';
import {spawnSync} from 'node:child_process';
import {isStartupInfrastructureFailure} from './startup-retry.mjs';

const root=resolve('..');
function setup(){const parent=artifactDirectory(root,join(root,'tmp','batch-protocol-tests')),out=mkdtempSync(join(parent,'run-'));
  const buildManifest=join(out,'build.json');writeFileSync(buildManifest,JSON.stringify({sourceFingerprint:'protocol-test'}));return {root,out,buildManifest};}
function inputs(){return {entries:['a','b','c'].map((id,index)=>({inputId:id,sampleId:id,sourceSha256:id,privatePath:'private-name',status:'READY'})),
  samples:['a','b','c'].map(id=>({inputId:id,sampleId:id,sourceSha256:id,paths:[],actions:[]}))};}
function run(sample,profileDigest){return {out:'private-run',dataRoot:'private-cache',report:{runId:sample.inputId,processInstanceId:sample.inputId,
  conditions:{machineId:'m',runtimeSha256:'r',buildMode:'release',measurementVersion:'v1',detailPolicy:'task-phase-timeline-v2',lifecyclePolicy:'worker-terminal-v2',contentPolicy:'dev-l0-glb-sha256-v1',cacheProofPolicy:'source-failure-catalog-v1',webviewProfilePolicy:'paired-webview-profile-v1',mode:'benchmark',scenario:'open',cacheState:'cold',sourceSha256:sample.sourceSha256,sampleId:sample.sampleId,
    profileDigest,workloadDigest:'w',routeDigest:'r',viewportDigest:'v'},correctness:'passed',cacheVerified:true,cachePublished:true,measurementComplete:true,requiredMetrics:['firstResponseMs'],metrics:{firstResponseMs:12},
  evidence:{progress:{workload:{failed:0}}}}};}

test('batch continues after execution exceptions and exports every result and failure',async()=>{
  const options=setup(),called=[];
  const result=await executeBatch({...options,inputs:inputs(),execute:async({sample,profileDigest})=>{called.push(sample.inputId);if(sample.inputId==='b')throw Error('secret project name / user path');return run(sample,profileDigest);}});
  assert.deepEqual(called,['a','b','c']);assert.equal(result.result.outcome,'FAIL');
  assert.deepEqual(result.result.rows.map(row=>row.status),['PASS','ERROR','PASS']);
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
  const recovered=recoverInterruptedBatch(root,out);
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
  writeFileSync(join(privateOut,'output.private.json'),JSON.stringify({out}));
  writeFileSync(join(privateOut,'controller.private.json'),JSON.stringify({pid:process.pid}));
  writeFileSync(join(out,'results.json'),JSON.stringify({status:'RUNNING',rows:[{status:'PENDING'}]}));
  assert.throws(()=>recoverInterruptedBatch(root,out),/batch-controller-still-running/);
  assert.equal(JSON.parse(readFileSync(join(out,'results.json'),'utf8')).rows[0].status,'PENDING');
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
