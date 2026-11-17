import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {workspaceTemp} from './test-workspace.mjs';
const temp=workspaceTemp();
const child=spawnSync(process.execPath,[fileURLToPath(new URL('../node_modules/eslint/bin/eslint.js',import.meta.url)),
 'desktop/src','desktop/bridge','packages/gim-sdk/src'],{cwd:fileURLToPath(new URL('../..',import.meta.url)),stdio:'inherit',windowsHide:true,
 env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp}});
if(child.error)throw child.error;process.exitCode=child.status??1;
