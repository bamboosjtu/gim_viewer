import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const quote=value=>`'${value.replaceAll("'","''")}'`;
test('survey wrapper passes distinct batch directories and stops before npm for invalid commits',{skip:process.platform!=='win32'},()=>{
  const parent=resolve('..','tmp','survey-tests');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'case-')),manifest=join(root,'acceptance-build.json'),calls=join(root,'calls.jsonl');
  writeFileSync(manifest,'{}');
  const wrapper=join(root,'wrapper.ps1');
  writeFileSync(wrapper,`param([string]$Commit)
$ErrorActionPreference = 'Stop'
function npm {
  $global:LASTEXITCODE = 0
  if ($args[-1] -eq 'build') { Write-Output ${quote(`Build manifest: ${manifest}`)}; return }
  ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath ${quote(calls)}
}
& ${quote(resolve('run-bench-survey.ps1'))} -Commit $Commit
`);
  const run=commit=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper,'-Commit',commit],
    {encoding:'utf8',windowsHide:true});
  const child=run('abcdef0');assert.equal(child.status,0,child.stderr);
  const rows=readFileSync(calls,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.equal(rows.length,3);
  const value=(row,name)=>row[row.indexOf(name)+1];
  assert.deepEqual(rows.map(row=>value(row,'--output')),['../output/substation-survey-abcdef0','../output/line-survey-abcdef0','../output/l0-survey-abcdef0']);
  for(const row of rows){assert.equal(value(row,'--build'),manifest);assert.equal(value(row,'--preset'),'baseline');}
  assert.ok(rows[0].includes('--registry')&&rows[1].includes('--registry')&&rows[2].includes('--directory'));
  assert.notEqual(run('../bad').status,0);assert.equal(readFileSync(calls,'utf8').trim().split(/\r?\n/).length,3);
});

for(const scenario of [
  {name:'allows native stderr warnings when the build and batches exit zero',buildExit:0,batchExit:0,batches:3},
  {name:'stops on a nonzero native build even if it printed a manifest',buildExit:7,batchExit:0,batches:0},
  {name:'stops remaining batches on a nonzero native batch',buildExit:0,batchExit:9,batches:1},
])test(`survey wrapper ${scenario.name}`,{skip:process.platform!=='win32'},()=>{
  const parent=resolve('..','tmp','survey-tests');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'native case-')),manifest=join(root,'acceptance-build.json'),calls=join(root,'calls.jsonl');
  writeFileSync(manifest,'{}');
  writeFileSync(join(root,'fake-npm.mjs'),`import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2),build=args.at(-1)==='build';
appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(build){
  console.error('[plugin:vite:reporter] native build warning');
  console.log(${JSON.stringify(`[acceptance] Build manifest: ${manifest}`)});
  process.exitCode=${scenario.buildExit};
}else{
  console.error('native batch diagnostic');
  process.exitCode=${scenario.batchExit};
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
    assert.match(child.stderr,new RegExp(scenario.buildExit?'Benchmark build failed with exit code 7':'Benchmark batch failed with exit code 9'));
  }else{
    assert.equal(child.status,0,child.stderr);
    assert.match(child.stdout,/native build warning/);
    assert.doesNotMatch(child.stderr,/NativeCommandError/);
  }
  const rows=readFileSync(calls,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.deepEqual(rows[0].filter(arg=>arg!=='--'),['run','bench','build']);assert.equal(rows.length,scenario.batches+1);
  for(const row of rows.slice(1))assert.equal(row[row.indexOf('--build')+1],manifest);
  if(scenario.batches===3)assert.equal(rows[3][rows[3].indexOf('--directory')+1],'..\\demo\\变电站通用设计模型\\');
});
