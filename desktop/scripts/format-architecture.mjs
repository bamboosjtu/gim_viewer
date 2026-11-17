import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The same bounded adoption scope drives Prettier and type-checked ESLint.
export const architectureModules = [
  'src/utils/logger.ts',
  'src/utils/backgroundErrors.ts',
  'src/shared/projectViewState.ts',
  'src/shared/sourceGeometryState.ts',
  'src/shared/ifcLoadingState.ts',
  'src/services/ifcSelectionProjection.ts',
  'src/services/*PresentationPort.ts',
  'src/services/sourceGeometryService.ts',
  'src/services/projectPropertyCache.ts',
  'src/services/lineAttrRestoreService.ts',
];
export const formattedArchitectureModules = [...architectureModules, 'src/app/state.ts'];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--write') ? '--write' : '--check';
  const child = spawnSync(process.execPath, [
    'node_modules/prettier/bin/prettier.cjs', mode, ...formattedArchitectureModules,
  ], { stdio: 'inherit', windowsHide: true, env: process.env });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
