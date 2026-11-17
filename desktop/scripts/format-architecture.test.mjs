import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceTemp } from './test-workspace.mjs';
import { formattedArchitectureModules } from './format-architecture.mjs';

test('formatter scope survives a Git checkout with core.autocrlf=true', () => {
  const folder = mkdtempSync(join(workspaceTemp(), 'windows-format-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.autocrlf=true', ...args], {
      cwd: folder, encoding: 'utf8', windowsHide: true, env: process.env,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const template=join(folder,'empty-template');mkdirSync(template);
  git('init', '--quiet', '--template='+template);
  writeFileSync(join(folder, '.gitattributes'), readFileSync(resolve('../.gitattributes')));
  const paths = formattedArchitectureModules.map(path => 'desktop/' + path.replace('*', 'selection'));
  for (const path of paths) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), 'export const value = 1;\n');
  }
  const powershell = 'tools/example.ps1';
  mkdirSync(dirname(join(folder, powershell)), { recursive: true });
  writeFileSync(join(folder, powershell), 'Write-Output "ok"\n');
  git('add', '--', '.');
  for(const path of [...paths,powershell]){
    const target=resolve(folder,path);assert.ok(target.startsWith(folder+sep));unlinkSync(target);
  }
  git('checkout-index', '--all', '--force');
  for (const path of paths) assert.equal(readFileSync(join(folder, path), 'utf8'), 'export const value = 1;\n', path);
  assert.equal(readFileSync(join(folder, powershell), 'utf8'), 'Write-Output "ok"\r\n');
});

test('adopted modules enforce type-checked rules and route logs through the shared sink', async () => {
  const { ESLint } = await import('eslint');
  const { architectureModules } = await import('./format-architecture.mjs');
  const eslint = new ESLint();
  for (const pattern of architectureModules) {
    const path = pattern.replace('*', 'selection');
    const config = await eslint.calculateConfigForFile(path);
    assert.equal(config.rules['@typescript-eslint/no-unsafe-assignment'][0], 2, path);
    if (path !== 'src/utils/logger.ts') assert.equal(config.rules['no-console'][0], 2, path);
  }
});
