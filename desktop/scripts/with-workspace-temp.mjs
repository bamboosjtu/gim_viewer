import { spawnSync } from 'node:child_process';
import { workspaceTemp } from './test-workspace.mjs';
const entry = process.argv[2];
if (!entry) throw Error('A Node entrypoint is required');
const temporary = workspaceTemp();
const child = spawnSync(process.execPath, [entry, ...process.argv.slice(3)], {
  stdio: 'inherit', windowsHide: true,
  env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
});
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
