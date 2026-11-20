import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceTemp } from './test-workspace.mjs';
import { changedProductionSources, formattedArchitectureModules, unadoptedProductionSources } from './format-architecture.mjs';

test('changed desktop, bridge and SDK production sources must join the shared list', () => {
  assert.deepEqual(unadoptedProductionSources([
    'packages/gim-sdk/src/new.ts',
    'packages/gim-sdk/src/shared/sourceRecord.ts',
    'packages/gim-sdk/src/shared/__tests__/sourceRecord.test.ts',
    'desktop/src/app/bootstrap.ts',
    'desktop/src/services/newPresentationPort.ts',
    'desktop/src/services/linePresentationPort.ts',
    'desktop/bridge/nativeExtension.ts',
    'desktop/bridge/__tests__/helper.ts',
    'desktop/src/adapter.test.ts',
  ]), ['desktop/bridge/nativeExtension.ts','desktop/src/app/bootstrap.ts',
    'desktop/src/services/newPresentationPort.ts','packages/gim-sdk/src/new.ts']);
});

function gitFixture(autocrlf = 'true') {
  const folder = mkdtempSync(join(workspaceTemp(), 'windows-format-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', `core.autocrlf=${autocrlf}`, ...args], {
      cwd: folder, encoding: 'utf8', windowsHide: true, env: process.env,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const template=join(folder,'empty-template');mkdirSync(template);
  git('init', '--quiet', '--template='+template);
  return {folder,git};
}

test('incremental scope finds committed, renamed and untracked files against the selected Git base', () => {
  const {folder,git}=gitFixture('false');
  for (const dir of ['desktop/src','desktop/bridge','packages/gim-sdk/src']) mkdirSync(join(folder,dir),{recursive:true});
  writeFileSync(join(folder,'desktop/src/old.ts'),'export const value = 1;\r\n');
  writeFileSync(join(folder,'packages/gim-sdk/src/retired.ts'),'export {};\r\n');
  git('add','--','.');
  const commit=(message)=>git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm',message);
  commit('base');
  const base=git('rev-parse','HEAD');
  git('mv','desktop/src/old.ts','desktop/src/新文件.ts');
  git('rm','-q','packages/gim-sdk/src/retired.ts');
  writeFileSync(join(folder,'desktop/bridge/entry.ts'),'export {};\r\n');
  git('add','--','.');
  commit('changed');
  mkdirSync(join(folder,'packages/gim-sdk/src'),{recursive:true});
  writeFileSync(join(folder,'packages/gim-sdk/src/untracked.ts'),'export {};\r\n');
  assert.deepEqual(unadoptedProductionSources(changedProductionSources(folder,base)),[
    'desktop/bridge/entry.ts','desktop/src/新文件.ts','packages/gim-sdk/src/untracked.ts',
  ]);
  assert.deepEqual(changedProductionSources(folder),['packages/gim-sdk/src/untracked.ts']);
  assert.throws(()=>changedProductionSources(folder,'--staged'),/Git commit SHA/);
});

test('Git and Prettier agree on CRLF, with explicit build-tool exceptions', async () => {
  const {folder,git}=gitFixture();
  writeFileSync(join(folder, '.gitattributes'), readFileSync(resolve('../.gitattributes')));
  writeFileSync(join(folder, '.editorconfig'), readFileSync(resolve('../.editorconfig')));
  mkdirSync(join(folder, 'desktop'));
  writeFileSync(join(folder, 'desktop/.prettierrc.json'), readFileSync(resolve('.prettierrc.json')));
  const paths = formattedArchitectureModules.map(path => path.startsWith('../') ? path.slice(3) : 'desktop/' + path);
  const lf = new Map([
    ['desktop/src-tauri/Cargo.toml', '[package]\nname = "fixture"\n'],
    ['app/src-tauri/gen/android/gradlew', '#!/bin/sh\nexit 0\n'],
  ]);
  const crlf = new Map([
    ...paths.map(path => [path, 'export const value = 1;\n']),
    ['tools/example.ps1', 'Write-Output "ok"\n'],
    ['tools/gim_blender/engine/snapshot/example.ts', 'export const value = 1;\n'],
  ]);
  const binary = Buffer.from([0, 13, 10, 255]);
  const fixtures = new Map([...crlf, ...lf, ['fixture.bin', binary]]);
  for (const [path, content] of fixtures) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
  git('add', '--', '.');
  for (const path of fixtures.keys()) {
    const target=resolve(folder,path);assert.ok(target.startsWith(folder+sep));unlinkSync(target);
  }
  git('checkout-index', '--all', '--force');
  for (const [path, content] of crlf) assert.equal(readFileSync(join(folder, path), 'utf8'), content.replaceAll('\n', '\r\n'), path);
  for (const [path, content] of lf) assert.equal(readFileSync(join(folder, path), 'utf8'), content, path);
  assert.deepEqual(readFileSync(join(folder, 'fixture.bin')), binary);

  const prettier = await import('prettier');
  for (const path of ['desktop/src/app/state.ts', 'packages/gim-sdk/src/shared/designation.ts']) {
    const filepath = join(folder, path);
    const config = await prettier.resolveConfig(filepath, {editorconfig:true});
    assert.equal(await prettier.check(readFileSync(filepath, 'utf8'), {...config, filepath}), true, path);
  }
});

test('adopted modules enforce type-checked rules and route logs through the shared sink', async () => {
  const { ESLint } = await import('eslint');
  const { architectureModules } = await import('./format-architecture.mjs');
  const eslint = new ESLint({ cwd: resolve('..') });
  for (const pattern of architectureModules) {
    const path = pattern.startsWith('../') ? pattern.slice(3) : 'desktop/' + pattern;
    const config = await eslint.calculateConfigForFile(path);
    assert.equal(config.rules['@typescript-eslint/no-unsafe-assignment'][0], 2, path);
    if (path !== 'desktop/src/utils/logger.ts') assert.equal(config.rules['no-console'][0], 2, path);
  }
});
