import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { checkPresentationSource } from './presentation-boundaries.mjs';
import { dependencyCycles, packageBoundaryError } from './package-boundaries.mjs';
import { coreBoundaryErrors } from './core-boundaries.mjs';
import { nativeContractCallErrors } from './native-contract-boundaries.mjs';
import { appStateFieldErrors } from './app-state-boundaries.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const sdkRoot = resolve(root, '../../packages/gim-sdk/src');
const measurementCoreRoot = resolve(root, '../../packages/measurement-core/src');
const measurementFacade = resolve(root, 'measurement/core.ts');
function* files(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}
const failures = appStateFieldErrors(readFileSync(resolve(root, 'app/state.ts'), 'utf8'));
const sharedDependencies = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).dependencies;
for (const path of [
  ...files(resolve(root, '..', 'bridge')),
  ...files(root),
  ...files(resolve(root, '..', '..', 'app', 'src')),
]) {
  failures.push(...nativeContractCallErrors(readFileSync(path, 'utf8'), relative(root, path)));
}
for (const path of files(resolve(root, 'services'))) {
  const local = relative(root, path).replaceAll('\\', '/');
  failures.push(...checkPresentationSource(readFileSync(path, 'utf8'), local));
}
// Desktop uses the declared source export; SDK consumers keep the built default entry.
// All desktop access goes through one facade; the core cannot import runtime layers.
for (const path of files(measurementCoreRoot)) {
  const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const node of ast.statements)
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier.text;
      if (
        !specifier.startsWith('.') ||
        !resolve(dirname(path), specifier.replace(/\.js$/, '.ts')).startsWith(
          `${measurementCoreRoot}${sep}`,
        )
      ) {
        failures.push(
          `${relative(root, path)}: measurement core imports outside its own source package`,
        );
      }
    }
  function rejectDynamic(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      failures.push(
        `${relative(root, path)}: measurement core cannot dynamically import runtime packages`,
      );
    }
    ts.forEachChild(node, rejectDynamic);
  }
  ts.forEachChild(ast, rejectDynamic);
}
if (
  readFileSync(measurementFacade, 'utf8').trim() !== "export * from '@gim/measurement-core/source';"
) {
  failures.push(
    'measurement/core.ts: measurement source facade changed; update the explicit boundary contract',
  );
}
// Existing IFC persistence adapters are outside the engineering refactor. Keep
// exact exceptions visible so this check rejects any additional IO dependency.
// Every entry must stay referenced by a real import; unused entries fail below.
const viewerBridgeImports = new Map([
  ['viewer/ifcBimLoader.ts:@desktop/ifcLodCache.js', false],
  ['viewer/ifcRegionalRuntime.ts:@desktop/ifcLodCache.js', false],
]);
const infrastructurePorts = new Map([
  ['infrastructure/workers/engineeringWorker.ts', 'services/engineeringWorkerHandler.js'],
  [
    'infrastructure/workers/compositionProjectionWorker.ts',
    'services/projections/compositionSpatial.js',
  ],
  ['infrastructure/cache/engineeringCacheCodec.ts', 'services/projections/compositionSpatial.js'],
  ['infrastructure/native/invokeTimed.ts', '@tauri-apps/api/core'],
]);
const linePresentationReads = new Set(
  [
    'lineAttributeIndex.js',
    'lineInspectorProjection.js',
    'lineMapGeometry.js',
    'lineMapHitTesting.js',
    'lineMapStages.js',
    'lineWireSemanticService.js',
  ].map((name) => `features/powerline/presentation/${name}`),
);
// This optional UI export consumes read-only graph and map projections.
linePresentationReads.add('features/powerline/diagnostics/lineCatenaryAuditExportService.js');
// Views may use explicit presentation selectors/formatters, never parsers or business classifiers.
const uiPresentationValues = new Map([
  [
    'engineering/catalogLabels.ts',
    new Set(['categoryLabel', 'classificationReasonLabel', 'catalogPathLabel']),
  ],
  [
    'gim/modelIdentity.ts',
    new Set([
      'resolveIfcModelId',
      'findIfcEntryByModelId',
      'normalizeEntryPath',
      'normalizedIfcBasename',
    ]),
  ],
  ['gim/gimValueSemantics.ts', new Set(['isGimEmptyValue'])],
  [
    'gim/geometry/geometryDiagnostics.ts',
    new Set(['getGeometryDiagnostic', 'geometryReasonLabel', 'geometryStatusLabel']),
  ],
  ['shared/gimParsing.ts', new Set(['getFirstNonEmptyKv', 'isGimEmptyValue'])],
]);
const viewerSourceValues = new Map([
  [
    'gim/connectionEndpoints.ts',
    new Set(['validEndpointEvidence', 'normalizeConnectionPointGuid']),
  ],
  ['gim/ifcConnectionSubset.ts', new Set(['omitIndexedOpenings', 'buildEarlyConnectionInput'])],
  ['gim/modelIdentity.ts', new Set(['createIfcModelId'])],
  ['gim/fileLookup.ts', new Set(['getFileByPath'])],
  ['gim/geometry/stretchedBody.ts', new Set(['stretchedBodyDisplacement'])],
  ['gim/geometry/offsetRectangularTable.ts', new Set(['offsetRectangularTableVertices'])],
  ['gim/geometry/xmlModParser.ts', new Set(['parseXmlMod'])],
  ['gim/geometry/ir.ts', new Set(['DEFAULT_ANGULAR_SEGMENTS', 'DEFAULT_LINEAR_SEGMENTS'])],
]);
const adapterSemanticPorts = new Map([
  ['semantic/semantic', new Set(['normalizeEngineeringModel'])],
  [
    'semantic/recognition/objectEvidenceDecision',
    new Set(['resolveObjectEvidence', 'ENGINEERING_RECOGNITION_VERSION']),
  ],
  ['semantic/recognition/neutralAssemblyResolver', new Set(['completeNeutralAssemblies'])],
]);
for (const [layer, sourceRoot] of [
  ...['engineering', 'gim', 'viewer', 'ui', 'services', 'features', 'app', 'infrastructure'].map(
    (layer) => [layer, root],
  ),
  ...['engineering', 'semantic', 'source', 'geometry', 'projection', 'adapters', 'shared'].map(
    (layer) => [layer, sdkRoot],
  ),
])
  for (const path of files(resolve(sourceRoot, layer))) {
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const localPath = relative(sourceRoot, path).replaceAll('\\', '/');
    failures.push(...coreBoundaryErrors(readFileSync(path, 'utf8'), localPath));
    const pureLineProjection = [
      'features/powerline/presentation/lineMapProjection.ts',
      'features/powerline/presentation/lineNavigationProjection.ts',
      'features/powerline/presentation/lineNavigationTargets.ts',
      'features/powerline/presentation/lineInspectorProjection.ts',
      'features/powerline/presentation/lineMapGeometry.ts',
      'features/powerline/presentation/lineMapHitTesting.ts',
      'features/powerline/presentation/lineMapStages.ts',
      'features/powerline/presentation/lineAttributeIndex.ts',
      'features/powerline/presentation/lineWireSemanticService.ts',
      'features/powerline/diagnostics/lineCatenaryAuditExportService.ts',
      'services/inspectorMarkup.ts',
      'services/propertyPresentation.ts',
    ].includes(localPath);
    const resolverFactories = new Set(['createEntryResolver', 'createEntryIndex']);
    for (const statement of ast.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.endsWith('/entryResolver.js')
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements) {
          if ((binding.propertyName ?? binding.name).text === 'createEntryResolver')
            resolverFactories.add(binding.name.text);
        }
    }
    function visit(node) {
      if (
        localPath.startsWith('app/session/') &&
        ts.isIdentifier(node) &&
        ['document', 'window', 'HTMLElement'].includes(node.text)
      )
        failures.push(
          `${localPath}: Session uses presentation ports instead of browser globals (${node.text})`,
        );
      if (
        localPath.startsWith('features/equipment/') ||
        localPath === 'services/geometryOnlyRuntime.ts'
      ) {
        if (ts.isIdentifier(node) && ['document', 'window', 'HTMLElement'].includes(node.text))
          failures.push(`${localPath}: equipment presentation belongs in its UI port`);
        if (ts.isIdentifier(node) && node.text === 'loadPresentation')
          failures.push(`${localPath}: equipment runtime must use its explicit presentation port`);
      }
      if (
        pureLineProjection &&
        ts.isIdentifier(node) &&
        ['document', 'window', 'localStorage', 'sessionStorage'].includes(node.text)
      ) {
        failures.push(`${localPath}: pure line projection references browser global ${node.text}`);
      }
      if (
        localPath !== 'source/entryResolver.ts' &&
        ts.isCallExpression(node) &&
        (ts.isIdentifier(node.expression)
          ? resolverFactories.has(node.expression.text)
          : ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'createEntryResolver')
      ) {
        let enumeratesKeys = false;
        const inspect = (child) => {
          if (
            ts.isCallExpression(child) &&
            ts.isPropertyAccessExpression(child.expression) &&
            child.expression.name.text === 'keys'
          )
            enumeratesKeys = true;
          ts.forEachChild(child, inspect);
        };
        node.arguments.forEach(inspect);
        if (enumeratesKeys)
          failures.push(
            `${localPath}: full archive index bypasses reuse; use getFileEntryResolver(files) instead of createEntryResolver(files.keys())`,
          );
      }
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        const name = specifier.text;
        if (
          sourceRoot === sdkRoot &&
          !name.startsWith('.') &&
          !name.startsWith('@gim/powerline-core/')
        )
          failures.push(
            `${localPath}: SDK runtime dependency is not declared portable core: ${name}`,
          );
        const packageError = packageBoundaryError(
          name,
          sourceRoot === sdkRoot ? { '@gim/powerline-core': true } : sharedDependencies,
        );
        if (packageError) failures.push(`${localPath}: ${packageError}: ${name}`);
        const resolved = name.startsWith('.')
          ? resolve(dirname(path), name.replace(/\.js$/, '.ts'))
          : null;
        if (sourceRoot === sdkRoot && resolved && !resolved.startsWith(`${sdkRoot}${sep}`))
          failures.push(`${localPath}: SDK cannot import outside its source package: ${name}`);
        if (
          path !== measurementFacade &&
          (resolved?.startsWith(`${measurementCoreRoot}${sep}`) ||
            name.startsWith('@gim/measurement-core'))
        ) {
          failures.push(`${localPath}: import measurement core through measurement/core.ts`);
        }
        const targetPath = name.startsWith('.')
          ? relative(sourceRoot, resolve(dirname(path), name)).replaceAll('\\', '/')
          : name;
        const target = targetPath.split('/')[0];
        if (
          localPath.startsWith('app/session/') &&
          (target === 'features' ||
            target === 'ui' ||
            targetPath.startsWith('app/composition/') ||
            targetPath === 'services/presentation/dom.js' ||
            targetPath === 'services/projectViewerLifecycle.js' ||
            (localPath === 'app/session/projectCleanup.ts' && target === 'viewer'))
        )
          failures.push(
            `${localPath}: Session uses injected project routing and presentation ports (${name})`,
          );
        if (targetPath.startsWith('app/composition/') && layer !== 'app' && layer !== 'measurement')
          failures.push(
            `${localPath}: Host composition is only entered by the application (${name})`,
          );
        const native = localPath.startsWith('infrastructure/native/');
        if (
          targetPath.startsWith('infrastructure/native/') &&
          ['engineering', 'gim', 'viewer', 'ui'].includes(layer)
        )
          failures.push(
            `${localPath}: Native project files belong to host orchestration (${name})`,
          );
        if (
          native &&
          /^(?:features\/|viewer\/|three(?:\/|$)|web-ifc(?:\/|$)|maplibre-gl(?:\/|$)|infrastructure\/(?:cache|workers)\/)/.test(
            targetPath,
          )
        )
          failures.push(
            `${localPath}: Native project files cannot depend on application runtimes (${name})`,
          );
        if (
          targetPath.startsWith('infrastructure/workers/') &&
          ['engineering', 'gim', 'viewer', 'ui'].includes(layer)
        )
          failures.push(
            `${localPath}: Worker infrastructure belongs to host orchestration (${name})`,
          );
        if (
          targetPath.startsWith('infrastructure/cache/') &&
          ['engineering', 'gim', 'viewer', 'ui'].includes(layer)
        )
          failures.push(`${localPath}: Engineering cache belongs to host infrastructure (${name})`);
        if (
          localPath.startsWith('infrastructure/cache/') &&
          /^(?:features\/|viewer\/|three(?:\/|$)|web-ifc(?:\/|$)|maplibre-gl(?:\/|$)|infrastructure\/workers\/)/.test(
            targetPath,
          )
        )
          failures.push(
            `${localPath}: Cache infrastructure cannot depend on feature, Worker or rendering runtimes (${name})`,
          );
        if (
          localPath.startsWith('infrastructure/workers/') &&
          /^(?:app\/|features\/|viewer\/|ui\/|@desktop\/|@tauri-apps\/|three(?:\/|$)|web-ifc(?:\/|$)|maplibre-gl(?:\/|$))/.test(
            targetPath,
          )
        )
          failures.push(
            `${localPath}: Worker infrastructure cannot depend on host composition or rendering (${name})`,
          );
        if (
          /^(?:services\/geometryOnlyRuntime|services\/devLod\w+|services\/devGeometryWorker\w*)\.ts$/.test(
            localPath,
          ) &&
          target === 'features'
        )
          failures.push(
            `${localPath}: shared DEV geometry must stay independent of features (${name})`,
          );
        if (
          localPath.startsWith('features/equipment/') &&
          target === 'features' &&
          !targetPath.startsWith('features/equipment/')
        )
          failures.push(`${localPath}: Equipment must not depend on another feature (${name})`);
        if (
          sourceRoot === root &&
          targetPath.startsWith('features/powerline/runtime/') &&
          !localPath.startsWith('features/powerline/') &&
          !(
            localPath === 'app/composition/presentationBindings.ts' &&
            targetPath === 'features/powerline/runtime/lineModRuntimeService.js'
          )
        ) {
          failures.push(`${localPath}: Powerline runtime belongs to the project scope (${name})`);
        }
        if (layer === 'ui' && targetPath.startsWith('features/powerline/')) {
          const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
          const bindings = clause?.namedBindings;
          const selector =
            targetPath === 'features/powerline/presentation/lineNavigationTargets.js'
              ? 'resolveLineNavigationTarget'
              : targetPath === 'features/powerline/presentation/lineModSourcePort.js'
                ? 'loadLineModSourcesForNode'
                : undefined;
          const selectors =
            selector &&
            !clause?.name &&
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.every(
              (item) => item.isTypeOnly || (item.propertyName ?? item.name).text === selector,
            );
          if (!clause?.isTypeOnly && !selectors && !linePresentationReads.has(targetPath))
            failures.push(
              `${localPath}: UI consumes Powerline projections and selection queries (${name})`,
            );
        }
        if (
          sourceRoot === root &&
          targetPath.startsWith('features/substation/runtime/spatial/') &&
          !localPath.startsWith('features/substation/')
        ) {
          failures.push(
            `${localPath}: Spatial workflow and worker belong to the substation feature (${name})`,
          );
        }
        if (layer === 'semantic' && /^shared\/sourceRecord(?:\.[jt]s)?$/.test(targetPath))
          failures.push(
            `${localPath}: Semantic must consume adapted facts instead of raw source records`,
          );
        if (layer === 'adapters' && target === 'semantic') {
          const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
          const exportClause = ts.isExportDeclaration(node) ? node.exportClause : undefined;
          const bindings = clause?.namedBindings;
          const named =
            bindings && ts.isNamedImports(bindings)
              ? bindings.elements
              : exportClause && ts.isNamedExports(exportClause)
                ? exportClause.elements
                : undefined;
          const runtimeNames = named
            ?.filter((item) => !item.isTypeOnly)
            .map((item) => (item.propertyName ?? item.name).text);
          const port = adapterSemanticPorts.get(targetPath.replace(/\.[jt]s$/, ''));
          const typeOnly = clause?.isTypeOnly || (ts.isExportDeclaration(node) && node.isTypeOnly);
          if (
            !typeOnly &&
            (clause?.name ||
              !runtimeNames ||
              !named?.length ||
              runtimeNames.some((value) => !port?.has(value)))
          ) {
            failures.push(
              `${localPath}: Adapter may call only Semantic entry points, not catalog or decision internals: ${name}`,
            );
          }
        }
        if (layer === 'viewer' && target === 'gim') {
          const module = relative(
            sourceRoot,
            resolve(dirname(path), name.replace(/\.js$/, '.ts')),
          ).replaceAll('\\', '/');
          const clause = ts.isImportDeclaration(node) ? node.importClause : undefined,
            bindings = clause?.namedBindings;
          const names =
            bindings && ts.isNamedImports(bindings)
              ? bindings.elements
                  .filter((item) => !item.isTypeOnly)
                  .map((item) => (item.propertyName ?? item.name).text)
              : null;
          if (
            !node.isTypeOnly &&
            !clause?.isTypeOnly &&
            (!names || names.some((value) => !viewerSourceValues.get(module)?.has(value)))
          )
            failures.push(`${localPath}: Viewer cannot import source semantics ${name}`);
          if (
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.some((item) => (item.propertyName ?? item.name).text === 'CbmNode')
          )
            failures.push(`${localPath}: CbmNode belongs to source/application projections`);
        }
        if (
          pureLineProjection &&
          /^(?:app|ui|viewer|@desktop|@tauri-apps|three|web-ifc|maplibre)/.test(target)
        ) {
          failures.push(`${localPath}: pure line projection imports runtime dependency ${name}`);
        }
        if (layer === 'ui' && name.startsWith('.')) {
          const module = relative(
            sourceRoot,
            resolve(dirname(path), name.replace(/\.js$/, '.ts')),
          ).replaceAll('\\', '/');
          if (/^(?:engineering|gim|viewer)\//.test(module) || module === 'shared/gimParsing.ts') {
            const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
            const bindings = clause?.namedBindings;
            const names =
              bindings && ts.isNamedImports(bindings)
                ? bindings.elements
                    .filter((item) => !item.isTypeOnly)
                    .map((item) => (item.propertyName ?? item.name).text)
                : null;
            if (
              !node.isTypeOnly &&
              !clause?.isTypeOnly &&
              (!names || names.some((value) => !uiPresentationValues.get(module)?.has(value)))
            )
              failures.push(
                `${localPath}: UI must consume service projections; forbidden value import ${name}`,
              );
          }
        }

        // Desktop layers keep their original rules; SDK capability directories
        // mirror verify-capabilities allowed roles: a layer bans every sibling
        // capability plus host/render dependencies. 'semantic/catalog' (dictionary
        // role) stays legal for semantic/projection; type-only edges are exempt
        // (esbuild erases them from runtime closures).
        // UI also bans measurement probes: layers.md lets ui consume only
        // service results, pure types and whitelisted selectors, so map/worker
        // probes must be injected by services through presentation ports.
        const banned =
          layer === 'engineering'
            ? /^(?:app|gim|semantic(?!\/catalog)|source|adapters|projection|viewer|ui|services|@desktop|@tauri-apps|three|web-ifc|maplibre)/
            : layer === 'gim'
              ? /^(?:app|services|viewer|ui|@desktop|@tauri-apps)/
              : layer === 'semantic'
                ? /^(?:app|source|adapters|projection|geometry|engineering|viewer|ui|services|@desktop|@tauri-apps|three|web-ifc|maplibre)/
                : layer === 'source'
                  ? /^(?:app|semantic(?!\/catalog)|adapters|projection|geometry|engineering|services|viewer|ui|@desktop|@tauri-apps)/
                  : layer === 'geometry'
                    ? /^(?:app|semantic(?!\/catalog)|adapters|projection|engineering|services|viewer|ui|@desktop|@tauri-apps)/
                    : layer === 'projection'
                      ? /^(?:app|source|semantic(?!\/catalog)|adapters|geometry|engineering|services|viewer|ui|@desktop|@tauri-apps|three|web-ifc|maplibre)/
                      : layer === 'adapters'
                        ? /^(?:app|geometry|engineering|projection|services|viewer|ui|@desktop|@tauri-apps|three|web-ifc|maplibre)/
                        : layer === 'ui'
                          ? /^(?:@desktop|@tauri-apps|measurement)/
                          : layer === 'services' || layer === 'features'
                            ? /^(?:ui)/
                            : layer === 'app'
                              ? /^(?:gim)/
                              : /^(?:app|services|ui|@desktop|@tauri-apps)/;
        const exceptionKey = `${relative(root, path).replaceAll('\\', '/')}:${name}`;
        const exception = viewerBridgeImports.has(exceptionKey);
        if (exception) viewerBridgeImports.set(exceptionKey, true);
        const sdkTypeOnly =
          sourceRoot === sdkRoot && ts.isImportDeclaration(node) && node.importClause?.isTypeOnly;
        if (
          banned.test(targetPath) &&
          !exception &&
          infrastructurePorts.get(localPath) !== targetPath &&
          !(
            native &&
            (targetPath === '@desktop/contracts.js' ||
              (targetPath === '@desktop/substationParseCopy.js' &&
                ts.isImportDeclaration(node) &&
                node.importClause?.isTypeOnly))
          ) &&
          !(
            (layer === 'services' || layer === 'app') &&
            ts.isImportDeclaration(node) &&
            node.importClause?.isTypeOnly
          ) &&
          !sdkTypeOnly
        )
          failures.push(`${relative(root, path)}: forbidden import ${name}`);
        const local = relative(root, path).replaceAll('\\', '/');
        const projection =
          local === 'projection/inventoryTemplate.ts' || local === 'projection/inventory.ts'
            ? 'inventory'
            : ['projection/composition.ts', 'projection/compositionTemplate.ts'].includes(local)
              ? 'composition'
              : local === 'projection/sourceProjection.ts'
                ? 'source'
                : undefined;
        const cross =
          projection === 'inventory'
            ? /composition|sourceProjection|navigation/
            : projection === 'composition'
              ? /inventory|sourceProjection|navigation/
              : projection === 'source'
                ? /composition|inventory|normalize|classify|navigation/
                : undefined;
        if (cross?.test(name))
          failures.push(`${local}: projection template imports another projection ${name}`);
      }
      if (
        layer === 'viewer' &&
        ts.isPropertyAccessExpression(node) &&
        /^(?:engineering(?:Selection|Snapshot|Sources|Navigation)?|currentIfcEntries|ifcGuidIndex|ifcGuidToName|deviceToIfcFile)$/.test(
          node.name.text,
        )
      ) {
        failures.push(`${relative(root, path)}: renderer reads ${node.name.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
// A whitelisted bridge import that no module uses anymore is itself a defect:
// dead entries would silently widen the viewer's IO surface.
for (const [entry, hit] of viewerBridgeImports)
  if (!hit)
    failures.push(`viewerBridgeImports contains a stale entry with no matching import: ${entry}`);
// An implementation must not regain its facade's whole dependency graph.
// Check each runtime family independently: calling another family's public
// runtime entry remains legal (for example IFC starting DEV LOD).
const substationRuntimeFiles = [
  resolve(root, 'features/substation/application/substationRuntime.ts'),
  resolve(root, 'features/substation/application/substationOpenStages.ts'),
  resolve(root, 'features/substation/application/substationColdSource.ts'),
  resolve(root, 'features/substation/application/substationColdPersistence.ts'),
  resolve(root, 'features/substation/runtime/substationBackgroundRuntime.ts'),
  resolve(root, 'features/substation/runtime/substationColdCore.ts'),
  resolve(root, 'features/substation/runtime/substationDevRuntime.ts'),
  resolve(root, 'features/substation/runtime/substationDocumentRuntime.ts'),
  resolve(root, 'features/substation/runtime/substationIfcRuntime.ts'),
  resolve(root, 'features/substation/runtime/substationIfcQueue.ts'),
  resolve(root, 'features/substation/runtime/substationIfcModelLoad.ts'),
  resolve(root, 'features/substation/runtime/substationIfcLoadProgress.ts'),
  resolve(root, 'features/substation/runtime/substationIfcSource.ts'),
  resolve(root, 'features/substation/runtime/substationIndexPublication.ts'),
  resolve(root, 'features/substation/runtime/substationSpatialRuntime.ts'),
  resolve(root, 'features/substation/runtime/substationSpatialSemanticCache.ts'),
  resolve(root, 'features/substation/runtime/spatial/spatialSemanticStarter.ts'),
  resolve(root, 'features/substation/runtime/spatial/substationSpatialWorkflow.ts'),
  resolve(root, 'features/substation/runtime/spatial/substationSpatialWorker.ts'),
  resolve(root, 'features/substation/runtime/spatial/substationSpatialWorkerClient.ts'),
  resolve(root, 'features/substation/runtime/substationWarmAttempt.ts'),
  resolve(root, 'features/substation/runtime/substationWarmCore.ts'),
  resolve(root, 'features/substation/runtime/substationLoadingState.ts'),
  resolve(root, 'features/substation/presentation/substationPresentation.ts'),
  resolve(root, 'features/substation/runtime/substationRuntimeTelemetry.ts'),
];
const runtimeFamilies = [
  substationRuntimeFiles,
  [
    ...[
      'engineeringWorkerClient',
      'engineeringWorker',
      'engineeringWorkerTransport',
      'workerRequests',
    ].map((name) => resolve(root, 'infrastructure/workers', `${name}.ts`)),
    resolve(root, 'services/engineeringWorkerHandler.ts'),
  ],
  [
    'application/openEquipmentProject',
    'runtime/equipmentSource',
    'presentation/equipmentSelection',
    'presentation/equipmentPresentationPort',
  ].map((name) => resolve(root, 'features/equipment', `${name}.ts`)),
  [
    'application/openPowerlineProject',
    'runtime/powerlineColdLoad',
    'runtime/powerlineWarmRestore',
    'runtime/lineSourceState',
    'runtime/lineParserInput',
    'runtime/lineParserWorkerClient',
    'runtime/lineParserWorker',
    'presentation/lineProjectProjection',
    'presentation/linePresentationPort',
  ].map((name) => resolve(root, 'features/powerline', `${name}.ts`)),
  [
    'devLodRuntime',
    'devLodTemplateStore',
    'devLodArtifactWriter',
    'devLodSourceWorkset',
    'devLodReadiness',
    'devLodDiagnostics',
    'devLodTypes',
  ].map((name) => resolve(root, 'services', `${name}.ts`)),
];
for (const paths of runtimeFamilies) {
  const graph = new Map(paths.map((path) => [path, new Set()]));
  for (const path of paths) {
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
              ? node.argument.literal
              : undefined;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        const target = resolve(dirname(path), specifier.text.split('?')[0].replace(/\.js$/, '.ts'));
        if (graph.has(target)) graph.get(path).add(target);
        if (path !== paths[0] && target === paths[0]) {
          failures.push(
            `${relative(root, path)}: implementation imports its runtime facade ${specifier.text}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  for (const cycle of dependencyCycles(graph)) {
    failures.push(
      `Circular runtime module dependency: ${cycle.map((path) => relative(root, path)).join(' -> ')}`,
    );
  }
}

// Whole-source static value graph. Dynamic and type dependencies are counted,
// but cannot create an eager module-initialization cycle by themselves.
const all = [...files(root), ...files(resolve(root, '../bridge')), ...files(sdkRoot)],
  graph = new Map(all.map((path) => [path, new Set()]));
const eagerRenderImports = new Map();
let typeEdges = 0,
  dynamicEdges = 0;
for (const path of all) {
  const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const scan = (node) => {
    const dynamic =
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const declaration = ts.isImportDeclaration(node) || ts.isExportDeclaration(node);
    const specifier = declaration ? node.moduleSpecifier : dynamic ? node.arguments[0] : undefined;
    const internal =
      ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        ? node.argument.literal
        : specifier;
    if (internal && ts.isStringLiteral(internal) && !path.startsWith(sdkRoot + sep)) {
      const name = internal.text;
      const localPath = relative(root, path).replaceAll('\\', '/');
      if (
        /^@gim\/gim-sdk\/(?:source|semantic|geometry|engineering|projection|adapters|shared)\//.test(
          name,
        )
      ) {
        failures.push(
          `${localPath}: use the SDK capability export instead of adding an internal import ${name}`,
        );
      }
    }
    if (specifier && ts.isStringLiteral(specifier)) {
      const name = specifier.text;
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      const typeOnly =
        node.isTypeOnly ||
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((item) => item.isTypeOnly));
      if (name.startsWith('.')) {
        const target = resolve(dirname(path), name.replace(/\.js$/, '.ts'));
        if (dynamic) dynamicEdges++;
        else if (typeOnly) typeEdges++;
        else if (graph.has(target)) graph.get(path).add(target);
      } else if (
        !dynamic &&
        !typeOnly &&
        /^(?:three|web-ifc|maplibre-gl|@thatopen\/(?:components|fragments))(?:\/|$)/.test(name)
      ) {
        const dependencies = eagerRenderImports.get(path) ?? [];
        dependencies.push(name);
        eagerRenderImports.set(path, dependencies);
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(ast);
}
for (const entry of [
  'main.ts',
  'app/session/openProject.ts',
  'app/session/projectSourceAcquisition.ts',
  'app/composition/projectRuntimes.ts',
]) {
  const pending = [resolve(root, entry)],
    visited = new Set();
  for (const path of pending) {
    if (visited.has(path)) continue;
    visited.add(path);
    for (const name of eagerRenderImports.get(path) ?? [])
      failures.push(`${entry}: eager renderer dependency ${name} through ${relative(root, path)}`);
    pending.push(...(graph.get(path) ?? []));
  }
}
for (const cycle of dependencyCycles(graph)) {
  failures.push(`Static value cycle: ${cycle.map((path) => relative(root, path)).join(' -> ')}`);
}
console.log(
  `Dependency graph: ${all.length} modules, ${typeEdges} type edges, ${dynamicEdges} dynamic edges`,
);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('Engineering, source, viewer and runtime module boundaries passed.');
