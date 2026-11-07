import {writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {artifactDirectory} from '../benchmarks/batch-input.mjs';
import {runBatch} from '../benchmarks/batch.mjs';
import {writeBatchReports} from '../benchmarks/batch-report.mjs';
import {readLocalRegistry,planLocalRegistry,applyProjectRoleChecks} from './registry.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const args=process.argv.slice(2),command=args[0]??'check';
const option=name=>{const at=args.indexOf(`--${name}`);return at<0?undefined:args[at+1];};
const registry=option('registry')??join(root,'desktop','local-tests','mini-samples.example.json');

try{
  if(command==='check'||command==='run'){
    const local=readLocalRegistry(root,registry),plan=await planLocalRegistry(root,local);
    console.log(JSON.stringify({status:plan.skipped.length?'SKIPPED':'READY',available:plan.available.map(row=>row.role),skipped:plan.skipped,shaVerified:plan.available.length}));
    if(command==='run'){
      if(plan.available.length===0){console.log('[local-tests] No local GIM sources available; skipped');}
      else {
      const build=option('build');if(!build)throw Error('local-native-build-required');
      const privateRoot=artifactDirectory(root,join(root,'tmp','local-tests'));
      const selected=join(privateRoot,`selected-${Date.now()}.private.json`);
      writeFileSync(selected,JSON.stringify({version:'gim-batch-input-v1',samples:plan.available.map(({role,path,sourceSha256})=>({role,path,sourceSha256}))},null,2));
      const out=option('output')??join(root,'output','local-tests',`run-${Date.now()}`);
      const result=await runBatch({root,buildManifest:resolve(build),registry:selected,out,
        preset:option('preset')??'survey',repetitions:option('repetitions')?Number(option('repetitions')):undefined});
      if(applyProjectRoleChecks(result.result.rows,plan.available))result.result.outcome='FAIL';
      for(const row of plan.skipped)result.result.rows.push({inputId:`local-${row.role}`,sampleLabel:row.role,expectedRole:row.role,
        repetition:null,cacheState:'none',status:'SKIPPED',error:row.reason});
      if(plan.skipped.length&&result.result.outcome==='PASS')result.result.outcome='INCONCLUSIVE';
      if(result.result.outcome!=='PASS')result.result.baselineEligible=false;
      writeBatchReports(result.out,result.result);
      const executed=result.result.rows.filter(row=>row.status!=='SKIPPED'&&row.status!=='DUPLICATE');
      const allExecutedPassed=executed.length>0&&executed.every(row=>row.status==='PASS');
      console.log(JSON.stringify({status:result.result.status,outcome:result.result.outcome,report:join(result.out,'report.html')}));
      process.exitCode=allExecutedPassed?0:result.result.outcome==='FAIL'?1:2;
      }
    }
  }else throw Error('Use check | run --build <acceptance-build.json>');
}catch(error){console.error(`[local-tests] ${error.message}`);process.exitCode=1;}
