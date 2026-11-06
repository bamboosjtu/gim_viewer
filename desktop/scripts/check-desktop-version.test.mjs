import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import {workspaceTemp as tmpdir} from './test-workspace.mjs';
import { basename, dirname, join, resolve } from 'node:path';
import { checkDesktopVersion, validateDesktopVersions, validateTauriRuntimeVersions } from './check-desktop-version.mjs';

test('the real desktop manifests agree, including Tauri package.json indirection', () => {
  assert.equal(checkDesktopVersion(), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('rejects stale Tauri, npm lock or Cargo release metadata with the offending filename', () => {
  const correct = { 'package.json': '0.2.0', 'tauri.conf.json': '0.2.0', 'package-lock.json': '0.2.0', 'Cargo.toml': '0.2.0', 'Cargo.lock': '0.2.0', 'gim-viewer.exe ProductVersion': '0.2.0' };
  for (const file of Object.keys(correct).filter(file => file !== 'package.json')) {
    assert.throws(() => validateDesktopVersions({ ...correct, [file]: '0.1.3' }), error => error.message.includes(file) && error.message.includes('0.1.3'));
  }
  assert.throws(() => validateDesktopVersions({ ...correct, 'Cargo.lock': undefined }), /缺失/);
});

test('allows Tauri patch differences and rejects an incompatible locked or installed API', () => {
  const compatible = { 'Cargo.lock tauri': '2.11.3', 'package-lock.json @tauri-apps/api': '2.11.1', 'node_modules @tauri-apps/api': '2.11.1' };
  assert.doesNotThrow(() => validateTauriRuntimeVersions(compatible));
  for (const file of ['package-lock.json @tauri-apps/api', 'node_modules @tauri-apps/api']) {
    assert.throws(() => validateTauriRuntimeVersions({ ...compatible, [file]: '2.12.4' }), error => error.message.includes(file) && error.message.includes('2.12.4'));
  }
});

test('resolves release metadata from the desktop root, independently of current working directory', () => {
  const tempRoot = resolve(tmpdir()), root = mkdtempSync(join(tempRoot, 'gim-version-test-'));
  try {
    mkdirSync(join(root, 'src-tauri'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.8.7' }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '9.8.7', packages: { '': { version: '9.8.7' }, 'node_modules/@tauri-apps/api': { version: '2.11.1' } } }));
    writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '../package.json' }));
    writeFileSync(join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "gim-viewer"\nversion = "9.8.7"\n\n[dependencies]\nexample = "0.1.0"\n');
    writeFileSync(join(root, 'src-tauri/Cargo.lock'), 'version = 4\n\n[[package]]\nname = "dependency"\nversion = "1.0.0"\n\n[[package]]\nname = "gim-viewer"\nversion = "9.8.7"\n\n[[package]]\nname = "tauri"\nversion = "2.11.3"\n');
    assert.equal(checkDesktopVersion(root), '9.8.7');
    writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.1.3' }));
    assert.throws(() => checkDesktopVersion(root), /tauri.conf.json=0.1.3/);
  } finally {
    assert.equal(dirname(resolve(root)), tempRoot);
    assert.ok(basename(root).startsWith('gim-version-test-'));
    rmSync(root, { recursive: true, force: true });
  }
});
