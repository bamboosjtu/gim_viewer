import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The same bounded adoption scope drives Prettier and type-checked ESLint.
export const architectureModules = [
  'src/app/state.ts',
  'src/shared/projectSelectionState.ts',
  'src/shared/ifcRuntimeState.ts',
  'src/shared/runtimeSlot.ts',
  'src/shared/sessionScope.ts',
  'src/shared/viewerState.ts',
  'src/shared/selectionContracts.ts',
  'src/services/selectionVisibility.ts',
  'src/services/ifcNameIndex.ts',
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
  '../packages/gim-sdk/src/shared/designation.ts',
  '../packages/gim-sdk/src/shared/sourceRecord.ts',
  '../packages/gim-sdk/src/shared/representationAddresses.ts',
  '../packages/gim-sdk/src/engineering/catalogClassification.ts',
  '../packages/gim-sdk/src/engineering/query.ts',
];
export const formattedArchitectureModules = [...architectureModules];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--write') ? '--write' : '--check';
  const child = spawnSync(process.execPath, [
    'node_modules/prettier/bin/prettier.cjs', mode, ...formattedArchitectureModules,
  ], { stdio: 'inherit', windowsHide: true, env: process.env });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
