import {build} from 'esbuild';
import {verifyCapabilities} from './verify-capabilities.mjs';
import {readdirSync,readFileSync,mkdirSync,rmSync,copyFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve,relative,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)),src=join(root,'src'),out=resolve(root,'dist');
function* files(dir){for(const item of readdirSync(dir,{withFileTypes:true})){if(item.name==='__tests__')continue;const path=join(dir,item.name);if(item.isDirectory())yield* files(path);else yield path;}}
// Only the package's own generated output may be replaced.
if(relative(root,out)!=='dist')throw Error('Invalid SDK output directory');
rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
const capabilities=await verifyCapabilities();
const inputs=[...files(src)];
await build({absWorkingDir:root,entryPoints:inputs.filter(p=>p.endsWith('.ts')),outbase:src,outdir:out,
  bundle:true,splitting:true,format:'esm',platform:'neutral',target:'es2022',
  chunkNames:'chunks/[name]-[hash]',logLevel:'warning',metafile:true}).then(result=>{
  const external=Object.values(result.metafile.outputs).flatMap(row=>row.imports.filter(item=>item.external));
  if(external.length)throw Error('SDK build has runtime external dependencies: '+JSON.stringify(external));
  writeFileSync(join(out,'build-manifest.json'),JSON.stringify({contract:'gim-sdk-build-v1',version:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,entryCount:inputs.filter(p=>p.endsWith('.ts')).length,runtimeExternals:external,capabilities},null,2)+'\n');
});
for(const input of inputs.filter(p=>p.endsWith('.json'))){const target=join(out,relative(src,input));mkdirSync(dirname(target),{recursive:true});copyFileSync(input,target);}
console.log('Built standalone GIM SDK (no runtime external dependencies).');
