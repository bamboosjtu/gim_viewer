import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,copyFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {summarizeSurvey,formatSurveySummary} from './survey-summary.mjs';
const quote=value=>`'${value.replaceAll("'","''")}'`;
function reportFixtures(root,outcomes=['PASS','PASS','PASS']){
  return outcomes.map((outcome,index)=>{
    const out=join(root,`report-${index}`);mkdirSync(out);
    const row={projectType:index===1?'transmission_line':'substation',sampleLabel:index===2?'220-test.gim':'110-test.gim',
      firstResponseMs:1000,firstGeometryMs:2000,allGeometryReadyMs:3000,settledMs:4000};
    writeFileSync(join(out,'results.json'),JSON.stringify({version:'gim-batch-results-v1',buildFingerprint:'fixture-build',status:'COMPLETE',outcome,
      rows:[{...row,cacheState:'cold',status:'PASS'},{...row,cacheState:'warm',status:outcome==='PASS'?'PASS':outcome}]}));
    return {status:'COMPLETE',outcome,csv:join(out,'results.csv'),html:join(out,'report.html')};
  });
}
test('survey wrapper passes distinct batch directories and stops before npm for invalid commits',{skip:process.platform!=='win32'},()=>{
  const parent=resolve('..','tmp','survey-tests');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'case-')),manifest=join(root,'acceptance-build.json'),calls=join(root,'calls.jsonl');
  writeFileSync(manifest,'{}');
  const completions=join(root,'completions.json');writeFileSync(completions,JSON.stringify(reportFixtures(root)));
  const wrapper=join(root,'wrapper.ps1');
  writeFileSync(wrapper,`param([string]$Commit)
$ErrorActionPreference = 'Stop'
function npm {
  $global:LASTEXITCODE = 0
  if ($args[-1] -eq 'build') { Write-Output ${quote(`Build manifest: ${manifest}`)}; return }
  ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath ${quote(calls)}
  $index = @(Get-Content -LiteralPath ${quote(calls)}).Count - 1
  $completions = Get-Content -LiteralPath ${quote(completions)} -Raw | ConvertFrom-Json
  $completions[$index] | ConvertTo-Json -Compress
}
& ${quote(resolve('run-bench-survey.ps1'))} -Commit $Commit
`);
  const run=commit=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper,'-Commit',commit],
    {encoding:'utf8',windowsHide:true});
  const child=run('abcdef0');assert.equal(child.status,0,child.stderr);
  const rows=readFileSync(calls,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.equal(rows.length,3);
  assert.match(child.stdout,/^\| PASS\s+\|\s+6 \|$/m);
  const value=(row,name)=>row[row.indexOf(name)+1];
  assert.deepEqual(rows.map(row=>value(row,'--output')),['../output/substation-survey-abcdef0','../output/line-survey-abcdef0','../output/l0-survey-abcdef0']);
  for(const row of rows){assert.equal(value(row,'--build'),manifest);assert.equal(value(row,'--preset'),'baseline');}
  assert.ok(rows[0].includes('--registry')&&rows[1].includes('--registry')&&rows[2].includes('--directory'));
  assert.notEqual(run('../bad').status,0);assert.equal(readFileSync(calls,'utf8').trim().split(/\r?\n/).length,3);
});

