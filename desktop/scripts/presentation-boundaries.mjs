import ts from 'typescript';

export function checkPresentationRegistry(source,registered) {
  const ast=ts.createSourceFile('presentationPort.ts',source,ts.ScriptTarget.Latest,true);
  const declaration=ast.statements.find(node=>ts.isInterfaceDeclaration(node)&&node.name.text==='PresentationModules');
  const actual=new Set(declaration?.members.map(node=>node.name?.text)??[]);
  return [...new Set([...actual,...registered])].filter(key=>actual.has(key)!==registered.has(key))
    .map(key=>`presentationPort.ts: unregistered or unused legacy loader key ${key}`);
}

/** Legacy imports have an explicit shrinking budget. New flows use intent ports. */
export function checkPresentationSource(source,path,budget={}) {
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true),failures=[],counts={};
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
        const key=node.arguments[0];
        if(!key||!ts.isStringLiteral(key))failures.push(`${path}: presentation loader key must be a registered literal`);
        else counts[key.text]=(counts[key.text]??0)+1;
      }
      if(ts.isPropertyAccessExpression(fn)&&ts.isIdentifier(fn.expression)&&fn.expression.text==='document')
        failures.push(`${path}: services cannot operate document DOM; use a presentation command`);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  for(const [key,count] of Object.entries(counts))if(count>(budget[key]??0))failures.push(`${path}: legacy presentation ${key} grew to ${count}; budget ${budget[key]??0}`);
  return failures;
}
