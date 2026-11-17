import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)),temp=resolve(root,'../../tmp/gim-sdk-tests');
mkdirSync(temp,{recursive:true});
const child=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...process.argv.slice(2)],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp}});
if(child.error)throw child.error;process.exitCode=child.status??1;
