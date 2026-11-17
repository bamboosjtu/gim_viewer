import ts from 'typescript';
import {posix} from 'node:path';

/** Capability rules supplement directory ownership during incremental extraction. */
export function coreBoundaryErrors(source, path) {
  const errors=[];
  const projection=/^gim\/engineering\/(?:projection|navigation|inventory|sourceProjection)\.ts$/.test(path);
  const geometry=/^gim\/engineering\/(?:geometry|physicalOccurrences|geometryOccurrences)\.ts$/.test(path);
  const fusion=path==='engineering/fusion.ts'||path==='engineering/representations.ts';
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
  function visit(node) {
    const specifier=ts.isImportDeclaration(node)||ts.isExportDeclaration(node)?node.moduleSpecifier
      :ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword?node.arguments[0]:undefined;
    if(specifier&&ts.isStringLiteral(specifier)) {
      const name=specifier.text;
      const sdk=name==='@gim/gim-sdk'||name.startsWith('@gim/gim-sdk/');
      const suffix=sdk?name.slice('@gim/gim-sdk/'.length):'';
      const capabilities={source:'gim/engineering/source.js',semantic:'engineering/semantic.js',geometry:'gim/engineering/geometry.js',engineering:'engineering/fusion.js',projection:'gim/engineering/projection.js','source-adapter':'gim/engineering/semanticAdapter.js'};
      const target=sdk?(capabilities[suffix]??suffix):name.startsWith('.')?posix.normalize(posix.join(posix.dirname(path),name)):name;
      if(path==='shared/representationAddresses.ts'&&/^(?:engineering|gim|app|services|viewer|ui|@desktop|@tauri-apps|three|web-ifc)/.test(target))
        errors.push(`${path}: address index cannot depend on semantic or host state (${name})`);
      const classifier=/(?:^|\/)(?:classify|normalize|semantic|semanticAdapter|sourceEvidence|objectEvidence)\.js$/.test(target);
      const bindings=node.importClause?.namedBindings;
      const typeOnly=node.isTypeOnly||node.importClause?.isTypeOnly
        ||bindings&&ts.isNamedImports(bindings)&&!node.importClause.name&&bindings.elements.length>0&&bindings.elements.every(item=>item.isTypeOnly);
      if(sdk&&!typeOnly){
        if(/^(?:ui|viewer)\//.test(path))errors.push(`${path}: SDK runtime belongs behind service ports (${name})`);
        if(path.startsWith('engineering/')&&!/^(?:engineering|shared)\//.test(target))errors.push(`${path}: domain facade cannot import format capabilities (${name})`);
        if(name==='@gim/gim-sdk'&&(projection||geometry||fusion))errors.push(`${path}: consume a specific core capability (${name})`);
      }
      if(projection&&!typeOnly&&target==='gim/engineering/source.js')errors.push(`${path}: projection cannot invoke source extraction (${name})`);
      if(projection&&!typeOnly&&target.endsWith('/sourceGraph.js')){
        const names=bindings&&ts.isNamedImports(bindings)?bindings.elements.filter(item=>!item.isTypeOnly).map(item=>(item.propertyName??item.name).text):null;
        if(!names||names.some(value=>value!=='engineeringSourceRecords'))errors.push(`${path}: projection may only consume source-record selectors (${name})`);
      }
      if(projection&&classifier&&!typeOnly)errors.push(`${path}: projection cannot classify source objects (${name})`);
      if(geometry&&/^engineering\//.test(target)&&!typeOnly)
        errors.push(`${path}: geometry cannot consume semantic ownership (${name})`);
      if(fusion&&classifier&&!typeOnly)errors.push(`${path}: fusion cannot reclassify semantic objects (${name})`);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  return errors;
}
