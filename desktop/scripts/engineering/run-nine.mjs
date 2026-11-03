import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {engineeringFingerprint} from './fingerprint.mjs';

const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
process.chdir(desktop);
const types=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.engineering.json'],{stdio:'inherit',windowsHide:true});
if(types.status!==0)process.exit(types.status??1);
const corpus=JSON.parse(readFileSync('acceptance/engineering/corpus.json','utf8'));
const output=resolve('../output/engineering-stage3');mkdirSync(output,{recursive:true});
const candidates=process.argv.includes('--candidates');
const selected=process.argv.find(a=>a.startsWith('--samples='))?.slice(10).split(',')??corpus.samples.map(s=>s.id);
const fingerprint=engineeringFingerprint(desktop);
writeFileSync(resolve(output,'fingerprint.json'),JSON.stringify(fingerprint,null,2));
let failed=false;const results=[];
for(const sample of selected){
  if(!corpus.samples.some(s=>s.id===sample))throw Error(`Unknown sample ${sample}`);
  console.log(`${sample}: ${candidates?'candidate snapshot':'strict golden comparison'}`);
  const child=spawnSync(process.execPath,['--max-old-space-size=6144','node_modules/vite-node/vite-node.mjs','scripts/engineering/corpus-task.ts'],{
    stdio:'inherit',windowsHide:true,env:{...process.env,GIM_CORPUS_SAMPLE:sample,GIM_GOLDEN_MODE:candidates?'candidate':'verify'},
  });
  if(child.status!==0){failed=true;console.error(`${sample}: failed (${child.status})`);results.push({sample,passed:false,exitCode:child.status});}
  else {const result=resolve(output,`${sample}-result.json`);if(existsSync(result))results.push(JSON.parse(readFileSync(result,'utf8')));}
}
writeFileSync(resolve(output,'nine-projects.json'),JSON.stringify({complete:!failed&&results.length===9,mode:candidates?'candidate':'verify',fingerprint,results},null,2));
if(failed)process.exitCode=1;
