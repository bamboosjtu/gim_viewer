import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {generateNativeContract, renderNativeContract} from './generate-native.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const schema=JSON.parse(readFileSync(resolve(root,'contracts/native-v1.json'),'utf8'));
const fixtures=JSON.parse(readFileSync(resolve(root,'contracts/native-v1.fixtures.json'),'utf8'));

test('committed TS/Rust output exactly matches the single v1 source',()=>{
  generateNativeContract({check:true});
  assert.throws(()=>renderNativeContract({...schema,version:'v2'}),/remain v1/);
});
test('check mode rejects drift without rewriting files',()=>{
  const parent=resolve(root,'tmp/tests/native-contracts');mkdirSync(parent,{recursive:true});
  const work=mkdtempSync(resolve(parent,'drift-'));
  mkdirSync(resolve(work,'contracts'),{recursive:true});writeFileSync(resolve(work,'contracts/native-v1.json'),JSON.stringify(schema));
  generateNativeContract({workspace:work});
  const output=resolve(work,'packages/contracts-native/src/generated/nativeContracts.ts');
  writeFileSync(output,readFileSync(output,'utf8')+'// drift\n');
  assert.throws(()=>generateNativeContract({workspace:work,check:true}),/stale/);
  assert.match(readFileSync(output,'utf8'),/drift/);
});
test('bridge and parser consumers do not redeclare the generated DTOs',()=>{
  const require=createRequire(resolve(root,'desktop/package.json')),ts=require('typescript');
  const names=new Set(Object.keys(fixtures.types));
  for(const file of ['desktop/bridge/database.ts','packages/powerline-core/src/attributeRecords.ts']){
    const source=ts.createSourceFile(file,readFileSync(resolve(root,file),'utf8'),ts.ScriptTarget.Latest,true);
    for(const statement of source.statements){
      if(ts.isInterfaceDeclaration(statement)||ts.isTypeAliasDeclaration(statement))assert.ok(!names.has(statement.name.text),`${file} redeclares ${statement.name.text}`);
    }
  }
});
test('the shared Rust fixtures satisfy generated TS types, including required nullable fields',()=>{
  const require=createRequire(resolve(root,'desktop/package.json')),ts=require('typescript');
  const parent=resolve(root,'tmp/tests/native-contracts');mkdirSync(parent,{recursive:true});
  const work=mkdtempSync(resolve(parent,'typescript-'));
  writeFileSync(resolve(work,'nativeContracts.ts'),renderNativeContract(schema).ts);
  let source=`import type {${Object.keys(fixtures.types).join(', ')}, NativeError} from './nativeContracts.js';\n`;
  for(const [type,value] of Object.entries(fixtures.types))source+=`const fixture${type}: ${type} = ${JSON.stringify(value)};\n`;
  source+=`const errors: NativeError[] = ${JSON.stringify(fixtures.errors)};\n`;
  const file=resolve(work,'fixtures.ts');writeFileSync(file,source);
  const options={strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,types:[]};
  const compile=()=>ts.getPreEmitDiagnostics(ts.createProgram([file],options));
  assert.deepEqual(compile().map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
  const invalid={...fixtures.types.DevPropertyPayload};delete invalid.prop_value;
  writeFileSync(file,source+`\nconst missing: DevPropertyPayload = ${JSON.stringify(invalid)};`);
  assert.ok(compile().some(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n').includes('prop_value')));
});
