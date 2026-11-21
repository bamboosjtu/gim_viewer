import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import coverage from 'istanbul-lib-coverage';
import { BaseCoverageProvider } from 'vitest/coverage';
import { loadConfigFromFile } from 'vite';

const { createCoverageMap } = coverage;
const files = ['substationRuntime', 'substationOpenStages', 'substationColdPersistence', 'substationColdSource']
  .map(name => resolve('src/features/substation/application', `${name}.ts`));

function coveredFile(path, hits) {
  const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
  return {
    path,
    statementMap: { 0: location },
    fnMap: { 0: { name: 'open', decl: location, loc: location, line: 1 } },
    branchMap: { 0: { type: 'if', locations: [location, location], loc: location, line: 1 } },
    s: { 0: hits },
    f: { 0: hits },
    b: { 0: [hits, hits] },
  };
}

test('the original substation thresholds include coverage from every extracted application module', async () => {
  const provider = new BaseCoverageProvider();
  const coverageMap = createCoverageMap(Object.fromEntries(
    files.map((file, index) => [file, coveredFile(file, index < 2 ? 1 : 0)]),
  ));
  const { config } = await loadConfigFromFile({ command: 'serve', mode: 'test' }, 'vitest.config.ts');
  const { thresholds } = config.test.coverage;
  const resolved = provider.resolveThresholds({ coverageMap, thresholds, createCoverageMap, root: process.cwd() });
  const gate = resolved.find(group => group.coverageMap.files().length > 0 &&
    group.coverageMap.files().includes(coverageMap.files()[0]));
  assert.deepEqual(gate?.coverageMap.files(), coverageMap.files());
  assert.deepEqual(gate?.thresholds, { statements: 70, lines: 70, functions: 45, branches: 70 });

  const originalExitCode = process.exitCode;
  const errors = [];
  try {
    provider.checkThresholds({ thresholds: [gate], perFile: false, onError: error => errors.push(error) });
  } finally {
    process.exitCode = originalExitCode;
  }
  assert.deepEqual(
    errors.map(error => error.match(/Coverage for (\w+)/)?.[1]).sort(),
    ['branches', 'lines', 'statements'],
  );
});
