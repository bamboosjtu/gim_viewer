import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';

export function engineeringFingerprint(desktop=process.cwd()){
// Runtime imports only: unrelated UI/Rust/line changes do not age this oracle.
const inputs=new Set();
function dependency(path){
  if(inputs.has(path))return;inputs.add(path);
  if(!path.endsWith('.ts'))return;
  const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
  for(const node of source.statements){
    if(!ts.isImportDeclaration(node)||node.importClause?.isTypeOnly||!ts.isStringLiteral(node.moduleSpecifier)||!node.moduleSpecifier.text.startsWith('.'))continue;
    const raw=resolve(dirname(path),node.moduleSpecifier.text),file=raw.endsWith('.js')?raw.slice(0,-3)+'.ts':raw;
    if(existsSync(file))dependency(file);
  }
}
for(const entry of ['gim/engineering/sourceGraph.ts','gim/ifcSpatialParser.ts','gim/engineering/buildSources.ts','gim/engineering/navigation.ts','gim/engineering/geometryOccurrences.ts','engineering/representations.ts'])dependency(resolve(desktop,'src',entry));
const digest=createHash('sha256');
for(const file of [...inputs].sort())digest.update(relative(desktop,file).replaceAll('\\','/')).update(readFileSync(file));
return {implementationSha256:digest.digest('hex'),inputs:[...inputs].map(f=>relative(desktop,f).replaceAll('\\','/')).sort()};
}
