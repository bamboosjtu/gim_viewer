import {analyzeRun,exportRunTrace} from './observability.mjs';
import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {registerSamples,inventorySamples,selectSamples,workspacePath} from './samples.mjs';
import {buildAcceptance} from './acceptance-build.mjs';
import {runNative} from './native-run.mjs';
import {approveBaseline,baselineApprovalIssue,compareSuites,createPartialReview,suiteCompletenessIssues} from './compare.mjs';
import {freezeProfile,verifyProfile} from './profiles.mjs';
import {runMatrix} from './matrix.mjs';
import {lifecycleExercise} from './lifecycle.mjs';
import {measureProbeOverhead,resolveOverheadPlan} from './overhead.mjs';
import {renderReport} from './reporter.mjs';
import {runBatch,recoverInterruptedBatch} from './batch.mjs';
import {nativeExitCode} from './cli-outcome.mjs';
import {artifactDirectory,artifactFile,loadBatchInputs} from './batch-input.mjs';
import {bindMeasurementAcceptance} from './measurement-acceptance.mjs';
import {createGeometryReview,geometryReviewIssue} from './geometry-review.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),home=join(root,'tmp','gim-bench'),corpus=join(home,'corpus');
const [command,...args]=process.argv.slice(2);
const option=name=>{const index=args.findIndex(value=>value===`--${name}`||value===`-${name}`);return index<0?undefined:args[index+1];};
const read=path=>{const value=JSON.parse(readFileSync(workspacePath(root,resolve(path)),'utf8'));if(value.artifactRole==='public-derived')throw Error('public-derived-is-not-authoritative');return value;};
const write=(name,value)=>{const path=artifactFile(root,join(home,name));writeFileSync(path,JSON.stringify(value,null,2));console.log(path);return path;};
const writeComparison=value=>{const path=artifactFile(root,option('output')?resolve(option('output')):join(home,'comparison.json'));
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2));console.log(path);return path;};
const approvalName=(kind,digest)=>`${kind}-${digest.slice(0,16)}-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
const registeredSamples=async()=>option('directory')||option('registry')
  ?(await loadBatchInputs(root,{directory:option('directory'),registry:option('registry')})).samples
  :read(join(corpus,'registry.private.json')).samples;
try{
  artifactDirectory(root,home);for(const name of ['TEMP','TMP','TMPDIR'])process.env[name]=home;
  if(command==='analyze'||command==='export-trace'){
    if(!option('input'))throw Error('--input required');
    const input=workspacePath(root,resolve(option('input')));
    console.log(command==='export-trace'?await exportRunTrace(root,input):JSON.stringify((await analyzeRun(root,input)).coverage));
  }else if(command==='init'){
    if(!existsSync(join(home,'config.json')))write('config.json',{version:'gim-benchmark-config-v1',sampleLocation:'workspace',sampleDistribution:false,sampleTiers:['L0','L1','L2'],samplingPeriodMs:1000,repetitions:3,regressionThreshold:0.1,baseline:null});
    else console.log(join(home,'config.json'));
  }else if(command==='samples'){
    const registry=await registerSamples(root,corpus);console.log(JSON.stringify({paths:registry.pathCount,unique:registry.uniqueSources,duplicates:registry.duplicatePaths,groups:registry.groups},null,2));
  }else if(command==='inventory'){
    const build=spawnSync('cargo',['build','--manifest-path',join(root,'crates/gim-native-core/Cargo.toml'),'--example','measurement_inventory'],{cwd:root,windowsHide:true,stdio:'inherit'});
    if(build.status!==0)throw Error('Native inventory build failed');
    const registry=await inventorySamples(root,corpus,join(root,'crates/gim-native-core/target/debug/examples/measurement_inventory'+(process.platform==='win32'?'.exe':'')));
    console.log(JSON.stringify({sources:registry.uniqueSources,unavailable:registry.samples.filter(s=>s.inventory.status!=='available').length}));
  }else if(command==='select'){
    const selection=selectSamples(read(join(corpus,'registry.private.json')));write('selection.candidate.json',selection);
  }else if(command==='freeze-profile'){
    const profile=freezeProfile(read(join(corpus,'registry.private.json')),read(join(home,'selection.candidate.json')),option('name')??'commit-gate');
    const filename=`${profile.name}.${profile.digest.slice(0,12)}.profile.json`,path=join(home,filename);
    if(existsSync(path)&&read(path).digest!==profile.digest)throw Error('Frozen profile exists with different content; no automatic replacement');
    write(filename,profile);
  }else if(command==='batch'){
    if(!option('build'))throw Error('--build requires an explicit benchmark build manifest');
    const anonymize=option('anonymize')??'true';
    if(!['true','false'].includes(anonymize))throw Error('--anonymize must be true or false');
    const controller=new AbortController();const cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    try{
      const result=await runBatch({root,buildManifest:workspacePath(root,resolve(option('build'))),directory:option('directory'),registry:option('registry'),
        ...(option('output')?{out:resolve(option('output'))}:{}),preset:option('preset')??'survey',anonymize:anonymize==='true',
        ...(option('repeat')??option('repetitions')?{repetitions:Number(option('repeat')??option('repetitions'))}:{}),
        ...(option('timeout-seconds')?{timeoutMs:Number(option('timeout-seconds'))*1000}:{}),signal:controller.signal,
        onProgress:row=>console.log(JSON.stringify(row))});
      console.log(JSON.stringify({outcome:result.result.outcome,status:result.result.status,html:join(result.out,'report.html'),csv:join(result.out,'results.csv'),privateResults:result.privateResults}));
      process.exitCode=result.result.status==='CANCELLED'?130:['PASS','PARTIAL'].includes(result.result.outcome)?0:result.result.outcome==='FAIL'?1:2;
    }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
  }else if(command==='recover-batch'){
    if(!option('output'))throw Error('--output required');
    const recovered=recoverInterruptedBatch(root,resolve(option('output')),{force:args.includes('--force')});
    console.log(JSON.stringify({outcome:recovered.result.outcome,status:recovered.result.status,recovered:recovered.recovered,
      report:join(recovered.out,'report.html'),privateResults:recovered.privateResults}));
  }else if(command==='matrix'){
    if(!option('build')||!option('profile'))throw Error('--build and --profile required');
    const profile=verifyProfile(read(option('profile')));
    const result=await runMatrix({root,buildManifest:workspacePath(root,resolve(option('build'))),registry:read(join(corpus,'registry.private.json')),profile,
      repetitions:Number(option('repetitions')??profile.repetitions),mode:option('mode')??profile.mode});
    console.log(JSON.stringify({outcome:result.result.outcome,candidate:join(result.out,'candidate.json')}));process.exitCode=['PASS','PARTIAL'].includes(result.result.outcome)?0:2;
  }else if(command==='overhead'){
    if(!option('build')||!option('sample')||!option('profile')&&!option('candidate'))
      throw Error('--build, --sample and --profile or --candidate required');
    const candidate=option('candidate')?read(option('candidate')):null;
    const sample=(await registeredSamples()).find(row=>row.sampleId===option('sample'));
    const {profile,caseSpec}=resolveOverheadPlan({candidate,profile:option('profile')?read(option('profile')):null,sample});
    const result=await measureProbeOverhead({root,buildManifest:workspacePath(root,resolve(option('build'))),sample,profile,caseSpec});
    console.log(JSON.stringify({outcome:result.result.outcome,report:join(result.out,'overhead.json')}));process.exitCode=['PASS','PARTIAL'].includes(result.result.outcome)?0:2;
  }else if(command==='build'){
    console.log(await buildAcceptance(root,{benchmark:true}));
  }else if(command==='doctor'||command==='run'||command==='lifecycle'){
    if(!option('build'))throw Error('--build requires an explicit benchmark build manifest');
    const samples=command==='doctor'?[]:await registeredSamples();
    const sample=samples.find(s=>s.sampleId===option('sample'));
    if(command!=='doctor'&&!sample)throw Error('--sample must identify a registered sample');
    const mode=option('mode')??'benchmark';if(!['off','summary','benchmark','diagnostic'].includes(mode))throw Error('Invalid measurement mode');
    const secondSample=option('second-sample')?samples.find(s=>s.sampleId===option('second-sample')):undefined;
    if(option('second-sample')&&!secondSample)throw Error('--second-sample must identify a registered sample');
    const result=await runNative({root,buildManifest:workspacePath(root,resolve(option('build'))),sample,mode,doctor:command==='doctor',
      ...(command==='lifecycle'?{scenario:'lifecycle-ten-open-close',additionalSamples:secondSample?[secondSample]:[],exercise:lifecycleExercise({sample,secondSample})}:{}),
      ...(option('diagnostics')?{diagnostic:read(option('diagnostics'))}:{}),
      ...(option('capture')?{diagnostic:{kind:option('capture'),family:option('worker-family')??'dev'}}:{})});
    const outcome=command==='doctor'?result.report.capabilityOutcome:command==='lifecycle'?result.report.exercise?.outcome:result.report.outcome;
    console.log(JSON.stringify({report:join(result.out,'report.json'),outcome,reason:result.report.reason}));
    process.exitCode=nativeExitCode(command,outcome);
  }else if(command==='compare'||command==='gate'){
    if(!option('baseline')||!option('candidate'))throw Error('--baseline and --candidate are required');
    const baseline=read(option('baseline')),candidate=read(option('candidate'));
    const geometryReview=option('geometry-review')?read(option('geometry-review')):null;
    const geometryIssue=geometryReview?geometryReviewIssue(geometryReview,baseline,candidate):null;
    const approvalIssue=command==='gate'?baselineApprovalIssue(baseline):null;
    const recoveryIssue=baseline.recovery||candidate.recovery?'recovered-interruption':null;
    const suiteIssues=[...suiteCompletenessIssues(baseline),...suiteCompletenessIssues(candidate)];
    const issues=[approvalIssue,recoveryIssue,geometryIssue,...suiteIssues].filter(Boolean);
    const failedSuite=[baseline,candidate].some(suite=>
      ['gim-benchmark-candidate-v1','gim-batch-results-v1'].includes(suite.version)&&suite.outcome==='FAIL');
    const result=issues.length?{outcome:!approvalIssue&&!recoveryIssue&&failedSuite?'FAIL':'INCONCLUSIVE',reasons:[...new Set(issues)]}:compareSuites(baseline.runs??[baseline],candidate.runs??[candidate],{
      retestBaseline:option('retest-baseline')?read(option('retest-baseline')).runs:[],retestCandidate:option('retest-candidate')?read(option('retest-candidate')).runs:[],
      requireContentEvidence:command==='gate',
      geometryChanges:geometryReview?.changes??[],
    });
    writeComparison(result);process.exitCode=['PASS','PARTIAL'].includes(result.outcome)?0:result.outcome==='FAIL'?1:2;
  }else if(command==='approve-geometry-change'){
    if(!option('baseline')||!option('candidate')||!option('verification')||!option('approver'))
      throw Error('--baseline, --candidate, --verification and --approver are required');
    const baseline=read(option('baseline')),candidate=read(option('candidate'));
    const issues=[baselineApprovalIssue(baseline),...suiteCompletenessIssues(candidate)].filter(Boolean);
    if(issues.length)throw Error(issues.join(';'));
    const review=createGeometryReview(baseline,candidate,read(option('verification')),option('approver'));
    write(approvalName('geometry-review',review.candidateDigest),review);
  }else if(command==='accept-measurement'){
    if(!option('candidate')||!option('doctor')||!option('overhead')||!option('lifecycle'))
      throw Error('--candidate, --doctor, --overhead and --lifecycle are required');
    const accepted=bindMeasurementAcceptance(read(option('candidate')),{
      doctor:read(option('doctor')),overhead:read(option('overhead')),lifecycle:read(option('lifecycle'))});
    write(approvalName('accepted-candidate',accepted.measurementAcceptance.candidateDigest),accepted);
  }else if(command==='review-partial'){
    if(!option('candidate')||!option('reviewer')||!option('reason'))throw Error('Explicit --candidate, --reviewer and --reason required');
    const review=createPartialReview(read(option('candidate')),option('reviewer'),option('reason'));
    write(approvalName('partial-review',review.candidateDigest),review);
  }else if(command==='approve-baseline'){
    if(!option('candidate')||!option('approver'))throw Error('Explicit --candidate and --approver required');
    const candidate=read(option('candidate'));
    if(candidate.outcome==='PARTIAL'&&args.includes('--first-partial')){
      const partialSources=new Set(candidate.runs?.filter(run=>run.correctness==='partial').map(run=>run.conditions?.sourceSha256));
      const knownPrior=readdirSync(home).filter(name=>/^baseline-[a-f0-9]{16}-\d+-[a-f0-9]{8}\.approved\.json$/.test(name)).some(name=>{
        try{const baseline=read(join(home,name));return !baselineApprovalIssue(baseline)&&
          baseline.runs?.some(run=>partialSources.has(run.conditions?.sourceSha256));}catch{return false;}
      });
      if(knownPrior)throw Error('Existing approved baseline requires --previous-baseline');
    }
    const approved=approveBaseline(candidate,option('approver'),{
      acceptPartial:args.includes('--accept-partial'),
      partialReview:option('partial-review')?read(option('partial-review')):null,
      firstPartial:args.includes('--first-partial'),
      previousBaseline:option('previous-baseline')?read(option('previous-baseline')):null});
    write(approvalName('baseline',approved.approval.candidateDigest).replace(/\.json$/,'.approved.json'),approved);
  }else if(command==='report'){
    if(!option('input'))throw Error('--input required');
    console.log(await renderReport(workspacePath(root,resolve(option('input'))),artifactDirectory(root,join(root,'output','gim-bench',`report-${Date.now()}`))));
  }else{
    console.log([
      'gim-bench batch --build <manifest> (--directory <folder> | --registry <json>) [--output <folder>] [--anonymize true|false] [--preset survey|baseline] [-repeat <n>] [--timeout-seconds <n>]',
      'recover-batch --output <folder> [--force] | init | samples | inventory | select | freeze-profile [--name commit-gate] | build',
      'analyze|export-trace --input <private report.json>',
      'run --mode diagnostic --diagnostics <config.json> --build <manifest> --sample <id>',
      'doctor --build <manifest>',
      'run --build <manifest> --sample <id> [--mode off|summary|benchmark|diagnostic] [--capture cpu|allocations|heap --worker-family dev]',
      'matrix --build <manifest> --profile <json>',
      'overhead --build <manifest> (--profile <json> [--candidate <json>] | --candidate <batch JSON>) --sample <id> [--registry <json> | --directory <folder>]',
      'lifecycle --build <manifest> --sample <id> [--second-sample <id>] [--registry <json> | --directory <folder>]',
      'accept-measurement --candidate <json> --doctor <report.json> --overhead <overhead.json> --lifecycle <report.json>',
      'compare|gate --baseline <json> --candidate <json> [--output <tmp/output JSON>] [--retest-baseline <json> --retest-candidate <json>] [--geometry-review <json>]',
      'approve-geometry-change --baseline <approved JSON> --candidate <json> --verification <json> --approver <name>',
      'report --input <json> | review-partial --candidate <json> --reviewer <name> --reason <code>',
      'approve-baseline --candidate <json> --approver <name> [--accept-partial --partial-review <json> (--first-partial | --previous-baseline <json>)]',
    ].join('\n'));
    if(command)process.exitCode=1;
  }
}catch(error){console.error(`[gim-bench] ${error.message}`);process.exitCode=1;}

