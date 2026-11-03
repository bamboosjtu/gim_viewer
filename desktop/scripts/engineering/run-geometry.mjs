import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const corpus=JSON.parse(readFileSync('acceptance/engineering/corpus.json','utf8'));
for(const sample of corpus.samples){
 const result=spawnSync(process.execPath,['node_modules/vite-node/vite-node.mjs','scripts/engineering/geometry-task.ts'],{stdio:'inherit',windowsHide:true,env:{...process.env,GIM_CORPUS_SAMPLE:sample.id}});
 if(result.status!==0){process.exitCode=1;break;}
}
