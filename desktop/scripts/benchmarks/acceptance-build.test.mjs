import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync,unlinkSync} from 'node:fs';
import {workspaceTemp as tmpdir} from '../test-workspace.mjs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ACCEPTANCE_IDENTIFIER, verifyAcceptanceDatabasePath, sourceFingerprint,sourceSnapshot,assertSourceUnchanged,prepareTauriManifest} from './acceptance-build.mjs';

test('native database verification rejects normal, sibling, traversal and relative paths', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gim-acceptance-path-')), root = join(parent, ACCEPTANCE_IDENTIFIER);
  try {
    mkdirSync(root); writeFileSync(join(root, 'gim_cache_schema_v1.db'), 'path fixture');
    assert.equal(verifyAcceptanceDatabasePath(join(root, 'gim_cache_schema_v1.db'), root), join(root, 'gim_cache_schema_v1.db'));
    for (const path of [join(parent, 'com.bamboosjtu.gimviewer', 'gim_cache_schema_v1.db'),
      join(root + '-other', 'gim_cache_schema_v1.db'), join(root, '..', 'gim_cache_schema_v1.db'), 'gim_cache_schema_v1.db']) {
      assert.throws(() => verifyAcceptanceDatabasePath(path, root));
    }
    const linkedParent = join(parent, 'links'); mkdirSync(linkedParent);
    const normal = join(parent, 'com.bamboosjtu.gimviewer'); mkdirSync(normal);
    writeFileSync(join(normal, 'gim_cache_schema_v1.db'), 'normal-cache fixture');
    const alias = join(linkedParent, ACCEPTANCE_IDENTIFIER);
    symlinkSync(normal, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => verifyAcceptanceDatabasePath(join(alias, 'gim_cache_schema_v1.db'), alias), /resolves/);
  } finally {
    assert.ok(parent.startsWith(join(tmpdir(), 'gim-acceptance-path-')));
    rmSync(parent, {recursive: true, force: true});
  }
});

test('Windows checkout keeps the Tauri manifest stable when the CLI writes LF',()=>{
  const root=mkdtempSync(join(tmpdir(),'gim-acceptance-eol-'));
  const cargo=join(root,'desktop/src-tauri/Cargo.toml');
  try{
    const git=(...args)=>{const result=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);};
    git('init','--quiet');git('config','core.autocrlf','true');
    mkdirSync(join(root,'desktop/src-tauri'),{recursive:true});
    const attributes=readFileSync(new URL('../../../.gitattributes',import.meta.url),'utf8');
    writeFileSync(join(root,'.gitattributes'),attributes);
    const manifest='[package]\nname = "fixture"\nversion = "0.2.4"\n';
    writeFileSync(cargo,manifest.replaceAll('\n','\r\n'));
    git('add','.');unlinkSync(cargo);git('checkout-index','--force','--all');
    assert.equal(readFileSync(cargo,'utf8'),manifest);
    assert.equal(prepareTauriManifest(root),false);
    // Also support a pre-existing CRLF checkout without discarding user edits.
    const edited=manifest+'description = "local edit"\n';
    writeFileSync(cargo,edited.replaceAll('\n','\r\n'));
    assert.equal(prepareTauriManifest(root),true);
    assert.equal(readFileSync(cargo,'utf8'),edited);
    const before=sourceSnapshot(root);
    writeFileSync(cargo,readFileSync(cargo,'utf8').replaceAll('\r\n','\n'));
    assert.doesNotThrow(()=>assertSourceUnchanged(before,sourceSnapshot(root)));
    assert.equal(sourceFingerprint(root),before.fingerprint);
    writeFileSync(cargo,edited.replace('0.2.4','0.2.5'));
    assert.throws(()=>assertSourceUnchanged(before,sourceSnapshot(root)),/Changed files: desktop\/src-tauri\/Cargo\.toml/);
  }finally{
    assert.ok(root.startsWith(join(tmpdir(),'gim-acceptance-eol-')));
    rmSync(root,{recursive:true,force:true});
  }
});

test('source fingerprint includes changed tracked and new source files, excludes ignored build output', () => {
  const root = mkdtempSync(join(tmpdir(), 'gim-acceptance-source-'));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
    mkdirSync(join(root, 'desktop')); writeFileSync(join(root, '.gitignore'), '*.output\n');
    writeFileSync(join(root, 'desktop', 'a.ts'), 'one');
    assert.equal(spawnSync('git', ['-C', root, 'add', '.']).status, 0);
    const first = sourceFingerprint(root);
    writeFileSync(join(root, 'desktop', 'a.ts'), 'two'); assert.notEqual(sourceFingerprint(root), first);
    const second = sourceFingerprint(root);
    writeFileSync(join(root, 'desktop', 'b.ts'), 'new'); assert.notEqual(sourceFingerprint(root), second);
    const third = sourceFingerprint(root);
    writeFileSync(join(root, 'desktop', 'b.output'), 'generated'); assert.equal(sourceFingerprint(root), third);
  } finally {
    // Exact mkdtemp fixture; never a project or application cache directory.
    assert.ok(root.startsWith(join(tmpdir(), 'gim-acceptance-source-')));
    rmSync(root, {recursive: true, force: true});
  }
});
