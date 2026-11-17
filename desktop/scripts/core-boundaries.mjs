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
      const target=name.startsWith('.')?posix.normalize(posix.join(posix.dirname(path),name)):name;
      const classifier=/(?:^|\/)(?:classify|normalize|semantic|sourceEvidence|objectEvidence)\.js$/.test(target);
      const typeOnly=node.isTypeOnly||node.importClause?.isTypeOnly;
      if(projection&&classifier&&!typeOnly)errors.push(`${path}: projection cannot classify source objects (${name})`);
      if(geometry&&/^engineering\//.test(target)&&!node.importClause?.isTypeOnly)
        errors.push(`${path}: geometry cannot consume semantic ownership (${name})`);
      if(fusion&&classifier&&!typeOnly)errors.push(`${path}: fusion cannot reclassify semantic objects (${name})`);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  return errors;
}
