import { execFileSync, spawnSync } from 'node:child_process';
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
  '../packages/gim-sdk/src/gim/engineering/sourceRecordSelectors.ts',
  '../packages/gim-sdk/src/gim/engineering/compositionContexts.ts',
  '../packages/gim-sdk/src/gim/engineering/navigation.ts',
  '../packages/gim-sdk/src/gim/engineering/sourceProjection.ts',
];
export const formattedArchitectureModules = [...architectureModules];

export function unadoptedSdkSources(paths) {
  return paths.filter(path => /^packages\/gim-sdk\/src\/.*\.ts$/.test(path)
    && !path.includes('/__tests__/') && !path.endsWith('.test.ts')
    && !formattedArchitectureModules.includes(`../${path}`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--write') ? '--write' : '--check';
  if (mode === '--check') {
    const cwd = fileURLToPath(new URL('../..', import.meta.url));
    const git = (...args) => execFileSync('git', args, {cwd, encoding:'utf8', windowsHide:true}).split('\0').filter(Boolean);
    const requestedBase = process.env.GIM_FORMAT_BASE;
    const base = requestedBase && !/^0+$/.test(requestedBase) ? requestedBase : 'HEAD';
    if (base !== 'HEAD' && !/^[a-f0-9]{40}$/.test(base)) throw Error('GIM_FORMAT_BASE must be a Git commit SHA');
    const paths = ['packages/gim-sdk/src'];
    const changed = git('diff', '--name-only', '--diff-filter=AMR', '--no-ext-diff', '-z', base, '--', ...paths);
    const missing = unadoptedSdkSources([...changed, ...git('ls-files', '--others', '--exclude-standard', '-z', '--', ...paths)]);
    if (missing.length) {
      console.error(`Add new or changed SDK sources to architectureModules:\n${missing.join('\n')}`);
      process.exit(1);
    }
  }
  const child = spawnSync(process.execPath, [
    'node_modules/prettier/bin/prettier.cjs', mode, ...formattedArchitectureModules,
  ], { stdio: 'inherit', windowsHide: true, env: process.env });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
