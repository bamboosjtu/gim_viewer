import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The same bounded adoption scope drives Prettier and type-checked ESLint.
export const architectureModules = [
  'src/engineering/catalogLabels.ts',
  '../packages/gim-sdk/src/gim/engineering/projection.ts',
  'src/engineering/composition.ts',
  'src/engineering/compositionTemplate.ts',
  'src/engineering/evidence.ts',
  '../packages/gim-sdk/src/engineering/semantic.ts',
  'src/engineering/inventoryTemplate.ts',
  'src/engineering/representations.ts',
  '../packages/gim-sdk/src/engineering/fusion.ts',
  'src/engineering/types.ts',
  'src/engineering/validate.ts',
  'src/gim/engineering/compositionContexts.ts',
  'src/gim/engineering/evidenceProvider.ts',
  'src/gim/engineering/recognitionFieldPolicy.ts',
  'src/gim/engineering/sourceProjection.ts',
  'src/gim/entryResolver.ts',
  'src/gim/famParser.ts',
  'src/gim/fileLookup.ts',
  'src/gim/geometry/affineMatrix.ts',
  '../packages/gim-sdk/src/gim/engineering/geometry.ts',
  'src/gim/gimValueSemantics.ts',
  'src/gim/ifcOutwardProduct.ts',
  'src/gim/ifcSpatialParser.ts',
  'src/gim/sourceDocument.ts',
  'src/services/substationSpatialWorkerClient.ts',
  'src/app/state.ts',
  'src/gim/engineering/navigation.ts',
  'src/gim/engineering/sourceDocuments.ts',
  'src/gim/engineering/sourceGraph.ts',
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
  'src/services/diagramPresentationPort.ts',
  'src/services/equipmentPresentationPort.ts',
  'src/services/linePresentationPort.ts',
  'src/services/loadingPresentationPort.ts',
  'src/services/projectOpenPresentationPort.ts',
  'src/services/projectPresentationPort.ts',
  'src/services/selectionPresentationPort.ts',
  'src/services/sourceInspectorPresentationPort.ts',
  'src/services/viewerPresentationPort.ts',
  'src/services/sourceGeometryService.ts',
  'src/services/projectPropertyCache.ts',
  'src/services/lineAttrRestoreService.ts',
  'src/services/substationIfcRuntime.ts',
  'src/services/substationIfcSource.ts',
  'src/services/substationRuntime.ts',
  'src/services/viewerUIBinding.ts',
  'src/services/equipmentRuntime.ts',
  'src/ui/engineeringTreeView.ts',
  'src/ui/lineMapCanvasInput.ts',
  'src/ui/lineMapTooltip.ts',
  'src/ui/lineMapView.ts',
  'src/ui/shell/viewerShell.ts',
  'src/viewer/geometryWorkGate.ts',
  'src/viewer/ifcBimLoader.ts',
  'src/viewer/ifcConnectionPreviewRuntime.ts',
  'src/viewer/ifcConversion.ts',
  '../packages/gim-sdk/src/shared/designation.ts',
  '../packages/gim-sdk/src/shared/sourceRecord.ts',
  '../packages/gim-sdk/src/shared/representationAddresses.ts',
  '../packages/gim-sdk/src/engineering/catalogClassification.ts',
  '../packages/gim-sdk/src/engineering/query.ts',
  '../packages/gim-sdk/src/gim/engineering/sourceRecordSelectors.ts',
  '../packages/gim-sdk/src/gim/engineering/compositionContexts.ts',
  '../packages/gim-sdk/src/gim/engineering/navigation.ts',
  '../packages/gim-sdk/src/gim/engineering/sourceProjection.ts',
  '../packages/gim-sdk/src/engineering/classify.ts',
  '../packages/gim-sdk/src/engineering/normalize.ts',
  '../packages/gim-sdk/src/engineering/policyFingerprints.ts',
  '../packages/gim-sdk/src/engineering/recognizeSource.ts',
  '../packages/gim-sdk/src/engineering/sourceTypePolicy.ts',
  '../packages/gim-sdk/src/engineering/types.ts',
  '../packages/gim-sdk/src/gim/engineering/objectEvidence.ts',
  '../packages/gim-sdk/src/gim/engineering/source.ts',
  '../packages/gim-sdk/src/gim/famParser.ts',
];
export const formattedArchitectureModules = [...architectureModules];

const sourceRoots = ['desktop/src', 'desktop/bridge', 'packages/gim-sdk/src'];
const adoptedPaths = new Set(architectureModules.map(path => path.startsWith('../') ? path.slice(3) : `desktop/${path}`));

export function unadoptedProductionSources(paths) {
  return [...new Set(paths)].filter(path => sourceRoots.some(root => path.startsWith(`${root}/`))
    && path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.includes('/__tests__/')
    && !adoptedPaths.has(path)).sort();
}

export function changedProductionSources(cwd, requestedBase) {
  const base = requestedBase && !/^0+$/.test(requestedBase) ? requestedBase : 'HEAD';
  if (base !== 'HEAD' && !/^[a-f0-9]{40}$/.test(base)) throw Error('GIM_FORMAT_BASE must be a Git commit SHA');
  const git = (...args) => execFileSync('git', args, {cwd, encoding:'utf8', windowsHide:true}).split('\0').filter(Boolean);
  // Rename destinations are checked as additions, even if detection varies across clients.
  return [
    ...git('diff', '--name-only', '--diff-filter=AMT', '--no-renames', '--no-ext-diff', '-z', base, '--', ...sourceRoots),
    ...git('ls-files', '--others', '--exclude-standard', '-z', '--', ...sourceRoots),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--write') ? '--write' : '--check';
  if (mode === '--check') {
    const cwd = fileURLToPath(new URL('../..', import.meta.url));
    const missing = unadoptedProductionSources(changedProductionSources(cwd, process.env.GIM_FORMAT_BASE));
    if (missing.length) {
      console.error(`Add new or changed desktop and SDK production sources to architectureModules:\n${missing.join('\n')}`);
      process.exit(1);
    }
  }
  const child = spawnSync(process.execPath, [
    'node_modules/prettier/bin/prettier.cjs', mode, ...formattedArchitectureModules,
  ], { stdio: 'inherit', windowsHide: true, env: process.env });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
