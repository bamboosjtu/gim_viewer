import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
function* files(dir) {
  for (const entry of readdirSync(dir, {withFileTypes:true})) {
    if (entry.name === '__tests__') continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}
const failures = [];
// Existing IFC persistence adapters are outside the engineering refactor. Keep
// exact exceptions visible so this check rejects any additional IO dependency.
const viewerBridgeImports = new Set([
  'viewer/ifcBimLoader.ts:@desktop/ifcLodCache.js',
  'viewer/ifcEntryLoader.ts:@desktop/runtime.js',
  'viewer/ifcEntryLoader.ts:@desktop/database.js',
  'viewer/ifcRegionalRuntime.ts:@desktop/ifcLodCache.js',
]);
for (const layer of ['engineering','gim','viewer','ui']) for (const path of files(resolve(root,layer))) {
  const ast = ts.createSourceFile(path, readFileSync(path,'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteral(specifier)) {
      const name = specifier.text;
      const target = name.startsWith('.') ? relative(root,resolve(dirname(path),name)).replaceAll('\\','/').split('/')[0] : name;
      const banned = layer === 'engineering' ? /^(?:app|gim|viewer|ui|services|@desktop|@tauri-apps|three|web-ifc|maplibre)/
        : layer === 'gim' ? /^(?:app|services|viewer|ui|@desktop|@tauri-apps)/ : layer==='ui'?/^(?:@desktop|@tauri-apps)/:/^(?:services|ui|@desktop|@tauri-apps)/;
      const exception = viewerBridgeImports.has(`${relative(root,path).replaceAll('\\','/')}:${name}`);
      if (banned.test(target) && !exception) failures.push(`${relative(root,path)}: forbidden import ${name}`);
      const local=relative(root,path).replaceAll('\\','/');
      const projection=local==='engineering/inventoryTemplate.ts'||local==='gim/engineering/inventory.ts'?'inventory'
        :['engineering/composition.ts','engineering/compositionTemplate.ts'].includes(local)?'composition'
        :local==='gim/engineering/sourceProjection.ts'?'source':undefined;
      const cross=projection==='inventory'?/composition|sourceProjection|navigation/
        :projection==='composition'?/inventory|sourceProjection|navigation/
        :projection==='source'?/composition|inventory|normalize|classify|navigation/:undefined;
      if(cross?.test(name))failures.push(`${local}: projection template imports another projection ${name}`);
    }
    if (layer === 'viewer' && ts.isPropertyAccessExpression(node) && /^engineering(?:Selection|Snapshot|Sources|Navigation)$/.test(node.name.text)) {
      failures.push(`${relative(root,path)}: renderer reads ${node.name.text}`);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
}
// An implementation must not regain its facade's whole dependency graph.
// Check each runtime family independently: calling another family's public
// runtime entry remains legal (for example IFC starting DEV LOD).
const runtimeFamilies = [
  ['substationRuntime', 'substationPresentation', 'substationRuntimeTelemetry', 'substationSpatialRuntime',
    'substationDocumentRuntime', 'substationIfcRuntime', 'substationDevRuntime', 'substationLoadingState'],
  ['modAutoLoadService', 'modGeometryContracts', 'modGeometryScene', 'modGeometrySourceFiles',
    'devGlbCacheFastPath', 'devGlbCacheRecovery', 'modRawGeometryLoader'],
  ['devLodRuntime', 'devLodTemplateStore', 'devLodArtifactWriter', 'devLodSourceWorkset',
    'devLodReadiness', 'devLodDiagnostics', 'devLodTypes'],
];
for (const family of runtimeFamilies) {
  const paths = family.map(name => resolve(root, 'services', `${name}.ts`));
  const graph = new Map(paths.map(path => [path, new Set()]));
  for (const path of paths) {
    const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        const target = resolve(dirname(path), specifier.text.replace(/\.js$/, '.ts'));
        if (graph.has(target)) graph.get(path).add(target);
        if (path !== paths[0] && target === paths[0]) {
          failures.push(`${relative(root, path)}: implementation imports its runtime facade ${specifier.text}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  const visiting = new Set(), visited = new Set();
  function visit(path) {
    if (visiting.has(path)) {
      failures.push(`${relative(root, path)}: circular runtime module dependency`);
      return;
    }
    if (visited.has(path)) return;
    visiting.add(path);
    for (const target of graph.get(path)) visit(target);
    visiting.delete(path); visited.add(path);
  }
  paths.forEach(visit);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode=1; }
else console.log('Engineering, source, viewer and runtime module boundaries passed.');
