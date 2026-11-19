import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {createRequire} from 'node:module';
import {workspaceTemp} from './test-workspace.mjs';
const require=createRequire(import.meta.url),{createCoverageMap}=require('istanbul-lib-coverage');
const desktop=fileURLToPath(new URL('..',import.meta.url)),repo=resolve(desktop,'..'),temp=workspaceTemp();
for(const [cwd,extra] of [[resolve(repo,'packages/gim-sdk'),{GIM_COMBINED_COVERAGE:'1'}],[desktop,{GIM_SDK_COVERAGE_OWNED:'1'}]]){
 const child=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--coverage'],{cwd,stdio:'inherit',windowsHide:true,env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp,...extra}});
 if(child.error)throw child.error;
 if(child.status!==0){process.exitCode=child.status??1;break;}
}
if(!process.exitCode){
 const combined=createCoverageMap({}),scopes={};
 for(const scope of ['sdk','desktop']){
  const base=resolve(repo,`output/coverage/${scope}`),report=JSON.parse(readFileSync(resolve(base,'coverage-summary.json'),'utf8'));
  if(!report.total?.lines.total)throw Error(`Empty ${scope} coverage is not a passing gate`);
  scopes[scope]={files:Object.keys(report).length-1,...report.total};
  combined.merge(JSON.parse(readFileSync(resolve(base,'coverage-final.json'),'utf8')));
 }
 const summaries={total:combined.getCoverageSummary().toJSON()},groups={};
 for(const file of combined.files()){
  const coverage=combined.fileCoverageFor(file),path=relative(repo,file).replaceAll('\\','/');
  summaries[file]=coverage.toSummary().toJSON();
  const group=path.startsWith('packages/gim-sdk/src/engineering/')?'semantic':path.startsWith('packages/gim-sdk/src/gim/')?'source':path.startsWith('packages/gim-sdk/src/shared/')?'shared':null;
  if(group){groups[group]??=createCoverageMap({});groups[group].addFileCoverage(coverage);}
 }
 const gates={};let failed=false;
 for(const [name,minimum] of Object.entries({semantic:{statements:95,lines:95,functions:95,branches:90},source:{statements:90,lines:90,functions:90,branches:80},shared:{statements:90,lines:90,functions:90,branches:80}})){
  const summary=groups[name]?.getCoverageSummary().toJSON();
  if(!summary?.lines.total)throw Error(`Missing ${name} implementation coverage`);
  gates[name]=summary;
  for(const [metric,limit] of Object.entries(minimum))if(summary[metric].pct<limit){console.error(`${name} ${metric}: ${summary[metric].pct}% < ${limit}%`);failed=true;}
 }
 writeFileSync(resolve(repo,'output/coverage/coverage-summary.json'),JSON.stringify(summaries,null,2)+'\n');
 const largestModules=Object.entries(summaries).filter(([file])=>file!=='total')
  .sort(([left,a],[right,b])=>b.lines.total-a.lines.total||left.localeCompare(right)).slice(0,20)
  .map(([file,{lines,functions,branches}])=>({path:relative(repo,file).replaceAll('\\','/'),lines,functions,branches}));
 writeFileSync(resolve(repo,'output/coverage/summary.json'),JSON.stringify({contract:'gim-coverage-v1',scopes,gates,largestModules},null,2)+'\n');
 if(failed)process.exitCode=1;else console.log('SDK and desktop consumer coverage merged; original ownership thresholds passed.');
}