for(const scenario of [
  {name:'allows native stderr warnings when the build and batches exit zero',buildExit:0,batchExit:0,batches:3},
  {name:'completes and summarizes FAIL, INCONCLUSIVE and PARTIAL batches',buildExit:0,batchExit:0,batches:3,outcomes:['FAIL','INCONCLUSIVE','PARTIAL']},
  {name:'stops on a nonzero native build even if it printed a manifest',buildExit:7,batchExit:0,batches:0},
  {name:'stops remaining batches when native execution fails',buildExit:0,batchExit:9,batches:1},
])test(`survey wrapper ${scenario.name}`,{skip:process.platform!=='win32'},()=>{
  const parent=resolve('..','tmp','survey-tests');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'native case-')),manifest=join(root,'acceptance-build.json'),calls=join(root,'calls.jsonl');
  writeFileSync(manifest,'{}');
  const completions=join(root,'completions.json');writeFileSync(completions,JSON.stringify(reportFixtures(root,scenario.outcomes)));
  writeFileSync(join(root,'fake-npm.mjs'),`import {appendFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2),build=args.at(-1)==='build';
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(build){
  console.error('[plugin:vite:reporter] native build warning');
  console.log(${JSON.stringify(`[acceptance] Build manifest: ${manifest}`)});
  process.exitCode=${scenario.buildExit};
}else{
  console.error('native batch diagnostic');
  const index=readFileSync(${JSON.stringify(calls)},'utf8').trim().split('\\n').length-2;
  const completion=JSON.parse(readFileSync(${JSON.stringify(completions)},'utf8'))[index];
  console.log(JSON.stringify(completion));
  process.exitCode=${scenario.batchExit}||({PASS:0,PARTIAL:0,FAIL:1,INCONCLUSIVE:2})[completion.outcome];
}
`);
  // Exercise the real native stderr path through a PowerShell npm shim.
  writeFileSync(join(root,'npm.ps1'),`\uFEFF& ${quote(process.execPath)} (Join-Path $PSScriptRoot 'fake-npm.mjs') @args
exit $LASTEXITCODE
`);
  const wrapper=join(root,'wrapper.ps1');
  writeFileSync(wrapper,`\uFEFF$ErrorActionPreference = 'Stop'
$env:PATH = ${quote(root)} + [IO.Path]::PathSeparator + $env:PATH
& ${quote(resolve('run-bench-survey.ps1'))} -Commit 'abcdef0'
`);
  const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper],
    {encoding:'utf8',windowsHide:true});
  if(scenario.buildExit||scenario.batchExit){
    assert.notEqual(child.status,0);
    assert.match(child.stderr,new RegExp(scenario.buildExit?'Benchmark build failed with exit code 7':'Benchmark batch did not complete normally \\(exit code 9\\)'));
  }else{
    assert.equal(child.status,0,child.stderr);
    assert.match(child.stdout,/native build warning/);
    assert.doesNotMatch(child.stderr,/NativeCommandError/);
    assert.ok(child.stdout.includes('最短 - 最长'));assert.ok(child.stdout.includes('首次响应'));assert.ok(child.stdout.includes('首次几何'));
    assert.ok(child.stdout.includes('基础几何齐备'));assert.ok(child.stdout.includes('完全结算'));
    if(scenario.outcomes){assert.match(child.stdout,/^\| FAIL\s+\|\s+1 \|$/m);assert.match(child.stdout,/^\| INCONCLUSIVE\s+\|\s+1 \|$/m);
      assert.match(child.stdout,/^\| PARTIAL\s+\|\s+1 \|$/m);assert.match(child.stdout,/^\| PASS\s+\|\s+3 \|$/m);}
  }
  const rows=readFileSync(calls,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.deepEqual(rows[0].filter(arg=>arg!=='--'),['run','bench','build']);assert.equal(rows.length,scenario.batches+1);
  for(const row of rows.slice(1))assert.equal(row[row.indexOf('--build')+1],manifest);
  if(scenario.batches===3)assert.equal(rows[3][rows[3].indexOf('--directory')+1],'..\\demo\\变电站通用设计模型\\');
});

for(const partialExport of [false,true])test(`survey recovers interrupted L0 (${partialExport?'partial export':'profile only'}) and keeps the failure visible`,{skip:process.platform!=='win32'},()=>{
  const parent=resolve('..','tmp','survey-tests');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'interrupted-')),desktop=join(root,'desktop'),scripts=join(desktop,'scripts');
  mkdirSync(join(scripts,'benchmarks'),{recursive:true});
  copyFileSync(resolve('run-bench-survey.ps1'),join(desktop,'run-bench-survey.ps1'));
  copyFileSync(resolve('scripts/with-workspace-temp.mjs'),join(scripts,'with-workspace-temp.mjs'));
  copyFileSync(resolve('scripts/test-workspace.mjs'),join(scripts,'test-workspace.mjs'));
  const manifest=join(root,'acceptance-build.json'),record=join(root,'recovery.json');writeFileSync(manifest,'{}');
  writeFileSync(join(scripts,'benchmarks/cli.mjs'),`import{writeFileSync}from'node:fs';import{join}from'node:path';
const args=process.argv.slice(2),out=args[args.indexOf('--output')+1];
writeFileSync(${JSON.stringify(record)},JSON.stringify({args,temp:process.env.TEMP,out}));
writeFileSync(join(out,'results.csv'),'status\\nCANCELLED\\n');writeFileSync(join(out,'report.html'),'CANCELLED');
console.log(JSON.stringify({outcome:'INCONCLUSIVE',status:'CANCELLED',recovered:1}));
`);
  const wrapper=join(root,'wrapper.ps1');writeFileSync(wrapper,`\uFEFF$global:batchCount=0
function npm {
 $global:LASTEXITCODE=0
 if($args[-1] -eq 'build'){Write-Output ${quote(`Build manifest: ${manifest}`)};return}
 $global:batchCount++
 $out=[IO.Path]::GetFullPath((Join-Path (Get-Location).Path $args[[Array]::IndexOf($args,'--output')+1]))
 if($global:batchCount -lt 3){[pscustomobject]@{status='COMPLETE';outcome='PASS';csv=(Join-Path $out 'results.csv')}|ConvertTo-Json -Compress;return}
 New-Item -ItemType Directory -Force -Path $out|Out-Null
 '{}'|Set-Content -LiteralPath (Join-Path $out 'profile.json')
 ${partialExport?`'partial'|Set-Content -LiteralPath (Join-Path $out 'results.csv')
 'RUNNING'|Set-Content -LiteralPath (Join-Path $out 'report.html')
 '{"reportReady":false}'|Set-Content -LiteralPath (Join-Path $out 'status.json')`:''}
 $global:LASTEXITCODE=9
}
& ${quote(join(desktop,'run-bench-survey.ps1'))} -Commit 'abcdef0'
`);
  const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper],{encoding:'utf8',windowsHide:true});
  assert.notEqual(child.status,0);assert.match(child.stderr,/did not complete normally/);
  assert.ok(existsSync(record),child.stdout+'\n'+child.stderr);
  const recovery=JSON.parse(readFileSync(record,'utf8'));
  assert.equal(recovery.args[0],'recover-batch');assert.ok(!recovery.args.includes('--force'));
  assert.equal(recovery.out,join(root,'output','l0-survey-abcdef0'));
  assert.ok(recovery.temp.startsWith(join(root,'tmp')));
  assert.match(readFileSync(join(recovery.out,'results.csv'),'utf8'),/CANCELLED/);
  assert.match(child.stdout,/Recovering its durable checkpoint/);
});

