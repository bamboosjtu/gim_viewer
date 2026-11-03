import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.separation.config.ts'],{
  stdio:'inherit',windowsHide:true,env:{...process.env,GIM_ENGINEERING_OUTPUT:'../output/v020-stage2'},
});
if(result.error)throw result.error;process.exitCode=result.status??1;
