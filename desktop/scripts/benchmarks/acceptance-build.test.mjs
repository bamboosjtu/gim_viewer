import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ACCEPTANCE_IDENTIFIER, verifyAcceptanceDatabasePath, sourceFingerprint} from './acceptance-build.mjs';

test('native database verification rejects normal, sibling, traversal and relative paths', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gim-acceptance-path-')), root = join(parent, ACCEPTANCE_IDENTIFIER);
  try {
    mkdirSync(root); writeFileSync(join(root, 'gim_cache.db'), 'path fixture');
    assert.equal(verifyAcceptanceDatabasePath(join(root, 'gim_cache.db'), root), join(root, 'gim_cache.db'));
    for (const path of [join(parent, 'com.bamboosjtu.gimviewer', 'gim_cache.db'),
      join(root + '-other', 'gim_cache.db'), join(root, '..', 'gim_cache.db'), 'gim_cache.db']) {
      assert.throws(() => verifyAcceptanceDatabasePath(path, root));
    }
    const linkedParent = join(parent, 'links'); mkdirSync(linkedParent);
    const normal = join(parent, 'com.bamboosjtu.gimviewer'); mkdirSync(normal);
    writeFileSync(join(normal, 'gim_cache.db'), 'normal-cache fixture');
    const alias = join(linkedParent, ACCEPTANCE_IDENTIFIER);
    symlinkSync(normal, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => verifyAcceptanceDatabasePath(join(alias, 'gim_cache.db'), alias), /resolves/);
  } finally {
    assert.ok(parent.startsWith(join(tmpdir(), 'gim-acceptance-path-')));
    rmSync(parent, {recursive: true, force: true});
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