test('survey ranges separate project type, voltage and cold/warm, excluding failures and missing times',()=>{
  const base={projectType:'substation',sampleLabel:'110-A.gim',cacheState:'cold',status:'PASS',
    firstResponseMs:1000,firstGeometryMs:2000,allGeometryReadyMs:3000,settledMs:4000};
  const report={version:'gim-batch-results-v1',status:'COMPLETE',rows:[base,
    {...base,status:'PARTIAL',firstResponseMs:1500,firstGeometryMs:null,allGeometryReadyMs:5000,settledMs:6000},
    {...base,status:'FAIL',firstResponseMs:1,allGeometryReadyMs:1,settledMs:1},
    {...base,cacheState:'warm',firstResponseMs:100},
    {...base,sampleLabel:'220-B.gim',firstResponseMs:9000},
    {...base,sampleLabel:'substation01.gim'},
    {...base,projectType:'transmission_line',sampleLabel:'110-line.gim',firstGeometryMs:null,allGeometryReadyMs:null}]};
  const summary=summarizeSurvey([{projectType:'substation',report}]),cold=summary.groups[0];
  assert.equal(summary.groups.length,5);assert.equal(cold.voltageKv,110);assert.equal(cold.valid,2);assert.equal(cold.total,3);
  assert.deepEqual(cold.metrics.firstResponseMs,{min:1000,max:1500,count:2});
  assert.deepEqual(cold.metrics.firstGeometryMs,{min:2000,max:2000,count:1});
  assert.deepEqual(cold.metrics.allGeometryReadyMs,{min:3000,max:5000,count:2});
  assert.deepEqual(cold.metrics.settledMs,{min:4000,max:6000,count:2});
  assert.equal(summary.groups.find(group=>group.cacheState==='warm').metrics.firstResponseMs.min,100);
  assert.ok(summary.groups.some(group=>group.projectType==='substation'&&group.voltageKv===null));
  const line=summary.groups.find(group=>group.projectType==='transmission_line');
  assert.equal(line.voltageKv,null);assert.equal(line.metrics.firstGeometryMs.count,0);
  const output=formatSurveySummary(summary);
  assert.match(output,/线路\n/);
  assert.match(output,/\| 冷启动\s+\|\s+1\/1 \|\s+1\.000 - 1\.000 \|\s+- \|\s+- \|\s+4\.000 - 4\.000 \|/);
  // Independent display-cell check: these tables use only ASCII and CJK.
  // Every vertical separator must share a column with its border junction.
  for(const table of output.split('\n\n').filter(block=>block.startsWith('+'))){
    const lines=table.split('\n'),columns=[...lines[0]].flatMap((char,index)=>char==='+'?[index]:[]);
    for(const line of lines.filter(value=>value.startsWith('|'))){
      let column=0;const separators=[];
      for(const char of line){if(char==='|')separators.push(column);column+=char.codePointAt(0)>127?2:1;}
      assert.deepEqual(separators,columns);
    }
  }
  assert.throws(()=>summarizeSurvey([{projectType:'substation',report:{...report,status:'RUNNING'}}]),/completed/);
});
