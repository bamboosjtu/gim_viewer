import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The same bounded adoption scope drives Prettier and type-checked ESLint.
export const architectureModules = [
  'src/engineering/catalogLabels.ts',
  '../packages/gim-sdk/src/projection/projection.ts',
  'src/engineering/composition.ts',
  'src/engineering/compositionTemplate.ts',
  'src/engineering/evidence.ts',
  '../packages/gim-sdk/src/semantic/semantic.ts',
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
  'src/gim/schParser.ts',
  'src/gim/fileLookup.ts',
  'src/gim/geometry/affineMatrix.ts',
  'src/gim/geometry/devParser.ts',
  'src/gim/geometry/phmParser.ts',
  'src/gim/geometry/xmlModParser.ts',
  'src/gim/geometry/xmlModWorkerParser.ts',
  '../packages/gim-sdk/src/geometry/geometry.ts',
  'src/gim/gimValueSemantics.ts',
  'src/gim/ifcOutwardProduct.ts',
  'src/gim/ifcSpatialParser.ts',
  'src/gim/cbmParser.ts',
  'src/gim/sourceDocument.ts',
  'src/gim/documentParseInfo.ts',
  'src/gim/stdParser.ts',
  'src/gim/sldParser.ts',
  'src/services/substationSpatialWorkerClient.ts',
  'src/services/nodeInteractionService.ts',
  'src/services/engineeringService.ts',
  'src/services/engineeringWorkerClient.ts',
  'src/services/openGimService.ts',
  'src/app/state.ts',
  'src/gim/engineering/navigation.ts',
  'src/gim/engineering/sourceDocuments.ts',
  'src/gim/engineering/sourceGraph.ts',
  'src/gim/substationEvidence.ts',
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
  'src/services/engineeringCacheCodec.ts',
  'src/services/inspectorService.ts',
  'src/services/powerlineRuntime.ts',
  'src/ui/engineeringTreeView.ts',
  'src/ui/lineMapCanvasInput.ts',
  'src/ui/lineMapTooltip.ts',
  'src/ui/lineMapView.ts',
  'src/ui/lineMapBaseLayer.ts',
  'src/ui/lineProjectView.ts',
  'src/ui/shell/viewerShell.ts',
  'src/viewer/geometryWorkGate.ts',
  'src/viewer/ifcBimLoader.ts',
  'src/viewer/ifcConnectionPreviewRuntime.ts',
  'src/viewer/ifcConversion.ts',
  '../packages/gim-sdk/src/shared/designation.ts',
  '../packages/gim-sdk/src/shared/sourceRecord.ts',
  '../packages/gim-sdk/src/geometry/representationAddresses.ts',
  '../packages/gim-sdk/src/semantic/catalogClassification.ts',
  '../packages/gim-sdk/src/projection/query.ts',
  '../packages/gim-sdk/src/shared/sourceRecordSelectors.ts',
  '../packages/gim-sdk/src/projection/compositionContexts.ts',
  '../packages/gim-sdk/src/projection/navigation.ts',
  '../packages/gim-sdk/src/projection/sourceProjection.ts',
  '../packages/gim-sdk/src/semantic/classify.ts',
  '../packages/gim-sdk/src/semantic/normalize.ts',
  '../packages/gim-sdk/src/semantic/normalization/prepareEvidence.ts',
  '../packages/gim-sdk/src/semantic/recognition/evidenceReader.ts',
  '../packages/gim-sdk/src/semantic/policyFingerprints.ts',
  '../packages/gim-sdk/src/semantic/recognizeSource.ts',
  '../packages/gim-sdk/src/semantic/sourceTypePolicy.ts',
  '../packages/gim-sdk/src/semantic/types.ts',
  '../packages/gim-sdk/src/adapters/objectEvidence.ts',
  '../packages/gim-sdk/src/source/buildSources.ts',
  '../packages/gim-sdk/src/parser/parser.ts',
  '../packages/gim-sdk/src/parser/types.ts',
  '../packages/gim-sdk/src/parser/values.ts',
  '../packages/gim-sdk/src/parser/fam.ts',
  '../packages/gim-sdk/src/parser/affineMatrix.ts',
  '../packages/gim-sdk/src/parser/dev.ts',
  '../packages/gim-sdk/src/parser/phm.ts',
  '../packages/gim-sdk/src/parser/substationMod.ts',
  '../packages/gim-sdk/src/parser/mod.ts',
  '../packages/gim-sdk/src/parser/ifcStep.ts',
  '../packages/gim-sdk/src/parser/cbm.ts',
  '../packages/gim-sdk/src/parser/sch.ts',
  '../packages/gim-sdk/src/parser/xml.ts',
  '../packages/gim-sdk/src/parser/std.ts',
  '../packages/gim-sdk/src/parser/sld.ts',
  '../packages/gim-sdk/src/geometry/affineMatrix.ts',
  '../packages/gim-sdk/src/source/famBusinessIdentity.ts',
  '../packages/gim-sdk/src/source/source.ts',
  '../packages/gim-sdk/src/source/famParser.ts',
  // The SDK tree migration adopted every production module of the package.
  '../packages/gim-sdk/src/adapters/semanticAdapter.ts',
  '../packages/gim-sdk/src/engineering/representations.ts',
  '../packages/gim-sdk/src/geometry/affineMatrix.ts',
  '../packages/gim-sdk/src/geometry/geometryOccurrences.ts',
  '../packages/gim-sdk/src/geometry/physicalOccurrences.ts',
  '../packages/gim-sdk/src/index.ts',
  '../packages/gim-sdk/src/projection/composition.ts',
  '../packages/gim-sdk/src/projection/compositionTemplate.ts',
  '../packages/gim-sdk/src/projection/inventory.ts',
  '../packages/gim-sdk/src/projection/inventoryTemplate.ts',
  '../packages/gim-sdk/src/projection/sourceTitles.ts',
  '../packages/gim-sdk/src/semantic/catalog/catalogLabels.ts',
  '../packages/gim-sdk/src/semantic/classificationDetails.ts',
  '../packages/gim-sdk/src/semantic/compositionPolicy.ts',
  '../packages/gim-sdk/src/semantic/evidence.ts',
  '../packages/gim-sdk/src/semantic/recoverMembership.ts',
  '../packages/gim-sdk/src/semantic/standardCatalog.ts',
  '../packages/gim-sdk/src/semantic/validate.ts',
  '../packages/gim-sdk/src/shared/contracts.ts',
  '../packages/gim-sdk/src/shared/recognitionFieldPolicy.ts',
  '../packages/gim-sdk/src/source/attributeEvidence.ts',
  '../packages/gim-sdk/src/source/engineeringModel.ts',
  '../packages/gim-sdk/src/source/entryResolver.ts',
  '../packages/gim-sdk/src/source/evidenceProvider.ts',
  '../packages/gim-sdk/src/source/gimValueSemantics.ts',
  '../packages/gim-sdk/src/source/ifcOutwardProduct.ts',
  '../packages/gim-sdk/src/source/ifcSourceRecords.ts',
  '../packages/gim-sdk/src/source/ifcSpatialTypes.ts',
  '../packages/gim-sdk/src/source/path.ts',
  '../packages/gim-sdk/src/source/recognitionFieldPolicy.ts',
  '../packages/gim-sdk/src/source/sourceComposition.ts',
  '../packages/gim-sdk/src/source/sourceDocument.ts',
  '../packages/gim-sdk/src/source/sourceDocuments.ts',
  '../packages/gim-sdk/src/source/sourceEvidence.ts',
  '../packages/gim-sdk/src/source/sourceGraph.ts',
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
