import {existsSync,readdirSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

// Use the invoking application's Vitest/config, including its integration exclusions.
const root=process.cwd(),modules=process.argv.slice(2);
if(!modules.length){console.error('Usage: npm run test:module -- <module directory or source file> [...]');process.exit(1);}
const files=new Set();
function collect(path){
  if(statSync(path).isDirectory()){
    for(const entry of readdirSync(path,{withFileTypes:true})){
      if(['node_modules','dist','target','__pycache__','.git','.venv','_build','tmp','output','demo'].includes(entry.name))continue;
      collect(join(path,entry.name));
    }
  }else if(/\.(?:[cm]?[jt]sx?|json)$/.test(path))files.add(path);
}
for(const module of modules){
  const path=existsSync(resolve(root,module))?resolve(root,module):resolve(root,'src',module);
  if(!existsSync(path))throw Error('Module does not exist: '+module);
  collect(path);
}
if(!files.size)throw Error('No JavaScript/TypeScript sources or owned tests in the selected modules');
const require=createRequire(resolve(root,'package.json'));
const {startVitest}=await import(pathToFileURL(require.resolve('vitest/node')).href);
// Owned tests select themselves; source dependencies also select consumers in other modules.
await startVitest('test',[],{run:true,related:[...files]});
