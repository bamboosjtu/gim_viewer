import ts from 'typescript';
export function nativeContractCallErrors(source,path) {
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true),errors=[];
  function visit(node) {
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['invokeTimed','invokeCommand','invoke'].includes(node.expression.text)) {
      const command=node.arguments[0];
      if(command&&ts.isStringLiteral(command)&&(!command.text.startsWith('plugin:')||command.text.startsWith('plugin:gim-import|')))
        errors.push(`${path}: native command names must come from generated v1 constants: ${command.text}`);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);return errors;
}
