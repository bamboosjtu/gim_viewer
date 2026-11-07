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
// Views may use explicit presentation selectors/formatters, never parsers or business classifiers.
const uiPresentationValues = new Map([
  ['engineering/catalogLabels.ts',new Set(['categoryLabel','classificationReasonLabel'])],
  ['gim/modelIdentity.ts',new Set(['resolveIfcModelId','findIfcEntryByModelId','normalizeEntryPath','normalizedIfcBasename'])],
  ['gim/linePathNormalize.ts',new Set(['getFileNameLower','normalizeGimPath'])],
  ['gim/gimValueSemantics.ts',new Set(['isGimEmptyValue'])],
  ['gim/geometry/geometryDiagnostics.ts',new Set(['getGeometryDiagnostic','geometryReasonLabel','geometryStatusLabel'])],
  ['shared/gimParsing.ts',new Set(['getFirstNonEmptyKv','isGimEmptyValue'])],
]);
for (const layer of ['engineering','gim','viewer','ui','services','app']) for (const path of files(resolve(root,layer))) {
  const ast = ts.createSourceFile(path, readFileSync(path,'utf8'), ts.ScriptTarget.Latest, true);
  const localPath = relative(root, path).replaceAll('\\', '/');
  const resolverFactories = new Set(['createEntryResolver']);
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.endsWith('/entryResolver.js')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if ((binding.propertyName ?? binding.name).text === 'createEntryResolver') resolverFactories.add(binding.name.text);
    }
  }
  function visit(node) {
    if (localPath !== 'gim/entryResolver.ts' && ts.isCallExpression(node)
      && (ts.isIdentifier(node.expression) ? resolverFactories.has(node.expression.text)
        : ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createEntryResolver')) {
      let enumeratesKeys = false;
      const inspect = child => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
          && child.expression.name.text === 'keys') enumeratesKeys = true;
        ts.forEachChild(child, inspect);
      };
      node.arguments.forEach(inspect);
      if (enumeratesKeys) failures.push(`${localPath}: full archive index bypasses reuse; use getFileEntryResolver(files) instead of createEntryResolver(files.keys())`);
    }
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteral(specifier)) {
      const name = specifier.text;
      const target = name.startsWith('.') ? relative(root,resolve(dirname(path),name)).replaceAll('\\','/').split('/')[0] : name;
      if(layer==='ui' && name.startsWith('.')) {
        const module=relative(root,resolve(dirname(path),name.replace(/\.js$/,'.ts'))).replaceAll('\\','/');
        if(/^(?:engineering|gim|viewer)\//.test(module)||module==='shared/gimParsing.ts') {
          const clause=ts.isImportDeclaration(node)?node.importClause:undefined;
          const bindings=clause?.namedBindings;
          const names=bindings&&ts.isNamedImports(bindings)?bindings.elements.filter(item=>!item.isTypeOnly).map(item=>(item.propertyName??item.name).text):null;
          if(!node.isTypeOnly && !clause?.isTypeOnly && (!names||names.some(value=>!uiPresentationValues.get(module)?.has(value))))
            failures.push(`${localPath}: UI must consume service projections; forbidden value import ${name}`);
        }
      }

      const banned = layer === 'engineering' ? /^(?:app|gim|viewer|ui|services|@desktop|@tauri-apps|three|web-ifc|maplibre)/
        : layer === 'gim' ? /^(?:app|services|viewer|ui|@desktop|@tauri-apps)/ : layer==='ui'?/^(?:@desktop|@tauri-apps)/:layer==='services'?/^(?:ui)/:layer==='app'?/^(?:gim)/:/^(?:app|services|ui|@desktop|@tauri-apps)/;
      const exception = viewerBridgeImports.has(`${relative(root,path).replaceAll('\\','/')}:${name}`);
      if (banned.test(target) && !exception && !((layer==='services'||layer==='app') && ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)) failures.push(`${relative(root,path)}: forbidden import ${name}`);
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

// Whole-source static value graph. Dynamic and type dependencies are counted,
// but cannot create an eager module-initialization cycle by themselves.
const all=[...files(root)], graph=new Map(all.map(path=>[path,new Set()]));
let typeEdges=0,dynamicEdges=0;
for(const path of all){
 const ast=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
 const scan=node=>{
  const dynamic=ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword;
  const declaration=ts.isImportDeclaration(node)||ts.isExportDeclaration(node);
  const specifier=declaration?node.moduleSpecifier:dynamic?node.arguments[0]:undefined;
  if(specifier&&ts.isStringLiteral(specifier)&&specifier.text.startsWith('.')){
   const target=resolve(dirname(path),specifier.text.replace(/\.js$/,'.ts'));
   const clause=ts.isImportDeclaration(node)?node.importClause:undefined;
   const typeOnly=node.isTypeOnly||clause?.isTypeOnly||
     (clause&&!clause.name&&clause.namedBindings&&ts.isNamedImports(clause.namedBindings)&&clause.namedBindings.elements.every(item=>item.isTypeOnly));
   if(dynamic)dynamicEdges++;else if(typeOnly)typeEdges++;else if(graph.has(target))graph.get(path).add(target);
  }
  ts.forEachChild(node,scan);
 };scan(ast);
}
const visiting=new Set(),visited=new Set();
function checkCycle(path,trail=[]){
 if(visiting.has(path)){failures.push(`Static value cycle: ${[...trail,path].map(p=>relative(root,p)).join(' -> ')}`);return;}
 if(visited.has(path))return;visiting.add(path);
 for(const target of graph.get(path))checkCycle(target,[...trail,path]);
 visiting.delete(path);visited.add(path);
}
all.forEach(path=>checkCycle(path));
console.log(`Dependency graph: ${all.length} modules, ${typeEdges} type edges, ${dynamicEdges} dynamic edges`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode=1; }
else console.log('Engineering, source, viewer and runtime module boundaries passed.');
