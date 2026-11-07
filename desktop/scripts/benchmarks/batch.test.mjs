import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {artifactDirectory,loadBatchInputs} from './batch-input.mjs';
import {executeBatch} from './batch.mjs';
import {csv,summarize} from './batch-report.mjs';
import {compareSuites} from './compare.mjs';

const root=resolve('..');
function setup(){const parent=artifactDirectory(root,join(root,'tmp','batch-protocol-tests')),out=mkdtempSync(join(parent,'run-'));
  const buildManifest=join(out,'build.json');writeFileSync(buildManifest,JSON.stringify({sourceFingerprint:'protocol-test'}));return {root,out,buildManifest};}
function inputs(){return {entries:['a','b','c'].map((id,index)=>({inputId:id,sampleId:id,sourceSha256:id,privatePath:'private-name',status:'READY'})),
  samples:['a','b','c'].map(id=>({inputId:id,sampleId:id,sourceSha256:id,paths:[],actions:[]}))};}
function run(sample,profileDigest){return {out:'private-run',dataRoot:'private-cache',report:{runId:sample.inputId,processInstanceId:sample.inputId,
  conditions:{machineId:'m',runtimeSha256:'r',buildMode:'release',measurementVersion:'v1',mode:'benchmark',scenario:'open',cacheState:'cold',sourceSha256:sample.sourceSha256,sampleId:sample.sampleId,
    profileDigest,workloadDigest:'w',routeDigest:'r',viewportDigest:'v'},correctness:'passed',cacheVerified:true,measurementComplete:true,requiredMetrics:['firstResponseMs'],metrics:{firstResponseMs:12},
  evidence:{progress:{workload:{failed:0}}}}};}

test('batch continues after execution exceptions and exports every result and failure',async()=>{
  const options=setup(),called=[];
  const result=await executeBatch({...options,inputs:inputs(),execute:async({sample,profileDigest})=>{called.push(sample.inputId);if(sample.inputId==='b')throw Error('secret project name / user path');return run(sample,profileDigest);}});
  assert.deepEqual(called,['a','b','c']);assert.equal(result.result.outcome,'FAIL');
  assert.deepEqual(result.result.rows.map(row=>row.status),['PASS','ERROR','PASS']);
  const json=readFileSync(join(options.out,'results.json'),'utf8');assert.ok(!json.includes('secret'));assert.ok(!json.includes('private-name'));
  for(const name of ['results.csv','errors.csv','summary.csv','stages.csv','workers.csv','report.html'])assert.ok(readFileSync(join(options.out,name),'utf8').length>0);
});
test('baseline skips only unprepared warm runs, continues remaining sources and keeps all planned rows',async()=>{
  const called=[];const result=await executeBatch({...setup(),inputs:inputs(),preset:'baseline',execute:async({sample,profileDigest,cacheState})=>{
    called.push(sample.inputId+cacheState);const result=run(sample,profileDigest);if(sample.inputId==='a')result.report.correctness='failed';return result;}});
  assert.equal(called.length,15);assert.equal(result.result.rows.length,18);assert.equal(result.result.rows.filter(row=>row.status==='SKIPPED').length,3);
  assert.equal(result.result.baselineEligible,false);
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
  for(const [tier,names]of [['l0',['common-design-500kv','common-design-220kv','common-design-110kv','common-design-35kv']],['l1',['substation01-04','line01-06']]]){
    for(const name of names){
      const file=join(root,'benchmarks',tier,`${name}.json`),registry=JSON.parse(readFileSync(file,'utf8'));
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
