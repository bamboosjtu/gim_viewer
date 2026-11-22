import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspaceTemp } from './test-workspace.mjs';
import {
  architectureModules,
  scriptTestFiles,
  typescriptSourceRoots,
} from './format-architecture.mjs';
const temp = workspaceTemp();
const child = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/eslint/bin/eslint.js', import.meta.url)),
    ...typescriptSourceRoots,
    'app/tests',
    scriptTestFiles,
    ...architectureModules
      .map((path) => (path.startsWith('../') ? path.slice(3) : `desktop/${path}`))
      .filter(
        (path) =>
          !typescriptSourceRoots.some((root) => path.startsWith(`${root}/`)) ||
          /\.[cm]?js$/.test(path),
      ),
  ],
  {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
  },
);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
