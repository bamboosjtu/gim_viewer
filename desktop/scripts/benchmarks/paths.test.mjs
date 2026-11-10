import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,symlinkSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {artifactFile,isPublicArtifact} from './batch-input.mjs';

function setup(){const parent=resolve('..','tmp','benchmark-path-tests');mkdirSync(parent,{recursive:true});
  const root=mkdtempSync(join(parent,'case-'));mkdirSync(join(root,'tmp'));return root;}

test('artifact visibility follows the workspace domain and includes output root',()=>{
  const root=setup();
  for(const path of [join(root,'output'),join(root,'output','report')])assert.equal(isPublicArtifact(root,path),true);
  assert.equal(isPublicArtifact(root,join(root,'tmp','output','private')),false);
  assert.throws(()=>isPublicArtifact(root,join(root,'..','output')),/outside/);
});
test('output validation creates missing parents, accepts regular files and rejects workspace/source paths',()=>{
  const root=setup(),path=join(root,'output','new','comparison.json');
  assert.equal(artifactFile(root,path),path);assert.equal(existsSync(path),false);
  writeFileSync(path,'old');assert.equal(artifactFile(root,path),path);
  for(const invalid of [join(root,'source.json'),join(root,'output'),join(root,'..','outside.json')])
    assert.throws(()=>artifactFile(root,invalid));
  assert.equal(readFileSync(path,'utf8'),'old');
});
test('output validation rejects parent and leaf junctions including dangling links',()=>{
  const root=setup(),outside=setup(),link=join(root,'tmp','linked');
  symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>artifactFile(root,join(link,'new','comparison.json')),/links/);
  assert.equal(existsSync(join(outside,'new')),false);
  const leaf=join(root,'tmp','comparison.json');
  symlinkSync(join(outside,'missing'),leaf,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>artifactFile(root,leaf),/link/);
});
test('compare and gate can create a new report and preserve their outcome exit code',()=>{
  const root=setup();
  for(const command of ['compare','gate']){
    const baseline=join(root,'tmp','baseline.json'),candidate=join(root,'tmp','candidate.json');
    writeFileSync(baseline,JSON.stringify({runs:[]}));writeFileSync(candidate,JSON.stringify({runs:[]}));
    const output=join(root,'output',command,'comparison.json');
    const child=spawnSync(process.execPath,['scripts/benchmarks/cli.mjs',command,'--baseline',baseline,'--candidate',candidate,'--output',output],
      {encoding:'utf8',windowsHide:true});
    assert.equal(child.status,2,child.stderr);assert.equal(JSON.parse(readFileSync(output,'utf8')).outcome,'INCONCLUSIVE');
  }
});
