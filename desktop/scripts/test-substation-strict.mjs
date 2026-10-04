import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(),'gim-strict-report-'));
const report = join(dir,'report.json');
let code = 1;
try {
  const run = spawnSync(process.execPath,[
    'node_modules/vitest/vitest.mjs','run','--config','vitest.strict-substation.config.ts',
    '--reporter=default','--reporter=json',`--outputFile.json=${report}`,...process.argv.slice(2),
  ],{stdio:'inherit'});
  if (run.status === 0 && existsSync(report)) {
    const results = JSON.parse(readFileSync(report,'utf8'));
    const assertions = results.testResults.flatMap((suite) => suite.assertionResults);
    const missing = ['substation01','substation02','substation03'].filter((id) => !assertions.some((a) =>
      a.fullName.includes(`STRICT ${id}:`) && a.status === 'passed'));
    if (missing.length) console.error(`Strict gate failed: required sample test missing, failed or skipped: ${missing.join(', ')}`);
    else { console.info('Strict required samples 01/02/03: passed with zero required skips'); code=0; }
  }
} finally { rmSync(dir,{recursive:true,force:true}); }
process.exitCode=code;
