import ts from 'typescript';

/** Services depend on intent ports; generic UI module loaders are forbidden. */
export function checkPresentationSource(source,path) {
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true),failures=[];
  const loaders=new Set(['loadPresentation']);
  for(const node of ast.statements)if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text.endsWith('/presentationPort.js')) {
    const bindings=node.importClause?.namedBindings;
    if(bindings&&ts.isNamedImports(bindings))for(const item of bindings.elements)if((item.propertyName??item.name).text==='loadPresentation')loaders.add(item.name.text);
  }
  function visit(node) {
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment) {
      const target=node.left;
      if(ts.isPropertyAccessExpression(target)&&(['innerHTML','outerHTML','textContent','className'].includes(target.name.text)
        ||ts.isPropertyAccessExpression(target.expression)&&target.expression.name.text==='style'))
        failures.push(`${path}: services cannot mutate DOM presentation properties`);
    }
    if(ts.isCallExpression(node)) {
      const fn=node.expression;
      if((ts.isIdentifier(fn)&&loaders.has(fn.text))||(ts.isPropertyAccessExpression(fn)&&fn.name.text==='loadPresentation')) {
        failures.push(`${path}: generic presentation module loaders are forbidden`);
      }
      if(ts.isPropertyAccessExpression(fn)&&ts.isIdentifier(fn.expression)&&fn.expression.text==='document')
        failures.push(`${path}: services cannot operate document DOM; use a presentation command`);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  return failures;
}
