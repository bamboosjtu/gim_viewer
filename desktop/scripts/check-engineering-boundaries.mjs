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
for (const layer of ['engineering','gim','viewer']) for (const path of files(resolve(root,layer))) {
  const ast = ts.createSourceFile(path, readFileSync(path,'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteral(specifier)) {
      const name = specifier.text;
      const target = name.startsWith('.') ? relative(root,resolve(dirname(path),name)).replaceAll('\\','/').split('/')[0] : name;
      const banned = layer === 'engineering' ? /^(?:app|gim|viewer|ui|services|@desktop|@tauri-apps|three|web-ifc|maplibre)/
        : layer === 'gim' ? /^(?:app|services|viewer|ui|@desktop|@tauri-apps)/ : /^(?:services|ui|@desktop|@tauri-apps)/;
      const exception = viewerBridgeImports.has(`${relative(root,path).replaceAll('\\','/')}:${name}`);
      if (banned.test(target) && !exception) failures.push(`${relative(root,path)}: forbidden import ${name}`);
    }
    if (layer === 'viewer' && ts.isPropertyAccessExpression(node) && /^engineering(?:Selection|Snapshot|Sources|Navigation)$/.test(node.name.text)) {
      failures.push(`${relative(root,path)}: renderer reads ${node.name.text}`);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode=1; }
else console.log('Engineering, source and viewer boundaries passed.');
